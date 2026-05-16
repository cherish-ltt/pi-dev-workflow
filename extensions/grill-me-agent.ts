/**
 * grill-me-agent.ts — 设计评审 (Grill) 和 PRD 生成的独立管理器
 *
 * 职责：
 *   1. runGrillPhase()  — 启动 sub-agent 生成评审问题，TUI 逐题呈现（选项 + 自定义输入）
 *   2. runPRDPhase()    — 启动 sub-agent 生成 PRD，保存到 pi-dev-output/pi-prd/
 *   3. 不依赖 dev-prompts.ts 以外的扩展文件（仅从 sub-agents 导入 spawnSubagent）
 *
 * 设计原则：
 *   - 一次性生成全部问题（sub-agent 输出 JSON 数组），然后 TUI 逐题展示
 *   - 每道题都带选项列表 + 自定义输入入口
 *   - 数量由 LLM 自主决定（保持原有 skill 节奏，不设上限）
 *   - 输出目录: pi-dev-output/pi-prd/ + pi-dev-output/pi-review/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { spawnSubagent, extractFinalOutput, type AgentDef } from "./sub-agents";
export type { AgentDef };
import {
	Container,
	SelectList,
	Text,
	Spacer,
	type SelectItem,
} from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────────────────

/** A single grill question returned by the sub-agent. */
export interface GrillQuestion {
	id: number;
	question: string;
	options: string[];
}

/** Result of the grill phase. */
export interface GrillResult {
	/** Whether the user cancelled. */
	cancelled: boolean;
	/** The Q&A pairs collected. */
	pairs: Array<{ question: string; answer: string }>;
	/** Final enriched prompt (original prompt + all Q&A). */
	enhancedPrompt: string;
}

/** Result of the PRD phase. */
export interface PRDResult {
	/** PRD content (Markdown). */
	content: string;
	/** Saved file path (relative to cwd). */
	filePath: string;
}

// ── Sub-agent definitions ────────────────────────────────────

const GRILL_AGENT_DEF: AgentDef = {
	name: "grill-agent",
	description: "Design review agent — interviews the developer about a feature plan",
	tools: ["read", "bash"],
	systemPrompt: [
		"You are an expert design reviewer. Interview the developer relentlessly about every aspect of the feature plan until reaching shared understanding.",
		"",
		"## Rules",
		"- For EACH question, provide recommended answer OPTIONS (a/b/c format) that the user can pick from",
		"- Walk down each branch of the design tree, resolving dependencies between decisions one-by-one",
		"- Be specific — refer to actual code modules, file paths, and architecture decisions",
		"- Explore the codebase (use read/bash tools) when a question can be answered by looking at existing code",
		"- Ask questions about: architecture, data flow, edge cases, security, testing, module boundaries, dependencies, error handling, performance, scalability",
		"- If terminology conflicts with existing project glossary (CONTEXT.md), call it out",
		"- Sharpen fuzzy language — propose precise canonical terms",
		"- Stress-test scenarios with specific edge cases",
		"- Cross-reference with existing code — surface contradictions",
		"",
		"## Output format",
		"Output ALL questions in ONE JSON response. Do NOT include any preamble, explanation, or markdown formatting.",
		"Only output the JSON object.",
		"",
		'```json',
		"{",
		'  "questions": [',
		"    {",
		'      "id": 1,',
		'      "question": "Which module should handle user authentication?",',
		'      "options": ["在 src/auth/login.ts 中新增 — 统一管理认证逻辑", "放到 src/middleware/auth.ts — 拦截器风格", "新建 src/services/auth.ts — 独立服务层"]',
		"    }",
		"  ]",
		"}",
		'```',
		"",
		"## Quantity",
		"Ask as many questions as needed to thoroughly review the design.",
		"Do not artificially limit the number — cover architecture, data flow, edge cases, security, testing, module boundaries, dependencies, error handling, and more.",
		"Typically 15-40 questions for a moderate feature.",
		"",
		"## Language",
		"Questions and options should be in the same language as the feature request (default: Chinese).",
	].join("\n"),
	timeoutMs: 300_000, // 5 min
};

