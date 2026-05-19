/**
 * workflow-engine.ts — 工作流编排引擎
 *
 * 职责：
 *   1. runWorkflow() — 主入口，编排多步骤工作流
 *   2. 支持 值守/全自动/完全值守 三种模式
 *   3. 支持 {} loop 组（worker→reviewer, trimmer→reviewer）
 *   4. 支持 [] 标记的确认步骤
 *   5. Checkpoint 保存/恢复（断点续传）
 *   6. 超时处理（按 mode 策略分支）
 *   7. 进度面板 UI
 *
 * 被 dev-prompts.ts 引入，不独立作为 extension 加载。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { spawnSubagent, extractFinalOutput, discoverAgents, type AgentDef, type SubagentResult } from "./sub-agents";

// ═══════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════

export type WorkflowMode = "attended" | "full-auto" | "full-attended";

export interface WorkflowStepDef {
	id: string;
	label: string;
	/** 'auto' = 自动执行, 'confirm' = 需要用户确认 ([]), 'loop-group' = {} 循环组 */
	type: "auto" | "confirm" | "loop-group";
	/** 单步骤 agent 名（auto / confirm 类型） */
	agentName?: string;
	/** loop 组的实施 agent 名（worker / trimmer） */
	loopAgentName?: string;
	/** loop 组的审查 agent 名（reviewer） */
	reviewAgentName?: string;
	/** loop 最大次数（默认 3） */
	maxLoops?: number;
	/** 超时毫秒 */
	timeoutMs: number;
}

interface WorkflowStepState {
	status: "pending" | "running" | "done" | "failed" | "skipped";
	durationMs?: number;
	loopCount?: number;
	error?: string;
}

interface CheckpointData {
	version: 1;
	createdAt: string;
	updatedAt: string;
	prompt: string;
	mode: WorkflowMode;
	steps: WorkflowStepState[];
	currentStepIndex: number;
	loopCounts: Record<string, number>;
	planFilePath?: string;
}

// ═══════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════

const DEV_OUTPUT_DIR = "pi-dev-output";
const CHECKPOINT_FILE = path.join(DEV_OUTPUT_DIR, "pi-workflow", "checkpoint.json");
const PLANS_DIR = path.join(DEV_OUTPUT_DIR, "pi-plans");

// ═══════════════════════════════════════════════════════════════
//  Utility Helpers
// ═══════════════════════════════════════════════════════════════

function ensureOutputDir(cwd: string, subdir: string): string {
	const dir = path.join(cwd, DEV_OUTPUT_DIR, subdir);
	fs.mkdirSync(dir, { recursive: true });
	const gitignorePath = path.join(cwd, DEV_OUTPUT_DIR, ".gitignore");
	try {
		const existing = fs.readFileSync(gitignorePath, "utf-8").trim();
		if (!existing.includes("*")) {
			fs.writeFileSync(gitignorePath, "*\n!.gitignore\n");
		}
	} catch {
		fs.writeFileSync(gitignorePath, "*\n!.gitignore\n");
	}
	return dir;
}

/** 返回 pi-plans/ 下最新的 .md 文件（相对路径），不存在时返回 undefined。 */
function findLatestPlanFile(cwd: string): string | undefined {
	const dir = path.join(cwd, PLANS_DIR);
	try {
		if (!fs.existsSync(dir)) return undefined;
		const files = fs.readdirSync(dir)
			.filter(f => f.endsWith(".md"))
			.map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		return files.length > 0 ? path.join(PLANS_DIR, files[0].name) : undefined;
	} catch {
		return undefined;
	}
}

