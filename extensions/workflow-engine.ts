/**
 * workflow-engine.ts — 工作流编排引擎
 *
 * 职责：
 *   1. runWorkflow() — 主入口，编排多步骤工作流（后台异步执行）
 *   2. 支持 值守/全自动/完全值守 三种模式
 *   3. 支持 {} loop 组（worker→reviewer, trimmer→reviewer）
 *   4. 支持 [] 标记的确认步骤
 *   5. Checkpoint 保存/恢复（断点续传）
 *   6. 超时处理（按 mode 策略分支）
 *   7. 进度面板 UI — 使用 ctx.ui.setWidget() 持久化面板，支持 Ctrl+O 展开
 *
 * 被 dev-prompts.ts 引入，不独立作为 extension 加载。
 *
 * 设计要点：
 *   - 非阻塞执行：通过 AbortController 管理取消，widget 动画更新进度
 *   - 步骤详情：记录 agent 的工具调用、输出路径等子步骤信息
 *   - 归档：工作流完成后 checkpoint 重命名而非删除
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { spawnSubagent, extractFinalOutput, discoverAgents, type AgentDef, type SubagentResult } from "./sub-agents";
import {
	uiSelect,
	uiConfirm,
	uiInput,
	updateWorkflowWidget,
	buildWidgetState,
	sendWorkflowResult,
	setWorkflowCancelCallback,
	cancelWorkflow,
	type WorkflowStepWidgetState,
	type WorkflowSubStepWidgetState,
	type WorkflowWidgetState,
} from "./ui-helpers";

// ═══════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════

export type WorkflowMode = "attended" | "full-auto" | "full-attended";

export interface WorkflowStepDef {
	id: string;
	label: string;
	type: "auto" | "confirm" | "loop-group";
	agentName?: string;
	loopAgentName?: string;
	reviewAgentName?: string;
	maxLoops?: number;
	timeoutMs: number;
}

interface WorkflowStepState {
	status: "pending" | "running" | "done" | "failed" | "skipped";
	durationMs?: number;
	loopCount?: number;
	error?: string;
}

interface FileChangeEntry {
	agent: string;
	stepIndex: number;
	type: "edit" | "new" | "delete" | "read";
	filePath: string;
	timestamp: string;
}

interface AgentRunEntry {
	agent: string;
	stepIndex: number;
	startedAt: string;
	durationMs: number;
	exitCode: number;
	toolCount: number;
}

interface CheckpointData {
	version: 2;
	createdAt: string;
	updatedAt: string;
	prompt: string;
	mode: WorkflowMode;
	steps: WorkflowStepState[];
	currentStepIndex: number;
	loopCounts: Record<string, number>;
	planFilePath?: string;
	// New fields for better UI and traceability
	taskSummary?: string;
	workflowType?: string;
	fileChanges?: FileChangeEntry[];
	subAgentRuns?: number;
	filesModified?: number;
	filesCreated?: number;
	agentRunHistory?: AgentRunEntry[];
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
	const fallback = output.match(/\{"maxSeverity":\s*"(critical|medium|low)"[\s\S]*?\}/);
	if (fallback) {
		try {
			const parsed = JSON.parse(fallback[0]);
			if (parsed && typeof parsed.maxSeverity === "string") return parsed;
		} catch { /* fallthrough */ }
	}
	return null;
}