const PRD_AGENT_DEF: AgentDef = {
	name: "prd-agent",
	description: "PRD writer — synthesizes a PRD from conversation context",
	tools: ["read", "bash"],
	systemPrompt: [
		"You are an expert product spec writer.",
		"Your task is to create a PRD from the provided conversation context.",
		"",
		"## Rules",
		"- Do NOT ask any questions — just synthesize what you already know",
		"- Explore the repo to understand the current state of the codebase",
		"- Use the project's domain vocabulary throughout",
		"- Use the template below and output ONLY the Markdown content (no JSON wrapper, no preamble)",
		"",
		"## Template",
		"",
		"# {Feature Name} — PRD",
		"",
		"## Problem Statement",
		"The problem that the user is facing, from the user's perspective.",
		"",
		"## Solution",
		"The solution to the problem, from the user's perspective.",
		"",
		"## User Stories",
		"A numbered list of user stories:",
		"1. As an <actor>, I want a <feature>, so that <benefit>",
		"",
		"## Implementation Decisions",
		"A list of implementation decisions including modules to build/modify, architectural decisions, schema changes, API contracts.",
		"Do NOT include specific file paths or code snippets (may become outdated).",
		"",
		"## Testing Decisions",
		"A description of what makes a good test, which modules will be tested, prior art.",
		"",
		"## Out of Scope",
		"Things explicitly out of scope.",
		"",
		"## Further Notes",
		"Any further notes about the feature.",
	].join("\n"),
	timeoutMs: 300_000,
};

// ── Output directory helpers ─────────────────────────────────

const DEV_OUTPUT_DIR = "pi-dev-output";
const PRD_DIRNAME = "pi-prd";

/** Ensure the PRD output directory and .gitignore exist. */
function ensurePrdOutputDir(cwd: string): string {
	const prdDir = path.join(cwd, DEV_OUTPUT_DIR, PRD_DIRNAME);
	fs.mkdirSync(prdDir, { recursive: true });

	// Write .gitignore to ignore everything inside pi-dev-output
	// but keep the directory trackable via .gitignore itself.
	const gitignorePath = path.join(cwd, DEV_OUTPUT_DIR, ".gitignore");
	try {
		const existing = fs.readFileSync(gitignorePath, "utf-8").trim();
		if (!existing.includes("*")) {
			fs.writeFileSync(gitignorePath, "*\n!.gitignore\n", "utf-8");
		}
	} catch {
		fs.writeFileSync(gitignorePath, "*\n!.gitignore\n", "utf-8");
	}

	return prdDir;
}

/** Generate a safe filename from module name + timestamp. */
function generatePrdFilename(moduleSuggestion: string): string {
	const safe = moduleSuggestion
		.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
	return `${safe || "feature"}-${ts}.md`;
}

// ── JSON parsing ─────────────────────────────────────────────

interface RawGrillOutput {
	questions?: Array<{
		id?: number;
		question?: string;
		options?: string[];
	}>;
}

/** Parse sub-agent output into a list of GrillQuestions. */
export function parseGrillQuestions(raw: string): GrillQuestion[] {
	// Try to find JSON block
	const jsonMatch = raw.match(/\{[\s\S]*"questions"[\s\S]*\}/);
	const body = jsonMatch ? jsonMatch[0] : raw;

	try {
		const parsed: RawGrillOutput = JSON.parse(body);
		if (parsed.questions && Array.isArray(parsed.questions)) {
			return parsed.questions
				.filter((q) => q.question && q.options && q.options.length > 0)
				.map((q, i) => ({
					id: q.id ?? i + 1,
					question: q.question!,
					options: q.options!,
				}));
		}
	} catch {
		// Try to extract from code block
		const codeBlock = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
		if (codeBlock) {
			return parseGrillQuestions(codeBlock[1]);
		}
	}

	return [];
}