function readFileContent(cwd: string, relativePath: string): string | undefined {
	try {
		return fs.readFileSync(path.join(cwd, relativePath), "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * 从 reviewer agent 的输出中解析 [REVIEW_SUMMARY] JSON 块。
 * 也支持兜底搜索裸 JSON。
 */
export function parseReviewerOutput(
	output: string,
): { maxSeverity: string; critical: number; medium: number; low: number } | null {
	const match = output.match(/\[REVIEW_SUMMARY\]\s*(\{[\s\S]*?\})\s*\[\/REVIEW_SUMMARY\]/);
	if (match) {
		try {
			const parsed = JSON.parse(match[1]);
			if (parsed && typeof parsed.maxSeverity === "string") return parsed;
		} catch { /* fallthrough */ }
	}
	// fallback: 找 maxSeverity 键的 JSON
	const fallback = output.match(/\{"maxSeverity":\s*"(critical|medium|low)"[\s\S]*?\}/);
	if (fallback) {
		try {
			const parsed = JSON.parse(fallback[0]);
			if (parsed && typeof parsed.maxSeverity === "string") return parsed;
		} catch { /* fallthrough */ }
	}
	return null;
}

export function isTimeoutResult(r: SubagentResult): boolean {
	return r.exitCode === -1 && r.stderr.includes("timed out");
}

// ═══════════════════════════════════════════════════════════════
//  Checkpoint
// ═══════════════════════════════════════════════════════════════

function saveCheckpoint(cwd: string, data: CheckpointData): void {
	ensureOutputDir(cwd, "pi-workflow");
	data.updatedAt = new Date().toISOString();
	fs.writeFileSync(path.join(cwd, CHECKPOINT_FILE), JSON.stringify(data, null, 2), "utf-8");
}

export function loadCheckpointFromFile(cwd: string): CheckpointData | null {
	try {
		const content = fs.readFileSync(path.join(cwd, CHECKPOINT_FILE), "utf-8");
		return JSON.parse(content) as CheckpointData;
	} catch {
		return null;
	}
}

export function deleteCheckpointFile(cwd: string): void {
	try { fs.unlinkSync(path.join(cwd, CHECKPOINT_FILE)); } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════
//  Progress display
// ═══════════════════════════════════════════════════════════════

function showProgress(
	ctx: ExtensionCommandContext,
	steps: WorkflowStepDef[],
	stepStates: WorkflowStepState[],
	currentIdx: number,
): void {
	const lines: string[] = ["📋 工作流进度"];
	for (let i = 0; i < steps.length; i++) {
		const s = steps[i];
		const st = stepStates[i] ?? { status: "pending" };
		const icon =
			st.status === "done" ? "✅" :
			st.status === "running" ? "⏳" :
			st.status === "failed" ? "❌" :
			st.status === "skipped" ? "⏭️" : "⬜";
		const dur = st.durationMs != null ? ` (${(st.durationMs / 1000).toFixed(1)}s)` : "";
		const loop = st.loopCount && st.loopCount > 0 ? ` x${st.loopCount}` : "";
		const arrow = i === currentIdx ? " ▶" : "  ";
		lines.push(`${arrow} ${icon} ${s.label}${dur}${loop}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

// ═══════════════════════════════════════════════════════════════
//  Agent runner with progress
// ═══════════════════════════════════════════════════════════════

async function runAgentWithProgress(
	ctx: ExtensionCommandContext,
	agent: AgentDef,
	task: string,
	stepLabel: string,
	stepStartTime: number,
	timeoutMs: number,
): Promise<SubagentResult> {
	return ctx.ui.custom<SubagentResult>((tui, theme, _kb, done) => {
		const loaderLabel = `🤖 ${agent.name}: ${stepLabel}`;
		const loader = new BorderedLoader(tui, theme, loaderLabel);
		loader.onAbort = () =>
			done({ exitCode: -1, output: "", stderr: "用户取消", durationMs: 0 });

		spawnSubagent(agent, task, ctx.cwd, loader.signal, timeoutMs, (progress) => {
			try {
				const inner = (loader as unknown as { loader?: { setText?: (t: string) => void } }).loader;
				if (inner?.setText) {
					const elapsed = ((Date.now() - stepStartTime) / 1000).toFixed(1);
					inner.setText(`🤖 ${agent.name} (${elapsed}s) ${progress.slice(0, 50)}`);
				}
			} catch { /* ignore update errors */ }
		})
			.then((r) => done(r))
			.catch((err) =>
				done({ exitCode: 1, output: "", stderr: String(err), durationMs: 0 }),
			);

		return loader;
	});
}

// ═══════════════════════════════════════════════════════════════
//  Task builders
// ═══════════════════════════════════════════════════════════════

function buildTaskForStep(
	agentName: string,
	prompt: string,
	planFileRelPath: string | undefined,
	cwd: string,
): string {
	if (agentName === "planner") {
		return [
			"请根据以下功能需求，分析代码库结构，生成详细的实施计划，并写入 pi-dev-output/pi-plans/ 目录。",
			"",
			"## 功能需求",
			prompt,
		].join("\n");
	}

	if (agentName === "worker") {
		const planContent = planFileRelPath ? readFileContent(cwd, planFileRelPath) : undefined;
		if (planContent) {
			return [
				"请根据以下实施计划逐步实现代码改动。",
				"",
				"## 实施计划",
				planContent,
				"",
				"请严格按照计划中的步骤实施，不要做计划外的修改。",
			].join("\n");
		}
		return [
			"请根据以下功能需求实施代码改动。",
			"",
			"## 功能需求",
			prompt,
			"",
			"请先分析代码库，制定简要计划，再逐步实施。",
		].join("\n");
	}

	if (agentName === "trimmer") {
		return [
			"请精简当前代码库的代码。",
			"缩短不必要的冗长行，优化可读性，消除可合并的重复逻辑。",
			"",
			"## 原始功能需求",
			prompt,
		].join("\n");
	}

	if (agentName === "docWriter") {
		const planContent = planFileRelPath
			? `\n\n## 实施计划\n${readFileContent(cwd, planFileRelPath) ?? ""}`
			: "";
		return [
			"请根据当前代码状态，更新 README.md 文档，必要时添加关键代码注释。",
			"",
			"## 功能需求",
			prompt,
			planContent,
		].join("\n");
	}

	return prompt;
}

function buildReviewTask(
	prompt: string,
	planFileRelPath: string | undefined,
	cwd: string,
): string {
	const planContent = planFileRelPath ? readFileContent(cwd, planFileRelPath) : undefined;
	const parts = [
		"请审查当前代码库中针对以下功能的实现。",
		"检查是否有 bug、逻辑错误、未完成的功能、代码质量问题。",
		"将详细审查报告写入 pi-dev-output/pi-review/ 目录。",
		"在回复末尾输出以下格式的结构化摘要（必须包含）：",
		"[REVIEW_SUMMARY]",
		'{"maxSeverity":"critical|medium|low","critical":N,"medium":N,"low":N}',
		"[/REVIEW_SUMMARY]",
		"",
		"## 功能需求",
		prompt,
	];
	if (planContent) parts.push("", "## 实施计划", planContent);
	return parts.join("\n");
}

// ═══════════════════════════════════════════════════════════════
//  Single-step executor
// ═══════════════════════════════════════════════════════════════

async function executeSingleStep(
	ctx: ExtensionCommandContext,
	step: WorkflowStepDef,
	state: WorkflowStepState,
	agentMap: Map<string, AgentDef>,
	prompt: string,
	planFileRelPath: string | undefined,
	mode: WorkflowMode,
): Promise<void> {
	const agentName = step.agentName!;
	const agent = agentMap.get(agentName);
	if (!agent) throw new Error(`未找到 agent: ${agentName}`);

	const task = buildTaskForStep(agentName, prompt, planFileRelPath, ctx.cwd);
	const stepStartTime = Date.now();
	let retried = false;

	let result = await runAgentWithProgress(ctx, agent, task, step.label, stepStartTime, step.timeoutMs);

	// ── Timeout handling ──
	if (isTimeoutResult(result)) {
		if (mode === "full-auto" && !retried) {
			ctx.ui.notify(`⏰ ${step.label} 超时，自动重试...`, "warning");
			result = await runAgentWithProgress(
				ctx, agent,
				`[RETRY] 上次执行超时，请控制节奏避免再次超时。\n\n${task}`,
				step.label, stepStartTime, step.timeoutMs,
			);
			retried = true;
		} else {
			const choice = await ctx.ui.select(
				`⏰ ${step.label} 执行超时`,
				["1. 重新执行", "2. 跳过此步骤", "3. 取消工作流"],
			);
			if (!choice || choice.startsWith("3")) throw new Error("用户取消工作流");
			if (choice.startsWith("2")) { state.status = "skipped"; return; }
			result = await runAgentWithProgress(
				ctx, agent,
				`[RETRY] 上次执行超时，请控制节奏避免再次超时。\n\n${task}`,
				step.label, stepStartTime, step.timeoutMs,
			);
		}
	}

	if (isTimeoutResult(result)) {
		throw new Error(`执行超时 (${(step.timeoutMs / 1000).toFixed(0)}s)`);
	}

	if (result.exitCode !== 0 && result.stderr) {
		throw new Error(`Agent 错误 (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
	}

	// Extract output for any post-processing
	const finalOutput = extractFinalOutput(result.output);
	if (agentName === "planner" && !planFileRelPath) {
		// Planner 可能已写文件，后续步骤会自动查找
	}
	// For reviewer, no special handling needed in single step
}

// ═══════════════════════════════════════════════════════════════
//  Loop-group executor
// ═══════════════════════════════════════════════════════════════

async function executeLoopGroup(
	ctx: ExtensionCommandContext,
	step: WorkflowStepDef,
	state: WorkflowStepState,
	agentMap: Map<string, AgentDef>,
	prompt: string,
	planFileRelPath: string | undefined,
	mode: WorkflowMode,
	loopCounts: Record<string, number>,
): Promise<void> {
	const loopAgent = agentMap.get(step.loopAgentName!);
	const reviewAgent = agentMap.get(step.reviewAgentName!);
	if (!loopAgent) throw new Error(`未找到 loop agent: ${step.loopAgentName}`);
	if (!reviewAgent) throw new Error(`未找到 review agent: ${step.reviewAgentName}`);

	const maxLoops = step.maxLoops ?? 3;
	let loopCount = loopCounts[step.id] ?? 0;
	let contextPrompt = prompt;

	while (loopCount < maxLoops) {
		const loopStartTime = Date.now();
		const iterLabel =
			loopCount > 0 ? `${step.label} (第 ${loopCount + 1}/${maxLoops} 次)` : step.label;

		ctx.ui.notify(`🔄 ${iterLabel}: 执行 ${step.loopAgentName}...`, "info");

		// ── Run loop agent (worker / trimmer) ──
		const loopTask = buildTaskForStep(
			step.loopAgentName!,
			contextPrompt,
			planFileRelPath,
			ctx.cwd,
		);

		let agentResult = await runAgentWithProgress(
			ctx, loopAgent, loopTask,
			iterLabel, loopStartTime, step.timeoutMs,
		);

		// Timeout handling for loop agent
		if (isTimeoutResult(agentResult)) {
			if (mode === "full-auto") {
				ctx.ui.notify(
					`⏰ ${step.loopAgentName} 超时，自动进入审查阶段`,
					"warning",
				);
				// Prepare review task with timeout warning
				contextPrompt = `[TIMEOUT_WARNING] 上一个 ${step.loopAgentName} 执行超时，工作可能未完成。请重点检查是否存在不完整或未实现的代码。\n\n${buildReviewTask(prompt, planFileRelPath, ctx.cwd)}`;
			} else {
				const choice = await ctx.ui.select(
					`⏰ ${step.loopAgentName} 执行超时`,
					["1. 重新执行", "2. 进入审查阶段", "3. 跳过此步骤", "4. 取消工作流"],
				);
				if (!choice || choice.startsWith("4")) throw new Error("用户取消工作流");
				if (choice.startsWith("3")) { state.status = "skipped"; return; }
				if (choice.startsWith("2")) {
					contextPrompt = `[TIMEOUT_WARNING] 上一个 ${step.loopAgentName} 执行超时，工作可能未完成。请重点检查是否存在不完整或未实现的代码。\n\n${buildReviewTask(prompt, planFileRelPath, ctx.cwd)}`;
				} else {
					// Retry
					agentResult = await runAgentWithProgress(
						ctx, loopAgent,
						`[RETRY] 上次执行超时，请控制节奏避免再次超时。\n\n${loopTask}`,
						iterLabel, loopStartTime, step.timeoutMs,
					);
					if (isTimeoutResult(agentResult)) {
						ctx.ui.notify(`❌ ${step.loopAgentName} 重试仍然超时，跳过`, "error");
						contextPrompt = `[TIMEOUT_WARNING] 上一个 ${step.loopAgentName} 执行超时。\n\n${buildReviewTask(prompt, planFileRelPath, ctx.cwd)}`;
					}
				}
			}
		}

		// ── Run reviewer ──
		ctx.ui.notify(`🔍 ${iterLabel}: 运行审查...`, "info");

		const reviewTask = contextPrompt.includes("[TIMEOUT_WARNING]")
			? contextPrompt
			: buildReviewTask(contextPrompt, planFileRelPath, ctx.cwd);

		const reviewResult = await runAgentWithProgress(
			ctx, reviewAgent, reviewTask,
			`审查 ${step.loopAgentName}`, loopStartTime, step.timeoutMs,
		);

		const combinedOutput = reviewResult.output + "\n" + reviewResult.stderr;
		const reviewSummary = parseReviewerOutput(combinedOutput);

		const sev = reviewSummary?.maxSeverity ?? "low";
		ctx.ui.notify(
			`📊 审查: severity=${sev} (critical=${reviewSummary?.critical ?? 0}, medium=${reviewSummary?.medium ?? 0}, low=${reviewSummary?.low ?? 0})`,
			sev === "critical" ? "warning" : sev === "medium" ? "info" : "info",
		);

		loopCount++;

		// ── Decide whether to loop ──
		if (sev === "critical" && loopCount < maxLoops) {
			if (mode === "full-auto") {
				ctx.ui.notify(`🔄 自动循环 (${loopCount}/${maxLoops})`, "warning");
				contextPrompt = [
					prompt,
					"",
					"## 上次审查发现的问题",
					`审查摘要: ${JSON.stringify(reviewSummary)}`,
					"",
					`请修复这些 ${reviewSummary?.critical ?? 0} 个严重问题后重新运行。`,
				].join("\n");
				continue;
			} else {
				const shouldLoop = await ctx.ui.confirm(
					"🔄 检测到严重问题",
					`审查发现 ${reviewSummary?.critical ?? 0} 个严重问题。\n是否进入下一轮循环 (${loopCount}/${maxLoops})？`,
				);
				if (shouldLoop) {
					contextPrompt = [
						prompt,
						"",
						"## 上次审查发现的问题",
						`审查摘要: ${JSON.stringify(reviewSummary)}`,
						"",
						`请修复这些严重问题后重新运行。`,
					].join("\n");
					continue;
				}
				break;
			}
		}

		// Non-critical or max loops reached → break
		break;
	}

	state.loopCount = loopCount;
	loopCounts[step.id] = loopCount;
}

// ═══════════════════════════════════════════════════════════════
//  Main entry
// ═══════════════════════════════════════════════════════════════

export interface WorkflowConfig {
	steps: WorkflowStepDef[];
}

/**
 * 运行完整工作流。
 *
 * @param ctx   命令上下文
 * @param pi    Extension API
 * @param prompt  用户原始 prompt（已含 grill 评审记录）
 * @param config  工作流步骤配置
 */
export async function runWorkflow(
	ctx: ExtensionCommandContext,
	_pi: ExtensionAPI,
	prompt: string,
	config: WorkflowConfig,
): Promise<void> {
	const { steps } = config;

	// ── Load agents ──
	const agents = discoverAgents();
	const agentMap = new Map<string, AgentDef>();
	for (const a of agents) agentMap.set(a.name, a);

	// Validate required agents
	for (const step of steps) {
		const names: string[] = [];
		if (step.type === "auto" || step.type === "confirm") {
			if (step.agentName) names.push(step.agentName);
		}
		if (step.type === "loop-group") {
			if (step.loopAgentName) names.push(step.loopAgentName);
			if (step.reviewAgentName) names.push(step.reviewAgentName);
		}
		for (const n of names) {
			if (!agentMap.has(n)) {
				ctx.ui.notify(`❌ 未找到 agent "${n}"，请检查 agents/workflow/ 目录`, "error");
				return;
			}
		}
	}

	// ── State init / checkpoint recovery ──
	let mode: WorkflowMode = "attended";
	const stepStates: WorkflowStepState[] = steps.map(() => ({ status: "pending" }));
	let currentStepIndex = 0;
	let loopCounts: Record<string, number> = {};
	let planFileRelPath: string | undefined;
	let resumeFlow = false;

	const existingCp = loadCheckpointFromFile(ctx.cwd);
	if (existingCp) {
		const resume = await ctx.ui.confirm(
			"🔄 恢复工作流",
			`发现上次未完成的工作流（${existingCp.updatedAt}），是否继续？\n选择「否」将丢弃进度重新开始。`,
		);
		if (resume) {
			mode = existingCp.mode;
			Object.assign(stepStates, existingCp.steps);
			currentStepIndex = existingCp.currentStepIndex;
			loopCounts = existingCp.loopCounts;
			planFileRelPath = existingCp.planFilePath;
			resumeFlow = true;
			ctx.ui.notify(`🔄 已恢复，从步骤 ${currentStepIndex + 1}/${steps.length} 继续`, "info");
		} else {
			deleteCheckpointFile(ctx.cwd);
		}
	}

	if (!existingCp || !resumeFlow) {
		const modeChoice = await ctx.ui.select("🤖 选择工作流模式", [
			"1. 值守（默认）— 自动流程，[]步骤需确认，循环需许可",
			"2. 完全信任 — 全自动运行，无需任何确认",
			"3. 完全值守 — 每一步都需用户确认",
			"4. 取消工作流",
		]);
		if (!modeChoice || modeChoice.startsWith("4")) {
			ctx.ui.notify("❌ 工作流已取消", "warning");
			return;
		}
		mode = modeChoice.startsWith("2") ? "full-auto" :
		       modeChoice.startsWith("3") ? "full-attended" : "attended";

		// Save initial checkpoint
		saveCheckpoint(ctx.cwd, {
			version: 1,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			prompt,
			mode,
			steps: stepStates,
			currentStepIndex,
			loopCounts,
		});
	}

	ctx.ui.notify(
		`📋 工作流启动 — ${mode === "full-auto" ? "全自动模式" : mode === "full-attended" ? "完全值守模式" : "值守模式"}`,
		"info",
	);
	showProgress(ctx, steps, stepStates, currentStepIndex);

	// ═══════════════════════════════════════════════════════════
	//  Step loop
	// ═══════════════════════════════════════════════════════════

	for (; currentStepIndex < steps.length; currentStepIndex++) {
		const step = steps[currentStepIndex];
		const state = stepStates[currentStepIndex];

		// Skip already completed steps (resume)
		if (state.status === "done" || state.status === "skipped") continue;

		// ── Confirmation for [confirm] steps ──
		if (step.type === "confirm" && mode !== "full-auto") {
			const choice = await ctx.ui.select(`📌 ${step.label}`, [
				"1. 进入此步骤",
				"2. 自定义输入",
				"3. 跳过此步骤",
				"4. 取消工作流",
			]);
			if (!choice || choice.startsWith("4")) {
				ctx.ui.notify("❌ 工作流已取消", "warning");
				state.status = "skipped";
				saveCheckpoint(ctx.cwd, buildCp());
				return;
			}
			if (choice.startsWith("3")) {
				state.status = "skipped";
				saveCheckpoint(ctx.cwd, buildCp());
				ctx.ui.notify(`⏭️ 已跳过: ${step.label}`, "info");
				continue;
			}
			if (choice.startsWith("2")) {
				const customInput = await ctx.ui.input("✏️ 自定义输入", {
					placeholder: "输入你的指令或反馈，将注入步骤上下文",
				});
				if (customInput !== undefined && customInput.trim()) {
					prompt = `${prompt}\n\n## 用户自定义指令\n${customInput.trim()}`;
				}
			}
		}

		// ── Full-attended: confirm every auto step ──
		if (mode === "full-attended" && step.type !== "confirm") {
			const choice = await ctx.ui.select(`📌 ${step.label} — 执行？`, [
				"1. 执行",
				"2. 跳过",
				"3. 取消工作流",
			]);
			if (!choice || choice.startsWith("3")) {
				ctx.ui.notify("❌ 工作流已取消", "warning");
				state.status = "skipped";
				saveCheckpoint(ctx.cwd, buildCp());
				return;
			}
			if (choice.startsWith("2")) {
				state.status = "skipped";
				saveCheckpoint(ctx.cwd, buildCp());
				ctx.ui.notify(`⏭️ 已跳过: ${step.label}`, "info");
				continue;
			}
		}

		// ── Execute ──
		state.status = "running";
		const stepStartTime = Date.now();
		showProgress(ctx, steps, stepStates, currentStepIndex);

		try {
			if (step.type === "loop-group") {
				await executeLoopGroup(ctx, step, state, agentMap, prompt, planFileRelPath, mode, loopCounts);
			} else {
				await executeSingleStep(ctx, step, state, agentMap, prompt, planFileRelPath, mode);
				// Capture plan file after planner
				if (step.agentName === "planner") {
					planFileRelPath = findLatestPlanFile(ctx.cwd);
				}
			}
			state.status = "done";
			state.durationMs = Date.now() - stepStartTime;
			ctx.ui.notify(`✅ ${step.label} — 完成 (${(state.durationMs / 1000).toFixed(1)}s)`, "success");
		} catch (err) {
			state.status = "failed";
			state.durationMs = Date.now() - stepStartTime;
			state.error = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`❌ ${step.label} — 失败: ${state.error}`, "error");
		}

		showProgress(ctx, steps, stepStates, currentStepIndex + 1);
		saveCheckpoint(ctx.cwd, buildCp());
	}

	// ── Done ──
	deleteCheckpointFile(ctx.cwd);
	ctx.ui.notify("🎉 工作流全部完成！", "success");

	// ── Checkpoint builder ──
	function buildCp(): CheckpointData {
		return {
			version: 1,
			createdAt: existingCp?.createdAt ?? new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			prompt,
			mode,
			steps: stepStates,
			currentStepIndex,
			loopCounts,
			planFilePath: planFileRelPath,
		};
	}
}

// ═══════════════════════════════════════════════════════════════
//  Extension factory (no-op — imported by dev-prompts.ts)
// ═══════════════════════════════════════════════════════════════

export default function (_pi: ExtensionAPI) {
	// workflow-engine is a helper module, not a standalone extension.
}