export function extractSeverityFromText(
	text: string,
): { maxSeverity: string; critical: number; medium: number; low: number } | null {
	const headerCritical = [...text.matchAll(/^###\s+C\d+\./gm)].length;
	const headerMedium   = [...text.matchAll(/^###\s+M\d+\./gm)].length;
	const headerLow      = [...text.matchAll(/^###\s+L\d+\./gm)].length;
	if (headerCritical + headerMedium + headerLow > 0) {
		return {
			maxSeverity: headerCritical > 0 ? "critical" : headerMedium > 0 ? "medium" : "low",
			critical: headerCritical,
			medium: headerMedium,
			low: headerLow,
		};
	}
	const tableCritical = [...text.matchAll(/^\|\s*\w+\s*\|\s*critical/gim)].length;
	const tableMedium   = [...text.matchAll(/^\|\s*\w+\s*\|\s*medium/gim)].length;
	const tableLow      = [...text.matchAll(/^\|\s*\w+\s*\|\s*low/gim)].length;
	if (tableCritical + tableMedium + tableLow > 0) {
		return {
			maxSeverity: tableCritical > 0 ? "critical" : tableMedium > 0 ? "medium" : "low",
			critical: tableCritical,
			medium: tableMedium,
			low: tableLow,
		};
	}
	const labelCritical = [...text.matchAll(/\*\*(?:Severity|严重程度|严重性)\*\*\s*:\s*critical/gi)].length;
	const labelMedium   = [...text.matchAll(/\*\*(?:Severity|严重程度|严重性)\*\*\s*:\s*medium/gi)].length;
	const labelLow      = [...text.matchAll(/\*\*(?:Severity|严重程度|严重性)\*\*\s*:\s*low/gi)].length;
	if (labelCritical + labelMedium + labelLow > 0) {
		return {
			maxSeverity: labelCritical > 0 ? "critical" : labelMedium > 0 ? "medium" : "low",
			critical: labelCritical,
			medium: labelMedium,
			low: labelLow,
		};
	}
	return null;
}

export function readLatestReviewMd(cwd: string): string | null {
	const reviewDir = path.join(cwd, DEV_OUTPUT_DIR, "pi-review", "md");
	try {
		if (!fs.existsSync(reviewDir)) return null;
		const files = fs.readdirSync(reviewDir)
			.filter(f => f.endsWith(".md"))
			.map(f => ({ name: f, mtime: fs.statSync(path.join(reviewDir, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		if (files.length === 0) return null;
		return fs.readFileSync(path.join(reviewDir, files[0].name), "utf-8");
	} catch {
		return null;
	}
}

export function isTimeoutResult(r: SubagentResult): boolean {
	return r.exitCode === -1 && r.stderr.includes("timed out");
}

/**
 * Extract a human-readable task summary from the prompt.
 */
export function extractTaskSummary(prompt: string): string {
	const firstLine = prompt.split("\n").find(l => l.trim()) ?? "";
	const tagMatch = firstLine.match(/^\[([^\]]+)\]\s*(.+)/);
	if (tagMatch) {
		const tag = tagMatch[1]!.trim();
		const rest = tagMatch[2]!.trim();
		// If the rest looks like placeholder dots, try to find a better summary
		if (rest.replace(/\.\.\./g, "").trim() === "" || rest === "...") {
			const lines = prompt.split("\n").filter(l => l.trim());
			if (lines.length > 1) {
				const secondLine = lines[1]!.replace(/^[*\s#]+/, "").trim();
				if (secondLine && !secondLine.startsWith("**")) {
					return `${tag} - ${secondLine.substring(0, 60)}`;
				}
			}
			for (const line of lines.slice(1, 5)) {
				const cleaned = line.replace(/^[*\s#]+/, "").trim();
				if (cleaned && cleaned.length > 5 && !cleaned.startsWith("**") && !cleaned.startsWith("`")) {
					const summary = cleaned.length > 50 ? cleaned.substring(0, 47) + "..." : cleaned;
					return `${tag} - ${summary}`;
				}
			}
			return `${tag} - 工作流任务`;
		}
		return `${tag} - ${rest}`;
	}
	const cleaned = firstLine.replace(/^[*\s#]+/, "").trim();
	return cleaned.length > 60 ? cleaned.substring(0, 57) + "..." : cleaned || "工作流任务";
}

// ═══════════════════════════════════════════════════════════════
//  Checkpoint
// ═══════════════════════════════════════════════════════════════

function saveCheckpoint(cwd: string, data: CheckpointData): void {
	ensureOutputDir(cwd, "pi-workflow");
	data.updatedAt = new Date().toISOString();
	// Always version 2
	(data as CheckpointData).version = 2;
	// Enrich with file changes and agent history from module state
	if (_workflowFileChanges.length > 0 && !data.fileChanges) {
		data.fileChanges = [..._workflowFileChanges];
	}
	if (_workflowAgentRunHistory.length > 0 && !data.agentRunHistory) {
		data.agentRunHistory = [..._workflowAgentRunHistory];
	}
	fs.writeFileSync(path.join(cwd, CHECKPOINT_FILE), JSON.stringify(data, null, 2), "utf-8");
}

export function loadCheckpointFromFile(cwd: string): CheckpointData | null {
	try {
		const content = fs.readFileSync(path.join(cwd, CHECKPOINT_FILE), "utf-8");
		const data = JSON.parse(content) as CheckpointData;
		// Backfill missing fields for v1 checkpoints
		if (!data.version || data.version < 2) {
			data.version = 2;
			data.fileChanges = data.fileChanges ?? [];
			data.agentRunHistory = data.agentRunHistory ?? [];
		}
		return data;
	} catch {
		return null;
	}
}

/**
 * Archive checkpoint after completion: rename to checkpoint-<plan-id>.json
 */
export function archiveCheckpointFile(cwd: string, planFileRelPath?: string): void {
	try {
		const cpPath = path.join(cwd, CHECKPOINT_FILE);
		if (!fs.existsSync(cpPath)) return;
		const planId = planFileRelPath
			? path.basename(planFileRelPath, ".md").replace(/[^a-zA-Z0-9_-]/g, "_")
			: `archive-${Date.now().toString(36)}`;
		const archiveName = `checkpoint-${planId}.json`;
		const archiveDir = path.join(cwd, DEV_OUTPUT_DIR, "pi-workflow");
		fs.renameSync(cpPath, path.join(archiveDir, archiveName));
	} catch { /* ignore */ }
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
		"将详细审查报告写入 pi-dev-output/pi-review/md/ 目录。",
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
//  Global state for async execution
// ═══════════════════════════════════════════════════════════════

interface StepRuntimeInfo {
	widgetStep: WorkflowStepWidgetState;
	state: WorkflowStepState;
}

let _workflowAbortController: AbortController | null = null;
let _workflowPi: ExtensionAPI | null = null;
let _workflowType: string | undefined;
let _workflowCwd = "";
let _workflowPrompt = "";
let _workflowPlanFileRelPath: string | undefined;
/** Track loop counts at module level so cancel callback can save a proper checkpoint. */
let _workflowLoopCounts: Record<string, number> = {};
/** Original checkpoint creation timestamp, for preserving across cancel. */
let _workflowCreatedAt: string = new Date().toISOString();
/** Track file changes globally for checkpoint persistence */
let _workflowFileChanges: FileChangeEntry[] = [];
/** Track agent run history */
let _workflowAgentRunHistory: AgentRunEntry[] = [];
/** Store step defs for pre-populating sub-steps */
let _workflowStepDefs: WorkflowStepDef[] = [];

let _widgetMode: WorkflowMode = "attended";
let _widgetSteps: WorkflowStepWidgetState[] = [];
let _widgetCurrentIdx = 0;
let _widgetStartTime = 0;
let _widgetExtraToolCount = 0;
let _widgetExtraTokenCount = 0;
let _workflowRunning = false;

function refreshWidget(): void {
	if (!_lastWorkflowCtx) return;
	const widgetState = buildWidgetState(
		_widgetMode,
		_widgetSteps,
		_widgetCurrentIdx,
		_widgetStartTime,
		_workflowRunning ? "running" :
			_widgetSteps.some(s => s.status === "failed") ? "failed" :
			_widgetSteps.every(s => s.status === "done" || s.status === "skipped") ? "done" :
			"running",
		{ toolCount: _widgetExtraToolCount, tokenCount: _widgetExtraTokenCount },
	);
	updateWorkflowWidget(_lastWorkflowCtx, widgetState);
}

let _lastWorkflowCtx: ExtensionCommandContext | null = null;

function initWidget(ctx: ExtensionCommandContext, mode: WorkflowMode, stepsCount: number): void {
	_widgetMode = mode;
	_widgetSteps = [];
	for (let i = 0; i < stepsCount; i++) {
		_widgetSteps.push({ label: "", status: "pending" });
	}
	_widgetCurrentIdx = 0;
	_widgetStartTime = Date.now();
	_widgetExtraToolCount = 0;
	_widgetExtraTokenCount = 0;
	_lastWorkflowCtx = ctx;
	_workflowRunning = true;
	refreshWidget();
}

function updateWidgetStep(
	index: number,
	label: string,
	status: WorkflowStepWidgetState["status"],
	extra?: {
		durationMs?: number;
		loopCount?: number;
		maxLoops?: number;
		timeoutMs?: number;
		error?: string;
		subSteps?: WorkflowSubStepWidgetState[];
		startedAt?: number;
	},
): void {
	if (index < _widgetSteps.length) {
		_widgetSteps[index] = {
			label,
			status,
			...extra,
		};
	}
	refreshWidget();
}

function populatePredefinedSubSteps(stepIndex: number): void {
	const step = _widgetSteps[stepIndex];
	if (!step || !_workflowStepDefs[stepIndex]) return;
	if (step.subSteps && step.subSteps.length > 0) return; // already populated

	const def = _workflowStepDefs[stepIndex]!;
	const newSubSteps: WorkflowSubStepWidgetState[] = [];

	if (def.type === "loop-group") {
		if (def.loopAgentName) {
			newSubSteps.push({
				agent: def.loopAgentName,
				status: "pending",
				tools: [],
				outputs: [],
			});
		}
		if (def.reviewAgentName) {
			newSubSteps.push({
				agent: def.reviewAgentName,
				status: "pending",
				tools: [],
				outputs: [],
			});
		}
	} else if (def.agentName) {
		newSubSteps.push({
			agent: def.agentName,
			status: "pending",
			tools: [],
			outputs: [],
		});
	}

	if (newSubSteps.length > 0) {
		step.subSteps = newSubSteps;
		refreshWidget();
	}
}

function addWidgetSubStepTool(stepIndex: number, agentName: string, tool: string): void {
	const step = _widgetSteps[stepIndex];
	if (!step) return;
	const sub = step.subSteps?.find(s => s.agent === agentName);
	if (sub) {
		if (!sub.tools) sub.tools = [];
		sub.tools.push(tool);
		if (sub.tools.length > 20) sub.tools = sub.tools.slice(-20); // keep last 20

		// Also track as file change for checkpoint
		const toolMatch = tool.match(/^(edit|new|delete|read):\s*(.+)/i);
		if (toolMatch) {
			const changeType = toolMatch[1]!.toLowerCase() as FileChangeEntry["type"];
			const filePath = toolMatch[2]!.trim();
			// Deduplicate
			const exists = _workflowFileChanges.some(
				c => c.filePath === filePath && c.type === changeType && c.stepIndex === stepIndex && c.agent === agentName,
			);
			if (!exists && filePath.length > 3) {
				_workflowFileChanges.push({
					agent: agentName,
					stepIndex,
					type: changeType,
					filePath,
					timestamp: new Date().toISOString(),
				});
			}
		}

		refreshWidget();
	}
}

function addWidgetSubStepOutput(stepIndex: number, agentName: string, output: string): void {
	const step = _widgetSteps[stepIndex];
	if (!step) return;
	const sub = step.subSteps?.find(s => s.agent === agentName);
	if (sub) {
		if (!sub.outputs) sub.outputs = [];
		if (!sub.outputs.includes(output)) {
			sub.outputs.push(output);
		}
		refreshWidget();
	}
}

function setWidgetSubStepStatus(stepIndex: number, agentName: string, status: WorkflowSubStepWidgetState["status"]): void {
	const step = _widgetSteps[stepIndex];
	if (!step) return;
	const sub = step.subSteps?.find(s => s.agent === agentName);
	if (sub) {
		sub.status = status;
		refreshWidget();
	}
}

function setWidgetCurrentStep(index: number): void {
	_widgetCurrentIdx = index;
	refreshWidget();
}

function cleanupWidget(): void {
	_workflowRunning = false;
	if (_lastWorkflowCtx) {
		updateWorkflowWidget(_lastWorkflowCtx, null);
		_lastWorkflowCtx = null;
	}
	_workflowAbortController = null;
	setWorkflowCancelCallback(null);
	// Clean up terminal input listener (Esc)
	if (_terminalInputUnsubscribe) {
		_terminalInputUnsubscribe();
		_terminalInputUnsubscribe = null;
	}
	// Clean up signal handlers
	cleanupSignalHandlers();
}

/** Unsubscribe function for terminal input listener (Esc to cancel) */
let _terminalInputUnsubscribe: (() => void) | null = null;

// ── Signal handling (SIGINT/SIGTERM) for graceful workflow cancellation ──

let _signalHandlersRegistered = false;

function cleanupSignalHandlers(): void {
	if (!_signalHandlersRegistered) return;
	try { process.removeListener("SIGINT", onSigint); } catch { /* ignore */ }
	try { process.removeListener("SIGTERM", onSigterm); } catch { /* ignore */ }
	_signalHandlersRegistered = false;
}

function onSigint(): void {
	if (_workflowRunning && _workflowAbortController && !_workflowAbortController.signal.aborted) {
		console.log("\n[workflow] SIGINT received, cancelling workflow...");
		cancelWorkflow();
	}
}

function onSigterm(): void {
	if (_workflowRunning && _workflowAbortController && !_workflowAbortController.signal.aborted) {
		cancelWorkflow();
	}
}

function registerSignalHandlers(): void {
	if (_signalHandlersRegistered) return;
	try {
		process.on("SIGINT", onSigint);
		process.on("SIGTERM", onSigterm);
		_signalHandlersRegistered = true;
	} catch { /* ignore */ }
}

// ── Cancel handler ──


// ═══════════════════════════════════════════════════════════════
//  Agent runner (non-blocking, widget-based)
// ═══════════════════════════════════════════════════════════════

/**
 * Run a sub-agent without blocking the main TUI.
 * Progress is reported via the widget sub-step system.
 * Uses the global AbortController for cancellation.
 */
async function runAgentWithProgress(
	agent: AgentDef,
	task: string,
	stepIndex: number,
	agentName: string,
	timeoutMs: number,
): Promise<SubagentResult> {
	const signal = _workflowAbortController?.signal;
	const agentStartTime = Date.now();

	// Initialize sub-step in widget
	const step = _widgetSteps[stepIndex];
	if (step) {
		if (!step.subSteps) step.subSteps = [];
		const existing = step.subSteps.find(s => s.agent === agentName);
		if (!existing) {
			step.subSteps.push({
				agent: agentName,
				status: "running",
				tools: [],
				outputs: [],
				startedAt: agentStartTime,
			});
			refreshWidget();
		} else {
			// Update existing sub-step status and startedAt
			existing.status = "running";
			existing.startedAt = agentStartTime;
			refreshWidget();
		}
	}

	// Parse progress messages for tool calls and outputs
	const result = await spawnSubagent(agent, task, _workflowCwd, signal, timeoutMs, (progress) => {
		// Try to parse tool calls from progress messages
		// Only match if it looks like a file path (contains a dot or path separator)
		const toolMatch = progress.match(/(edit|read|write|new|bash|grep|find|ls|delete|remove)\s*[:：]\s*(\S+)/i);
		if (toolMatch) {
			const toolType = toolMatch[1]!.toLowerCase();
			const target = toolMatch[2]!;
			// Only classify as file operation if it's a file path-like string
			if (target.includes(".") || target.includes("/") || target.includes("\\")) {
				addWidgetSubStepTool(stepIndex, agentName, `${toolType}: ${target}`);
				_widgetExtraToolCount++;
			}
		}
		// Detect output file paths — ONLY match proper file paths, not random "output:" substrings
		const outputMatch = progress.match(/output:\s*([^\s]{5,})/i);
		if (outputMatch) {
			const pathCandidate = outputMatch[1]!;
			// Only treat as output if it looks like a file path
			if (pathCandidate.includes(".") || pathCandidate.includes("/") || pathCandidate.includes("\\")) {
				if (pathCandidate.length > 5 && pathCandidate.length < 300) {
					addWidgetSubStepOutput(stepIndex, agentName, pathCandidate);
				}
			}
		}
	});

	const agentDuration = Date.now() - agentStartTime;

	// Record agent run in history
	_workflowAgentRunHistory.push({
		agent: agentName,
		stepIndex,
		startedAt: new Date(agentStartTime).toISOString(),
		durationMs: agentDuration,
		exitCode: result.exitCode,
		toolCount: _widgetExtraToolCount,
	});

	// ── Post-completion: parse subagent output for tool calls and file paths ──
	// Progress messages from spawnSubagent rarely contain tool info,
	// so we scan the full output after completion.
	const allOutput = (result.output || "") + "\n" + (result.stderr || "");
	const finalOutput = extractFinalOutput(result.output) || result.output;
	const searchText = allOutput + "\n" + finalOutput;

	// Detect file creation/modification patterns from agent's final output text
	// The agent's response typically lists files using markdown backticks or bullet points
	const filePatterns = [
		// Markdown code blocks with file paths: `src/main.rs`, `path/to/file.ts`
		/`([^`]+\.[a-zA-Z0-9_]+)`/g,
		// Bullet points with file operation verbs: - Modify `src/main.rs`, * Created `file.ts`
		/(?:^|\n)\s*[-*]\s*(?:modified|created|updated|edited|added|deleted|removed|changed|wrote|writes?)\s*[`"']?([^`"'\n,]+\.[a-zA-Z0-9_]+)[`"']?/gim,
		// Descriptive: "I've modified src/main.rs", "reading config.json"
		/(?:modified|created|updated|edited|added|deleted|removed|changed|wrote|write|writes|read|reads?)\s+(?:the\s+)?[`"']?([^`"'\n,]+\.[a-zA-Z0-9_]+)[`"']?/gi,
		// Chinese patterns
		/(?:编写|创建|修改|删除|读取|写入|更新)\s*(?:了|文件)?\s*[:：]?\s*[`"']?([^`"'\s,，]+\.[a-zA-Z0-9_]+)[`"']?/gi,
		// File path with action prefix: "edit: src/file.ts", "new: src/file.ts"
		/(?:^|\n)\s*(?:edit|new|delete|read|modify|create|update|add|remove)\s*[:：]\s*([^\n]+\.[a-zA-Z0-9_]+)/gim,
	];
	const seenTools = new Set<string>();
	for (const pattern of filePatterns) {
		let m;
		while ((m = pattern.exec(searchText)) !== null) {
			const filePath = m[1]!.trim()
				.replace(/[`'"\)\(\]]+$/, "")
				.replace(/^[`'"\)\(\[]+/, "")
				.split(/[\s,;]/)[0]!;
			// Validate it's a real file path
			if (filePath.length > 3 && filePath.length < 300 && !seenTools.has(filePath)) {
				// Skip common non-file matches
				if (filePath.match(/^(the|a|an|this|that|it|its|my|your|our|their|some|any|all|each|every|both|few|many|several|most|other|another|such|what|which|whose|whom|when|where|why|how|who|being|having|doing|making|taking|giving|getting|setting|using|running|going|coming|looking|finding|keeping|putting)/i)) continue;
				if (filePath.startsWith("http")) continue;
				if (filePath.length < 6 && !filePath.includes("/")) continue;

				seenTools.add(filePath);
				const fullMatch = m[0]!.toLowerCase();
				// Determine operation type
				let toolType = "edit";
				if (fullMatch.includes("write") || fullMatch.includes("创建") || fullMatch.includes("new") || fullMatch.includes("add") || fullMatch.includes("created") || fullMatch.includes("added")) {
					toolType = "new";
				} else if (fullMatch.includes("delete") || fullMatch.includes("删除") || fullMatch.includes("remove") || fullMatch.includes("deleted") || fullMatch.includes("removed")) {
					toolType = "delete";
				} else if (fullMatch.includes("read") || fullMatch.includes("读取")) {
					toolType = "read";
				}
				addWidgetSubStepTool(stepIndex, agentName, `${toolType}: ${filePath}`);
				_widgetExtraToolCount++;
			}
		}
	}

	// If we found no file tools from text patterns, try alternative approaches
	// Look for explicit tool call patterns in the raw JSON output
	if (seenTools.size === 0) {
		const jsonLines = (result.output || "").split("\n");
		for (const line of jsonLines) {
			try {
				const event = JSON.parse(line);
				// Look for tool_use events in the JSON stream
				if (event.type === "message_update" && event.assistantMessageEvent?.type === "tool_use") {
					const toolName = event.assistantMessageEvent.name;
					const args = event.assistantMessageEvent.args || {};
					// write tool: args contains file_path
					if (toolName === "write" && args.file_path) {
						const fp = args.file_path.trim();
						if (!seenTools.has(fp)) {
							seenTools.add(fp);
							addWidgetSubStepTool(stepIndex, agentName, `new: ${fp}`);
							_widgetExtraToolCount++;
						}
					}
					// edit tool: args contains file_path
					if (toolName === "edit" && args.file_path) {
						const fp = args.file_path.trim();
						if (!seenTools.has(fp)) {
							seenTools.add(fp);
							addWidgetSubStepTool(stepIndex, agentName, `edit: ${fp}`);
							_widgetExtraToolCount++;
						}
					}
				}
			} catch { /* not JSON, skip */ }
		}
	}

	// Find output file paths (pi-dev-output, review reports, plan files)
	const outputPathPatterns = [
		// Save to path: "save to pi-dev-output/pi-plans/xxx.md"
		/(?:output|保存|save|写入|write)\s*(?:到|至|to|:)?\s*["']?([^"'\n]+\.[a-zA-Z0-9_]+)["']?/gi,
		// Direct reference to pi-dev-output paths
		/pi-dev-output\/[^"'\s,)+]+/g,
		// Review file patterns
		/review-\d{8}-\d{6}\.md/g,
	];
	const seenOutputs = new Set<string>();
	for (const pattern of outputPathPatterns) {
		let m;
		while ((m = pattern.exec(searchText)) !== null) {
			let path_ = m[0]!.trim().replace(/["']/g, "");
			// If first group captured, use it (the cleaned path)
			if (m[1] && m[1].length > 3) {
				path_ = m[1]!.trim().replace(/["']/g, "");
			}
			if (path_.length > 5 && path_.length < 300 && !seenOutputs.has(path_)) {
				seenOutputs.add(path_);
				addWidgetSubStepOutput(stepIndex, agentName, path_);
			}
		}
	}

	// Update sub-step status based on result
	const subStatus: WorkflowSubStepWidgetState["status"] =
		result.exitCode === 0 ? "done" :
		isTimeoutResult(result) ? "failed" :
		result.exitCode !== 0 ? "failed" :
		"done";
	setWidgetSubStepStatus(stepIndex, agentName, subStatus);

	return result;
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
	stepIndex: number,
): Promise<void> {
	const agentName = step.agentName!;
	const agent = agentMap.get(agentName);
	if (!agent) throw new Error(`未找到 agent: ${agentName}`);

	const task = buildTaskForStep(agentName, prompt, planFileRelPath, _workflowCwd);
	let retried = false;

	let result = await runAgentWithProgress(agent, task, stepIndex, agentName, step.timeoutMs);

	// Timeout handling
	if (isTimeoutResult(result)) {
		if (mode === "full-auto" && !retried) {
			result = await runAgentWithProgress(agent, `[RETRY]\n\n${task}`, stepIndex, agentName, step.timeoutMs);
			retried = true;
		} else {
			const choice = await uiSelect(ctx, `⏰ ${step.label} 执行超时`, [
				"1. 重新执行", "2. 跳过此步骤", "3. 取消工作流",
			]);
			if (!choice || choice.startsWith("3")) { cancelWorkflow(); return; }
			if (choice.startsWith("2")) { state.status = "skipped"; return; }
			result = await runAgentWithProgress(agent, `[RETRY]\n\n${task}`, stepIndex, agentName, step.timeoutMs);
		}
	}

	if (isTimeoutResult(result)) {
		throw new Error(`执行超时 (${(step.timeoutMs / 1000).toFixed(0)}s)`);
	}

	if (result.exitCode !== 0 && result.stderr) {
		throw new Error(`Agent 错误 (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
	}
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
	stepIndex: number,
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

		// Run loop agent
		const loopTask = buildTaskForStep(step.loopAgentName!, contextPrompt, planFileRelPath, _workflowCwd);

		let agentResult = await runAgentWithProgress(loopAgent, loopTask, stepIndex, step.loopAgentName!, step.timeoutMs);

		if (isTimeoutResult(agentResult)) {
			if (mode === "full-auto") {
				contextPrompt = `[TIMEOUT_WARNING] 上一个 ${step.loopAgentName} 执行超时。\n\n${buildReviewTask(prompt, planFileRelPath, _workflowCwd)}`;
			} else {
				const choice = await uiSelect(ctx, `⏰ ${step.loopAgentName} 执行超时`, [
					"1. 重新执行", "2. 进入审查阶段", "3. 跳过此步骤", "4. 取消工作流",
				]);
				if (!choice || choice.startsWith("4")) { cancelWorkflow(); return; }
				if (choice.startsWith("3")) { state.status = "skipped"; return; }
				if (choice.startsWith("2")) {
					contextPrompt = `[TIMEOUT_WARNING]\n\n${buildReviewTask(prompt, planFileRelPath, _workflowCwd)}`;
				} else {
					agentResult = await runAgentWithProgress(loopAgent, `[RETRY]\n\n${loopTask}`, stepIndex, step.loopAgentName!, step.timeoutMs);
					if (isTimeoutResult(agentResult)) {
						contextPrompt = `[TIMEOUT_WARNING]\n\n${buildReviewTask(prompt, planFileRelPath, _workflowCwd)}`;
					}
				}
			}
		}

		// Run reviewer
		const reviewTask = contextPrompt.includes("[TIMEOUT_WARNING]")
			? contextPrompt
			: buildReviewTask(contextPrompt, planFileRelPath, _workflowCwd);

		const reviewResult = await runAgentWithProgress(reviewAgent, reviewTask, stepIndex, step.reviewAgentName!, step.timeoutMs);

		const extractedOutput = extractFinalOutput(reviewResult.output) || reviewResult.output;
		const combinedOutput = extractedOutput + "\n" + reviewResult.stderr;
		let reviewSummary = parseReviewerOutput(combinedOutput);
		if (!reviewSummary) reviewSummary = extractSeverityFromText(extractedOutput);
		if (!reviewSummary) {
			const reviewContent = readLatestReviewMd(_workflowCwd);
			if (reviewContent) {
				reviewSummary = parseReviewerOutput(reviewContent) ?? extractSeverityFromText(reviewContent);
			}
		}

		loopCount++;

		if (reviewSummary?.maxSeverity === "critical" && loopCount < maxLoops) {
			if (mode === "full-auto") {
				contextPrompt = [prompt, "", "## 上次审查发现的问题",
					`审查摘要: ${JSON.stringify(reviewSummary)}`,
					`请修复 ${reviewSummary.critical} 个严重问题后重新运行。`,
				].join("\n");
				continue;
			} else {
				const shouldLoop = await uiConfirm(ctx, "🔄 检测到严重问题",
					`审查发现 ${reviewSummary.critical} 个严重问题。是否进入下一轮循环 (${loopCount}/${maxLoops})？`);
				if (shouldLoop) {
					contextPrompt = [prompt, "", "## 上次审查发现的问题",
						`审查摘要: ${JSON.stringify(reviewSummary)}`,
						`请修复这些严重问题后重新运行。`,
					].join("\n");
					continue;
				}
				break;
			}
		}
		break;
	}

	state.loopCount = loopCount;
	loopCounts[step.id] = loopCount;
}

// ═══════════════════════════════════════════════════════════════
//  Main async workflow executor
// ═══════════════════════════════════════════════════════════════

async function executeWorkflowBackground(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	prompt: string,
	steps: WorkflowStepDef[],
	agentMap: Map<string, AgentDef>,
	mode: WorkflowMode,
	stepStates: WorkflowStepState[],
	initialStepIndex: number,
	initialLoopCounts: Record<string, number>,
	planFileRelPath: string | undefined,
	existingCp: CheckpointData | undefined,
): Promise<void> {
	let loopCounts = { ...initialLoopCounts };
	let currentStepIndex = initialStepIndex;
	let planFileRelPathInner = planFileRelPath;

	for (; currentStepIndex < steps.length; currentStepIndex++) {
		// Check abort
		if (_workflowAbortController?.signal.aborted) {
			return;
		}

		const step = steps[currentStepIndex]!;
		const state = stepStates[currentStepIndex]!;

		if (state.status === "done" || state.status === "skipped") continue;

		setWidgetCurrentStep(currentStepIndex);

		// Pre-populate sub-steps for pending steps so UI shows queued agents
		populatePredefinedSubSteps(currentStepIndex);

		// ── User confirmations (BEFORE timer starts) ──

		// Confirmation for [confirm] steps (attended mode)
		if (step.type === "confirm" && mode !== "full-auto") {
			const choice = await uiSelect(ctx, `📌 ${step.label}`, [
				"1. 进入此步骤", "2. 自定义输入", "3. 跳过此步骤", "4. 取消工作流",
			]);
			if (!choice || choice.startsWith("4")) { cancelWorkflow(); return; }
			if (choice.startsWith("3")) {
				state.status = "skipped";
				saveCheckpoint(_workflowCwd, buildCp());
				updateWidgetStep(currentStepIndex, step.label, "skipped");
				continue;
			}
			if (choice.startsWith("2")) {
				const customInput = await uiInput(ctx, "✏️ 自定义输入", "输入你的指令或反馈");
				if (customInput !== undefined && customInput.trim()) {
					prompt = `${prompt}\n\n## 用户自定义指令\n${customInput.trim()}`;
				}
			}
		}

		// Full-attended: confirm every step
		if (mode === "full-attended" && step.type !== "confirm") {
			const choice = await uiSelect(ctx, `📌 ${step.label} — 执行？`, ["1. 执行", "2. 跳过", "3. 取消工作流"]);
			if (!choice || choice.startsWith("3")) { cancelWorkflow(); return; }
			if (choice.startsWith("2")) {
				state.status = "skipped";
				saveCheckpoint(_workflowCwd, buildCp());
				updateWidgetStep(currentStepIndex, step.label, "skipped");
				continue;
			}
		}

		// Attended: confirm loop-group steps (e.g. 实施代码 → 审查)
		if (step.type === "loop-group" && mode === "attended") {
			const choice = await uiSelect(ctx, `📌 ${step.label}`, [
				"1. 进入此步骤", "2. 跳过此步骤", "3. 取消工作流",
			]);
			if (!choice || choice.startsWith("3")) { cancelWorkflow(); return; }
			if (choice.startsWith("2")) {
				state.status = "skipped";
				saveCheckpoint(_workflowCwd, buildCp());
				updateWidgetStep(currentStepIndex, step.label, "skipped");
				continue;
			}
		}

		// ── Execute (timer starts NOW, after all user confirmations) ──
		state.status = "running";
		const stepStartTime = Date.now();
		updateWidgetStep(currentStepIndex, step.label, "running", { timeoutMs: step.timeoutMs, maxLoops: step.maxLoops, startedAt: stepStartTime });

		try {
			if (step.type === "loop-group") {
				await executeLoopGroup(ctx, step, state, agentMap, prompt, planFileRelPathInner, mode, loopCounts, currentStepIndex);
			} else {
				await executeSingleStep(ctx, step, state, agentMap, prompt, planFileRelPathInner, mode, currentStepIndex);
				if (step.agentName === "planner") {
					planFileRelPathInner = findLatestPlanFile(_workflowCwd);
				}
			}
			state.status = "done";
			state.durationMs = Date.now() - stepStartTime;
			updateWidgetStep(currentStepIndex, step.label, "done", {
				durationMs: state.durationMs,
				loopCount: state.loopCount,
				maxLoops: step.maxLoops,
				timeoutMs: step.timeoutMs,
			});
		} catch (err) {
			state.status = "failed";
			state.durationMs = Date.now() - stepStartTime;
			state.error = err instanceof Error ? err.message : String(err);
			updateWidgetStep(currentStepIndex, step.label, "failed", {
				durationMs: state.durationMs,
				error: state.error,
				loopCount: state.loopCount,
			});
		}

		setWidgetCurrentStep(currentStepIndex + 1);
		saveCheckpoint(_workflowCwd, buildCp());
	}

	// ── Done ──
	_workflowRunning = false;

	// Archive checkpoint instead of deleting
	archiveCheckpointFile(_workflowCwd, planFileRelPathInner);

	// Send persistent result
	const finalState = buildWidgetState(
		mode,
		_widgetSteps,
		steps.length,
		_widgetStartTime,
		stepStates.every(s => s.status === "done" || s.status === "skipped") ? "done" : "failed",
		{ toolCount: _widgetExtraToolCount, tokenCount: _widgetExtraTokenCount },
	);
	sendWorkflowResult(pi, finalState, prompt, _workflowType);

	// Cleanup widget after delay
	setTimeout(() => cleanupWidget(), 5000);

	function buildCp(): CheckpointData {
		return {
			version: 2,
			createdAt: existingCp?.createdAt ?? new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			prompt,
			mode,
			steps: stepStates,
			currentStepIndex,
			loopCounts,
			planFilePath: planFileRelPathInner,
			taskSummary: extractTaskSummary(prompt),
			workflowType: _workflowType,
			fileChanges: [..._workflowFileChanges],
			subAgentRuns: _workflowAgentRunHistory.length,
			filesModified: _workflowFileChanges.filter(c => c.type === "edit").length,
			filesCreated: _workflowFileChanges.filter(c => c.type === "new").length,
			agentRunHistory: [..._workflowAgentRunHistory],
		};
	}
}

// ═══════════════════════════════════════════════════════════════
//  Main entry
// ═══════════════════════════════════════════════════════════════

export interface WorkflowConfig {
	steps: WorkflowStepDef[];
}

/**
 * Launch a workflow asynchronously.
 * Sets up the widget and runs steps in background.
 * Does NOT block - the caller (command handler) returns immediately.
 *
 * @param ctx   命令上下文
 * @param pi    Extension API
 * @param prompt  用户原始 prompt
 * @param config  工作流步骤配置
 * @param workflowType  可选的类型标签（feat/fix/doc 等），用于完成消息
 */
export async function runWorkflow(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	prompt: string,
	config: WorkflowConfig,
	workflowType?: string,
): Promise<void> {
	const { steps } = config;

	// ── Load & validate agents ──
	const agents = discoverAgents();
	const agentMap = new Map<string, AgentDef>();
	for (const a of agents) agentMap.set(a.name, a);

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
				await uiSelect(ctx, `❌ 未找到 agent "${n}"`, ["确定"]);
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
		const resume = await uiConfirm(ctx, "🔄 恢复工作流",
			`发现上次未完成的工作流（${existingCp.updatedAt}），是否继续？`);
		if (resume) {
			mode = existingCp.mode;
			Object.assign(stepStates, existingCp.steps);
			currentStepIndex = existingCp.currentStepIndex;
			loopCounts = existingCp.loopCounts;
			planFileRelPath = existingCp.planFilePath;
			resumeFlow = true;
		} else {
			archiveCheckpointFile(ctx.cwd); // archive old checkpoint
		}
	}

	if (!existingCp || !resumeFlow) {
		const modeChoice = await uiSelect(ctx, "🤖 选择工作流模式", [
			"1. 值守（默认）— 自动流程，[]步骤需确认，循环需许可",
			"2. 完全信任 — 全自动运行，无需任何确认",
			"3. 完全值守 — 每一步都需用户确认",
			"4. 取消工作流",
		]);
		if (!modeChoice || modeChoice.startsWith("4")) return;
		mode = modeChoice.startsWith("2") ? "full-auto" :
		       modeChoice.startsWith("3") ? "full-attended" : "attended";
	}

	// Save initial state
	_workflowCwd = ctx.cwd;
	_workflowPrompt = prompt;
	_workflowPlanFileRelPath = planFileRelPath;
	_workflowLoopCounts = loopCounts;
	_workflowCreatedAt = existingCp?.createdAt ?? new Date().toISOString();
	_workflowType = workflowType;
	_workflowPi = pi;
	_workflowStepDefs = steps;
	_workflowFileChanges = existingCp?.fileChanges ? [...existingCp.fileChanges] : [];
	_workflowAgentRunHistory = existingCp?.agentRunHistory ? [...existingCp.agentRunHistory] : [];

	saveCheckpoint(ctx.cwd, {
		version: 2,
		createdAt: existingCp?.createdAt ?? new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		prompt,
		mode,
		steps: stepStates,
		currentStepIndex,
		loopCounts,
		planFilePath: planFileRelPath,
		taskSummary: extractTaskSummary(prompt),
		workflowType,
		fileChanges: [..._workflowFileChanges],
		subAgentRuns: _workflowAgentRunHistory.length,
		filesModified: _workflowFileChanges.filter(c => c.type === "edit").length,
		filesCreated: _workflowFileChanges.filter(c => c.type === "new").length,
		agentRunHistory: [..._workflowAgentRunHistory],
	});

	// Initialize widget
	initWidget(ctx, mode, steps.length);
	for (let i = 0; i < steps.length; i++) {
		const isDoneState = stepStates[i]?.status === "done";
		updateWidgetStep(i, steps[i]!.label, isDoneState ? "done" : "pending", {
			maxLoops: steps[i]!.maxLoops,
			timeoutMs: steps[i]!.timeoutMs,
		});
		// Pre-populate sub-steps for all steps (shows queued agents)
		populatePredefinedSubSteps(i);
	}

	// Set up abort controller & cancel callback
	_workflowAbortController = new AbortController();
	setWorkflowCancelCallback(() => {
		_workflowAbortController?.abort();
		_workflowRunning = false;
		if (_lastWorkflowCtx) {
			const finalState = buildWidgetState(
				_widgetMode,
				_widgetSteps,
				_widgetCurrentIdx,
				_widgetStartTime,
				"cancelled",
			);
			updateWorkflowWidget(_lastWorkflowCtx, finalState);

			// ── Save final checkpoint before archiving ──
			const cancelCp: CheckpointData = {
				version: 2,
				createdAt: _workflowCreatedAt,
				updatedAt: new Date().toISOString(),
				prompt: _workflowPrompt,
				mode: _widgetMode,
				steps: _widgetSteps.map(s => ({
					status: s.status as WorkflowStepState["status"],
					durationMs: s.durationMs,
					loopCount: s.loopCount,
					error: s.error,
				})),
				currentStepIndex: _widgetCurrentIdx,
				loopCounts: { ..._workflowLoopCounts },
				planFilePath: _workflowPlanFileRelPath,
				taskSummary: extractTaskSummary(_workflowPrompt),
				workflowType: _workflowType,
				fileChanges: [..._workflowFileChanges],
				subAgentRuns: _workflowAgentRunHistory.length,
				filesModified: _workflowFileChanges.filter(c => c.type === "edit").length,
				filesCreated: _workflowFileChanges.filter(c => c.type === "new").length,
				agentRunHistory: [..._workflowAgentRunHistory],
			};
			saveCheckpoint(_workflowCwd, cancelCp);

			// ── Send workflow result message for persistence ──
			if (_workflowPi) {
				sendWorkflowResult(_workflowPi, finalState, _workflowPrompt, _workflowType);
			}

			// ── Archive checkpoint on cancel too ──
			archiveCheckpointFile(_workflowCwd, _workflowPlanFileRelPath);
			setTimeout(() => cleanupWidget(), 5000);
		}
	});

	// Collapse tools to show widget
	ctx.ui.setToolsExpanded(false);

	// ── Register terminal input handler (Esc to cancel) ──
	if (ctx.hasUI) {
		_terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.escape)) return undefined;
			if (_workflowRunning && _workflowAbortController && !_workflowAbortController.signal.aborted) {
				ctx.ui.notify("⏹️ 用户取消工作流", "warning");
				cancelWorkflow();
				return { consume: true };
			}
			return undefined;
		});
	}

	// ── Register signal handlers (SIGINT/SIGTERM) for graceful shutdown ──
	registerSignalHandlers();

	// ── Launch background execution (fire-and-forget) ──
	executeWorkflowBackground(
		ctx, pi, prompt, steps, agentMap, mode, stepStates,
		currentStepIndex, loopCounts, planFileRelPath,
		existingCp ?? undefined,
	).catch((err) => {
		console.error("[workflow] Background execution error:", err);
		_workflowRunning = false;
		if (_lastWorkflowCtx) {
			updateWorkflowWidget(_lastWorkflowCtx, null);
		}
		// Clean up terminal input listener and signal handlers
		if (_terminalInputUnsubscribe) {
			_terminalInputUnsubscribe();
			_terminalInputUnsubscribe = null;
		}
		cleanupSignalHandlers();
	});

	// Return immediately - execution continues in background
}

// ═══════════════════════════════════════════════════════════════
//  Extension factory (no-op — imported by dev-prompts.ts)
// ═══════════════════════════════════════════════════════════════

/**
 * Check if a workflow is currently running.
 */
export function isWorkflowRunning(): boolean {
	return _workflowRunning;
}

/**
 * Cancel the active workflow, if any.
 * Safe to call even when no workflow is running (no-op in that case).
 */
export function cancelActiveWorkflow(): void {
	if (_workflowRunning && _workflowAbortController && !_workflowAbortController.signal.aborted) {
		cancelWorkflow();
	}
}

export default function (_pi: ExtensionAPI) {
	// workflow-engine is a helper module, not a standalone extension.
}