// ── Grill Phase ──────────────────────────────────────────────

/**
 * Options for customizing the grill phase.
 */
export interface GrillOptions {
	/** Custom sub-agent definition. Defaults to GRILL_AGENT_DEF. */
	agentDef?: AgentDef;
	/** Title for the confirm dialog (e.g. "🔍 Bug 根因分析评审"). */
	title?: string;
	/** Description for the confirm dialog. */
	description?: string;
	/** Title prefix for each question TUI (e.g. "Bug 根因分析"). */
	questionTitle?: string;
	/** Label shown in the loading state (e.g. "AI 正在分析 Bug 并生成根因问题..."). */
	loaderLabel?: string;
}

/**
 * Run the grill phase:
 * 1. Confirm with user
 * 2. Call sub-agent → gets structured questions
 * 3. Show each question as TUI SelectList + custom input option
 * 4. Collect all Q&A pairs
 * 5. Return enhanced prompt
 */
export async function runGrillPhase(
	assembledPrompt: string,
	ctx: ExtensionCommandContext,
	options?: GrillOptions,
): Promise<GrillResult> {
	const defaultResult: GrillResult = {
		cancelled: false,
		pairs: [],
		enhancedPrompt: assembledPrompt,
	};

	const agentDef = options?.agentDef ?? GRILL_AGENT_DEF;
	const confirmTitle = options?.title ?? "🔍 设计方案评审";
	const confirmDesc = options?.description ?? "是否进入设计评审 (Grill) 模式？\nAI 会从架构、数据流、边界条件、安全等多个维度挑战你的设计。";
	const qTitlePrefix = options?.questionTitle ?? "设计方案评审";
	const loaderLabel = options?.loaderLabel ?? "🧠 AI 正在分析代码并生成评审问题...";

	// ── Step 1: Confirm entering grill mode ──────────────────
	const enterGrill = await ctx.ui.confirm(confirmTitle, confirmDesc);
	if (!enterGrill) {
		return { ...defaultResult, cancelled: true };
	}

	// ── Step 2: Call sub-agent with BorderedLoader ───────────
	const questions = await ctx.ui.custom<GrillQuestion[]>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(
			tui,
			theme,
			loaderLabel,
		);
		loader.onAbort = () => done([]);

		spawnSubagent(
			agentDef,
			assembledPrompt,
			ctx.cwd,
			loader.signal, // use loader's abort signal for cancellation
			undefined,
			(progress) => {
				loader.setText(`🧠 ${progress.slice(0, 60)}`);
			},
		)
			.then((result) => {
				const output = extractFinalOutput(result.output);
				const qs = parseGrillQuestions(output);
				done(qs);
			})
			.catch(() => done([]));

		return loader;
	});

	if (questions.length === 0) {
		ctx.ui.notify("⚠️ AI 未能生成评审问题，跳过 Grill 阶段", "warning");
		return defaultResult;
	}

	ctx.ui.notify(`✅ AI 生成了 ${questions.length} 个评审问题`, "success");

	// ── Step 3: TUI — present questions one by one ───────────
	const pairs: Array<{ question: string; answer: string }> = [];

	for (let idx = 0; idx < questions.length; idx++) {
		const q = questions[idx];
		const answer = await showQuestionTUI(ctx, q, idx + 1, questions.length, qTitlePrefix);

		if (answer === null) {
			// User cancelled the whole grill
			ctx.ui.notify("❌ 评审已取消", "warning");
			return { ...defaultResult, cancelled: true, pairs };
		}

		pairs.push({ question: q.question, answer });
	}

	// ── Step 4: Assemble enhanced prompt ─────────────────────
	const qaBlock = pairs
		.map((p, i) => `[评审问题 ${i + 1}]\n问题: ${p.question}\n回答: ${p.answer}`)
		.join("\n\n");

	const enhancedPrompt = [
		assembledPrompt,
		"",
		"---",
		"## 设计评审记录",
		"",
		"以下是在开发前进行的设计评审问答，所有决策已确认：",
		"",
		qaBlock,
	].join("\n");

	ctx.ui.notify(`✅ 评审完成，共 ${pairs.length} 道问题`, "success");

	return {
		cancelled: false,
		pairs,
		enhancedPrompt,
	};
}

/** Show a single grill question as TUI SelectList + custom input option. */
async function showQuestionTUI(
	ctx: ExtensionCommandContext,
	q: GrillQuestion,
	currentIndex: number,
	totalCount: number,
	titlePrefix = "设计方案评审",
): Promise<string | null> {
	const selectItems: SelectItem[] = q.options.map((opt, i) => ({
		value: `opt-${i}`,
		label: `(${String.fromCharCode(97 + i)}) ${opt}`,
	}));
	// Always add custom input as the last option
	selectItems.push({
		value: "__custom__",
		label: "✏️  自定义输入",
		description: "输入你自己的回答，不受选项限制",
	});

	const title = `${titlePrefix} (问题 ${currentIndex}/${totalCount})`;

	const value = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();

		// Top border
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		// Title
		container.addChild(new Text(theme.fg("accent", theme.bold(`  ${title}`)), 0, 0));
		container.addChild(new Spacer(1));

		// Question text
		container.addChild(new Text(theme.fg("text", `  ${q.question}`), 0, 0));
		container.addChild(new Spacer(1));

		// SelectList
		const visibleCount = Math.min(selectItems.length + 1, 12);
		const selectList = new SelectList(selectItems, visibleCount, {
			selectedPrefix: (s) => theme.fg("accent", s),
			selectedText: (s) => theme.fg("accent", s),
			description: (s) => theme.fg("muted", s),
			scrollInfo: (s) => theme.fg("dim", s),
			noMatch: (s) => theme.fg("warning", s),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);

		// Help text
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				theme.fg("dim", "  ↑↓ 导航 • Enter 选择 • Esc 取消全部评审"),
				0,
				0,
			),
		);

		// Bottom border
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (value === null) return null;

	if (value === "__custom__") {
		// Show custom input dialog
		const custom = await ctx.ui.input("✏️ 自定义回答", {
			placeholder: "输入你的回答内容（Esc 取消本题，回到选项）",
			required: false,
		});
		if (custom === undefined) {
			// Esc on input = go back to same question (re-show)
			return showQuestionTUI(ctx, q, currentIndex, totalCount);
		}
		return custom.trim() || "(空)";
	}

	// Extract the option index from "opt-N"
	const optIndex = parseInt(value.replace("opt-", ""), 10);
	return q.options[optIndex] || value;
}

// ── PRD Phase ────────────────────────────────────────────────

/**
 * Run the PRD phase:
 * 1. Ask user if they want to create a PRD
 * 2. Call sub-agent → gets PRD Markdown
 * 3. Save to pi-dev-output/pi-prd/<name>.md
 * 4. Create .gitignore if not exists
 * 5. Ask if user wants to start development
 */
export async function runPRDPhase(
	context: string,
	moduleHint: string,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<PRDResult | null> {
	// ── Ask ──────────────────────────────────────────────────
	const wantPrd = await ctx.ui.confirm(
		"📋 创建 PRD",
		"是否为此功能创建 PRD 文档？\nPRD 将保存到 pi-dev-output/pi-prd/ 目录。",
	);
	if (!wantPrd) return null;

	// ── Call sub-agent with BorderedLoader ───────────────────
	const prdContent = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(
			tui,
			theme,
			"📝 AI 正在生成 PRD 文档...",
		);
		loader.onAbort = () => done(null);

		const prdTask = [
			"请根据以下上下文生成一份 PRD（产品需求文档）。",
			"输出格式必须是完整的 Markdown 文档。",
			"",
			"=== 上下文 ===",
			context,
		].join("\n");

		spawnSubagent(
			PRD_AGENT_DEF,
			prdTask,
			ctx.cwd,
			loader.signal,
		)
			.then((result) => {
				const output = extractFinalOutput(result.output);
				done(output && output.length >= 50 ? output : null);
			})
			.catch(() => done(null));

		return loader;
	});

	if (!prdContent) {
		ctx.ui.notify("⚠️ PRD 生成失败", "error");
		return null;
	}

	// ── Save to file ─────────────────────────────────────────
	const prdDir = ensurePrdOutputDir(ctx.cwd);
	const filename = generatePrdFilename(moduleHint);
	const filePath = path.join(DEV_OUTPUT_DIR, PRD_DIRNAME, filename);
	const fullPath = path.join(prdDir, filename);

	fs.writeFileSync(fullPath, prdContent, "utf-8");

	ctx.ui.notify(`✅ PRD 已保存到 ${filePath}`, "success");

	// ── Ask about development ────────────────────────────────
	await askDevelopmentStart(pi, ctx, prdContent, filePath);

	return { content: prdContent, filePath };
}

/** Ask user if they want to start development now. */
async function askDevelopmentStart(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	prdContent: string,
	prdFilePath: string,
): Promise<void> {
	const choice = await ctx.ui.select(
		"🚀 是否开始开发？",
		[
			"是 — 根据 PRD 开始开发",
			"否 — 稍后手动开始",
			"✏️ 自定义开发指令",
		],
	);

	if (!choice) return; // Esc = nothing

	switch (choice) {
		case "是 — 根据 PRD 开始开发": {
			const devMsg = [
				`请根据以下 PRD 文档开始开发：`,
				``,
				`PRD 文件: \`${prdFilePath}\``,
				``,
				`--- PRD 全文 ---`,
				prdContent,
				``,
				`---`,
				``,
				`请按照上述 PRD 逐步实现。先分析代码库结构，给出实施计划，确认后再编写代码。`,
			].join("\n");
			pi.sendUserMessage(devMsg);
			ctx.ui.notify("🚀 已发送开发指令给主代理", "success");
			break;
		}
		case "否 — 稍后手动开始":
			ctx.ui.notify(
				`📋 PRD 已保存在 ${prdFilePath}，可随时手动引用`,
				"info",
			);
			break;
		default: {
			// "✏️ 自定义开发指令"
			const customMsg = await ctx.ui.input("✏️ 自定义开发指令", {
				placeholder: "输入你的开发指令（将结合 PRD 一起发送给主代理）",
				required: false,
			});
			if (customMsg === undefined) {
				// Esc → ask again
				return askDevelopmentStart(pi, ctx, prdContent, prdFilePath);
			}
			const finalMsg = customMsg.trim()
				? [
					`自定义开发指令: ${customMsg.trim()}`,
					``,
					`PRD 文件: \`${prdFilePath}\``,
					``,
					`--- PRD 全文 ---`,
					prdContent,
				].join("\n")
				: [
					`请根据以下 PRD 文档开始开发：`,
					``,
					`PRD 文件: \`${prdFilePath}\``,
					``,
					`--- PRD 全文 ---`,
					prdContent,
				].join("\n");
			pi.sendUserMessage(finalMsg);
			ctx.ui.notify("🚀 已发送自定义开发指令给主代理", "success");
			break;
		}
	}
}

// ── Extension factory (required by pi extension loader) ─────
//
// This file lives in extensions/ so pi will attempt to load it.
// The default export satisfies the loader; the real functionality
// is consumed by dev-prompts.ts via named imports.
//
export default function (_pi: ExtensionAPI) {
	// grill-me-agent is a helper module, not a standalone extension.
	// It is imported by dev-prompts.ts to provide grill + PRD phases.
}

