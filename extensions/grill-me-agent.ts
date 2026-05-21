/**
 * grill-me-agent.ts — 设计评审 (Grill) 和 PRD 生成的独立管理器
 *
 * 职责：
 *   1. runGrillPhase()  — 启动 sub-agent 生成评审问题，TUI 逐题呈现（选项 + 自定义输入）
 *   2. runPRDPhase()    — 启动 sub-agent 生成 PRD，保存到 .pi-dev-output/pi-prd/
 *
 * 关键设计决策（修复 #2）：
 *   sub-agent 通过 `write` 工具将评审问题写入临时文件，主进程事后读取。
 *   不依赖从 NDJSON 响应文本中解析 JSON（多轮 tool-calling 场景不可靠）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { spawnSubagent, extractFinalOutput, discoverAgents, type AgentDef } from "./sub-agents";
export type { AgentDef };
import {
	Container,
	SelectList,
	Text,
	Spacer,
	matchesKey,
	Key,
	truncateToWidth,
	wrapTextWithAnsi,
	type SelectItem,
} from "@earendil-works/pi-tui";
import { uiSelect, uiConfirm, uiInput } from "./ui-helpers";

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

// ── Output dirs ──────────────────────────────────────────────

const DEV_OUTPUT_DIR = ".pi-dev-output";
const GRILL_DIRNAME = "pi-grill";
const GRILL_ANSWERS_DIRNAME = "answers";
const GRILL_QUESTIONS_DIRNAME = "questions";
const PRD_DIRNAME = "pi-prd";

/** Ensure an output subdirectory exists. */
function ensureOutputDir(cwd: string, subdir: string): string {
	const dir = path.join(cwd, DEV_OUTPUT_DIR, subdir);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Format current time as YYYYMMDD-HHmm for human-readable timestamps. */
function formatTimestamp(): string {
	const now = new Date();
	const Y = now.getFullYear().toString();
	const M = (now.getMonth() + 1).toString().padStart(2, "0");
	const D = now.getDate().toString().padStart(2, "0");
	const h = now.getHours().toString().padStart(2, "0");
	const m = now.getMinutes().toString().padStart(2, "0");
	return `${Y}${M}${D}-${h}${m}`;
}

/** Generate a safe temp filename for grill output (pi-grill/questions/questions-<id>-<YYYYMMDD-HHmm>.json). */
function grillOutputPath(cwd: string): string {
	const dir = ensureOutputDir(cwd, path.join(GRILL_DIRNAME, GRILL_QUESTIONS_DIRNAME));
	const ts = Date.now().toString(36);
	return path.join(dir, `questions-${ts}-${formatTimestamp()}.json`);
}

/**
 * Save the final assembled prompt to a timestamped answer file (pi-grill/answers/answer-<id>-<YYYYMMDD-HHmm>.md).
 * Returns the relative path from cwd (for display in notifications).
 */
export function saveAnswerFile(cwd: string, content: string): string {
	const dir = ensureOutputDir(cwd, path.join(GRILL_DIRNAME, GRILL_ANSWERS_DIRNAME));
	const ts = Date.now().toString(36);
	const filename = `answer-${ts}-${formatTimestamp()}.md`;
	fs.writeFileSync(path.join(dir, filename), content, "utf-8");
	return path.join(DEV_OUTPUT_DIR, GRILL_DIRNAME, GRILL_ANSWERS_DIRNAME, filename);
}

/**
 * Find the most recent answer backup file and read its content.
 * Returns undefined if no backup exists or read fails.
 * Now reads from pi-grill/answers/ subdirectory.
 */
export function recoverFromBackup(cwd: string): string | undefined {
	const dir = path.join(cwd, DEV_OUTPUT_DIR, GRILL_DIRNAME, GRILL_ANSWERS_DIRNAME);
	try {
		if (!fs.existsSync(dir)) return undefined;
		const files = fs.readdirSync(dir)
			.filter(f => f.startsWith("answer-") && f.endsWith(".md"))
			.map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		if (files.length === 0) return undefined;
		return fs.readFileSync(path.join(dir, files[0].name), "utf-8");
	} catch {
		return undefined;
	}
}

/** Generate a safe PRD filename. */
function generatePrdFilename(moduleSuggestion: string): string {
	const safe = moduleSuggestion
		.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
	return `${safe || "feature"}-${ts}.md`;
}

// ── Sub-agent definitions ────────────────────────────────────

/**
 * Helper: build the system prompt suffix that tells the sub-agent to
 * write results to a file via the `write` tool instead of putting JSON
 * in its chat response.
 */
function writeToolPromptSuffix(outputFilePath: string): string {
	return [
		"",
		"## Output via `write` tool (CRITICAL)",
		"",
		"Do NOT output the questions JSON in your chat response.",
		"Instead, use the `write` tool to save the questions to a file.",
		`Write to this exact path: ${outputFilePath}`,
		"",
		"The file content must be a **valid** JSON object conforming to this JSON Schema (Draft-07):",
		"",
		"```json",
		'{',
		'  "$schema": "http://json-schema.org/draft-07/schema#",',
		'  "type": "object",',
		'  "required": ["questions"],',
		'  "properties": {',
		'    "questions": {',
		'      "type": "array",',
		'      "items": {',
		'        "type": "object",',
		'        "required": ["id", "question", "options"],',
		'        "properties": {',
		'          "id": { "type": "integer" },',
		'          "question": { "type": "string" },',
		'          "options": {',
		'            "type": "array",',
		'            "items": { "type": "string" },',
		'            "minItems": 1',
		'          }',
		'        }',
		'      }',
		'    }',
		'  }',
		'}',
		"```",
		"",
		"### \u26a0\ufe0f CRITICAL: String escaping rules",
		"",
		"Every string value (question text, option text) MUST be valid JSON-escaped:",
		"- Double quotes inside text \u2192 \\\"",
		"- Newlines \u2192 \\n",
		"- Backslashes \u2192 \\\\",
		"- Tabs \u2192 \\t",
		"",
		"### \u2705 Self-review before writing",
		"",
		"Before calling the `write` tool, mentally validate your JSON.",
		"Check that all strings are properly escaped and the structure matches the schema above.",
		"If you are unsure, write a quick test with `bash` (e.g. `node -e \"JSON.parse(...)\"`).",
		"",
		"Example output:",
		"```json",
		'{',
		'  "questions": [',
		'    {',
		'      "id": 1,',
		'      "question": "\\u9879\\u76ee\\u662f\\u5426\\u5b58\\u5728\\u6a21\\u5757\\u7ed3\\u6784\\uff1f",',
		'      "options": [',
		'        "\\u5df2\\u5b58\\u5728\\uff0c\\u4f8b\\u5982 src/controller/example.rs",',
		'        "\\u4ece\\u96f6\\u521b\\u5efa"',
		'      ]',
		'    },',
		'    {',
		'      "id": 2,',
		'      "question": "\\u4ed6\\u8bf4\\u201c\\u8fd9\\u4e2a\\u4e0d\\u884c\\u201d\\uff0c\\u8be5\\u5982\\u4f55\\u5904\\u7406\\uff1f",',
		'      "options": [',
		'        "\\u5ffd\\u7565",',
		'        "\\u4fee\\u590d"',
		'      ]',
		'    }',
		'  ]',
		'}',
		"```",
		"",
		"After writing, you may include a brief summary in your chat response.",
		"But the JSON MUST be in the file, NOT in the chat.",
	].join("\n");
}

// ── Default agent definitions (loaded from agents/ directory) ────

const _defaultGrillAgent = discoverAgents().find(a => a.name === "dev-grill-agent")!;
const _defaultPrdAgent = discoverAgents().find(a => a.name === "dev-prd-agent")!;

// ── File-based question extraction ───────────────────────────

/**
 * Try to read and parse questions from the output file that the sub-agent
 * was instructed to write via the `write` tool.
 */
function readQuestionsFromFile(filePath: string): GrillQuestion[] {
	try {
		if (!fs.existsSync(filePath)) return [];
		const raw = fs.readFileSync(filePath, "utf-8").trim();
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		// Support both { questions: [...] } and raw [...]
		const items = Array.isArray(parsed) ? parsed : parsed.questions;
		if (!Array.isArray(items)) return [];
		return items
			.filter((q: any) => q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length > 0)
			.map((q: any, i: number) => ({
				id: q.id ?? i + 1,
				question: q.question,
				options: q.options,
			}));
	} catch (e) {
		// Log parse errors for debugging (development feedback)
		try {
			const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8").slice(0, 1000) : "(file not found)";
			console.error(`[grill-me-agent] JSON parse error in ${filePath}:`, (e as Error).message);
			console.error(`[grill-me-agent] First 1000 chars:`, content);
		} catch { /* ignore secondary errors */ }
		return [];
	}
}

/**
 * Parse sub-agent output into a list of GrillQuestions.
 * Used as fallback when the file-based approach didn't produce results.
 */
export function parseGrillQuestions(raw: string): GrillQuestion[] {
	if (!raw || !raw.trim()) return [];

	// Strategy 1: find any {} JSON, deep-search for "questions" key
	const jsonMatch = raw.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		const candidate = jsonMatch[0]
			.replace(/^\s*```(?:json)?\s*/, "")
			.replace(/\s*```\s*$/, "");
		try {
			const parsed = JSON.parse(candidate);
			const found = deepFindQuestions(parsed);
			if (found && found.length > 0) {
				return found
					.filter((q) => q.question && q.options && q.options.length > 0)
					.map((q, i) => ({
						id: q.id ?? i + 1,
						question: q.question!,
						options: q.options!,
					}));
			}
		} catch {
			// fall through
		}
	}

	// Strategy 2: try to find a question-like JSON array directly
	const direct = extractQuestionArray(raw);
	if (direct.length > 0) {
		return direct.map((q, i) => ({ id: i + 1, question: q.question, options: q.options }));
	}

	// Strategy 3: extract from markdown code block
	const codeBlock = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (codeBlock) {
		return parseGrillQuestions(codeBlock[1]);
	}

	return [];
}

function deepFindQuestions(obj: unknown): Array<{ id?: number; question?: string; options?: string[] }> | null {
	if (!obj || typeof obj !== "object") return null;
	if (Array.isArray(obj)) {
		for (const item of obj) {
			const found = deepFindQuestions(item);
			if (found) return found;
		}
		return null;
	}
	const record = obj as Record<string, unknown>;
	if ("questions" in record && Array.isArray(record.questions)) {
		return record.questions as Array<{ id?: number; question?: string; options?: string[] }>;
	}
	for (const val of Object.values(record)) {
		const found = deepFindQuestions(val);
		if (found) return found;
	}
	return null;
}

function extractQuestionArray(raw: string): Array<{ question: string; options: string[] }> {
	const arrayMatch = raw.match(/\[\s*\{[\s\S]*?"question"[\s\S]*?"options"[\s\S]*?\}\s*\]/);
	if (!arrayMatch) return [];
	try {
		const items = JSON.parse(arrayMatch[0]);
		if (!Array.isArray(items)) return [];
		return items.filter((item: unknown): item is { question: string; options: string[] } => {
			if (!item || typeof item !== "object") return false;
			const r = item as Record<string, unknown>;
			return typeof r.question === "string" && Array.isArray(r.options) && r.options.length > 0;
		});
	} catch {
		return [];
	}
}

// ── Grill Phase ──────────────────────────────────────────────

/**
 * Options for customizing the grill phase.
 */
export interface GrillOptions {
	agentDef?: AgentDef;
	title?: string;
	description?: string;
	questionTitle?: string;
	loaderLabel?: string;
}

/**
 * Run the grill phase:
 * 1. Confirm with user
 * 2. Call sub-agent → sub-agent writes questions to a file via `write` tool
 * 3. Read questions from the file
 * 4. Show each question as TUI SelectList + custom input option
 * 5. Collect all Q&A pairs
 * 6. Return enhanced prompt
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

	const agentDef = options?.agentDef ?? _defaultGrillAgent;
	const confirmTitle = options?.title ?? "🔍 设计方案评审";
	const confirmDesc = options?.description ?? "AI 会从架构、数据流、边界条件、安全等多个维度挑战你的设计。";
	const qTitlePrefix = options?.questionTitle ?? "设计方案评审";
	const loaderLabel = options?.loaderLabel ?? "🧠 AI 子代理正在分析代码并生成评审问题...";

	// ── Step 1: Confirm entering grill mode ──────────────────
	const enterGrill = await uiConfirm(ctx, confirmTitle, confirmDesc);
	if (!enterGrill) {
		// Skip grill but continue the workflow (not a cancellation)
		return defaultResult;
	}

	// ── Step 2: Prepare output file + enhanced prompt ─────────
	const outputFilePath = grillOutputPath(ctx.cwd);
	const enhancedPrompt = [
		assembledPrompt,
		writeToolPromptSuffix(outputFilePath),
	].join("\n\n");

	// ── Step 3: Call sub-agent with BorderedLoader ───────────
	const questions = await ctx.ui.custom<GrillQuestion[]>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, loaderLabel);
		loader.onAbort = () => done([]);

		spawnSubagent(
			agentDef,
			enhancedPrompt,
			ctx.cwd,
			loader.signal,
			undefined,
			(progress) => {
					const inner = (loader as unknown as { loader?: { setText?: (t: string) => void } }).loader;
					inner?.setText?.(`🧠 ${progress.slice(0, 60)}`);
				},
		)
			.then((result) => {
				let qs = readQuestionsFromFile(outputFilePath);
				if (qs.length === 0) {
					const output = extractFinalOutput(result.output);
					qs = parseGrillQuestions(output);
				}
				done(qs);
			})
			.catch(() => {
				const qs = readQuestionsFromFile(outputFilePath);
				done(qs);
			});

		return loader;
	});

	// ── Step 4: Retry dialog if no questions generated ──────
	if (questions.length === 0) {
		let failedFileContent = "";
		let parseErrorMsg = "";
		try {
			if (fs.existsSync(outputFilePath)) {
				failedFileContent = fs.readFileSync(outputFilePath, "utf-8").slice(0, 2000);
				JSON.parse(failedFileContent);
			}
		} catch (e) {
			parseErrorMsg = (e as Error).message;
		}

		const choice = await uiSelect(
			ctx,
			"⚠️ AI 未能成功生成评审问题",
			[
				"🔄 重新尝试生成评审问题",
				"⏭️ 跳过 Grill，直接发送 Prompt",
				"❌ 取消 (Esc)",
			],
		);

		switch (choice) {
			case "🔄 重新尝试生成评审问题": {
				const retryPath = grillOutputPath(ctx.cwd);
				const errorFeedback = parseErrorMsg
					? [
						"",
						"### ⚠️ Previous attempt had JSON errors — fix them now",
						"",
						`The previous attempt wrote to \`${outputFilePath}\` but the JSON was invalid.`,
						"",
						`JSON parse error: ${parseErrorMsg}`,
						"",
						"Invalid file content (first 2000 chars):",
						"```",
						failedFileContent.slice(0, 1000),
						"```",
						"",
						"Please write valid JSON to the new path below. Make sure all strings are properly JSON-escaped.",
					].join("\n")
					: "";
				const retryPrompt = [
					assembledPrompt,
					writeToolPromptSuffix(retryPath),
					errorFeedback,
				].filter(Boolean).join("\n\n");
				const retryQuestions = await ctx.ui.custom<GrillQuestion[]>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, loaderLabel);
					loader.onAbort = () => done([]);
					spawnSubagent(agentDef, retryPrompt, ctx.cwd, loader.signal, undefined)
						.then((r) => {
							let qs = readQuestionsFromFile(retryPath);
							if (qs.length === 0) qs = parseGrillQuestions(extractFinalOutput(r.output));
							done(qs);
						})
						.catch(() => done([]));
					return loader;
				});
				if (retryQuestions.length === 0) {
					return defaultResult;
				}
				// Replace questions with retry results (with back support)
				const pairs: Array<{ question: string; answer: string }> = [];
				let rIdx = 0;
				while (rIdx >= 0 && rIdx < retryQuestions.length) {
					const q = retryQuestions[rIdx]!;
					const previousAnswer = pairs[rIdx]?.answer;
					const answer = await showQuestionTUI(ctx, q, rIdx + 1, retryQuestions.length, qTitlePrefix,
						rIdx > 0, previousAnswer);
					if (answer === null) {
						return { ...defaultResult, cancelled: true, pairs };
					}
					if (answer === "__BACK__") {
						if (rIdx > 0) {
							rIdx--;
							continue;
						}
						return { ...defaultResult, cancelled: true, pairs };
					}
					// Overwrite if re-answering, otherwise append
					if (rIdx < pairs.length) {
						pairs[rIdx] = { question: q.question, answer };
					} else {
						pairs.push({ question: q.question, answer });
					}
					rIdx++;
				}
				const qaBlock = pairs
					.map((p, i) => `[评审问题 ${i + 1}]\n问题: ${p.question}\n回答: ${p.answer}`)
					.join("\n\n");
				const finalEnhancedPrompt = [
					assembledPrompt,
					"",
					"---",
					"## 设计评审记录",
					"",
					"以下是在开发前进行的设计评审问答，所有决策已确认：",
					"",
					qaBlock,
				].join("\n");
				return {
					cancelled: false,
					pairs,
					enhancedPrompt: finalEnhancedPrompt,
				};
			}
			case "⏭️ 跳过 Grill，直接发送 Prompt":
				return defaultResult;
			case "❌ 取消 (Esc)":
			default:
				return { ...defaultResult, cancelled: true };
		}
	}

	// ── Step 5: TUI — present questions one by one (with back support) ──
	const pairs: Array<{ question: string; answer: string }> = [];
	let qIdx = 0;

	while (qIdx >= 0 && qIdx < questions.length) {
		const q = questions[qIdx]!;
		const previousAnswer = pairs[qIdx]?.answer;
		const answer = await showQuestionTUI(ctx, q, qIdx + 1, questions.length, qTitlePrefix,
			qIdx > 0, previousAnswer);

		if (answer === null) {
			return { ...defaultResult, cancelled: true, pairs };
		}

		if (answer === "__BACK__") {
			if (qIdx > 0) {
				qIdx--;
				continue;
			}
			return { ...defaultResult, cancelled: true, pairs };
		}

		// Overwrite if re-answering (back then forward), otherwise append
		if (qIdx < pairs.length) {
			pairs[qIdx] = { question: q.question, answer };
		} else {
			pairs.push({ question: q.question, answer });
		}
		qIdx++;
	}

	// ── Step 6: Assemble enhanced prompt ─────────────────────
	const qaBlock = pairs
		.map((p, i) => `[评审问题 ${i + 1}]\n问题: ${p.question}\n回答: ${p.answer}`)
		.join("\n\n");

	const finalEnhancedPrompt = [
		assembledPrompt,
		"",
		"---",
		"## 设计评审记录",
		"",
		"以下是在开发前进行的设计评审问答，所有决策已确认：",
		"",
		qaBlock,
	].join("\n");

	return {
		cancelled: false,
		pairs,
		enhancedPrompt: finalEnhancedPrompt,
	};
}

/**
 * Show a single grill question as TUI SelectList with option items and custom input entry.
 *
 * Navigation:
 *   - ↑↓ 选择, Enter 确认, Esc 取消全部评审
 *   - Ctrl+Shift+← 返回上一题（仅当 backable=true 且 currentIndex > 1 时生效）
 *   - 选择 "✏️ 自定义输入" 进入文本输入模式
 *
 * @param ctx - Extension command context for TUI rendering
 * @param q - The grill question to display
 * @param currentIndex - 1-based index of current question
 * @param totalCount - Total number of questions
 * @param titlePrefix - Prefix for the question title bar
 * @param backable - Whether navigating back to previous question is allowed
 * @param previousAnswer - Previous answer to pre-fill as "上次选择" marker
 * @returns Selected option text, "__BACK__" for back navigation, or null for cancel
 */
async function showQuestionTUI(
	ctx: ExtensionCommandContext,
	q: GrillQuestion,
	currentIndex: number,
	totalCount: number,
	titlePrefix = "设计方案评审",
	backable = false,
	previousAnswer?: string,
): Promise<string | null> {
	// 根据终端宽度计算截断宽度
	const termWidth = process.stdout.columns || 120;
	const maxOptWidth = Math.min(termWidth - 12, 100);
	const selectItems: SelectItem[] = q.options.map((opt, i) => {
		const prefix = `(${String.fromCharCode(97 + i)}) `;
		const label = opt === previousAnswer
			? `${prefix}${opt} - 上次选择`
			: `${prefix}${opt}`;
		const truncated = truncateToWidth(label, maxOptWidth, "...");
		return {
			value: `opt-${i}`,
			label: truncated,
			// 完整文本由下方的预览面板展示（支持换行），description 列无法换行故移除
		};
	});

	const customLabel = previousAnswer && !q.options.includes(previousAnswer)
		? `✏️  自定义输入 - 上次选择`
		: `✏️  自定义输入`;
	selectItems.push({
		value: "__custom__",
		label: customLabel,
		description: "输入你自己的回答，不受选项限制",
	});

	if (backable && currentIndex > 1) {
		selectItems.push({
			value: "__back__",
			label: "← 返回上一题",
		});
	}

	const title = `${titlePrefix} (问题 ${currentIndex}/${totalCount})`;

	const value = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`  ${title}`)), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("text", `  ${q.question}`), 0, 0));
		container.addChild(new Spacer(1));

		const visibleCount = Math.min(selectItems.length + 1, 12);
		const selectList = new SelectList(selectItems, visibleCount, {
			selectedPrefix: (s) => theme.fg("accent", s),
			selectedText: (s) => theme.fg("accent", s),
			description: (s) => theme.fg("muted", s),
			scrollInfo: (s) => theme.fg("dim", s),
			noMatch: (s) => theme.fg("warning", s),
		}, {
			minPrimaryColumnWidth: 30,
			maxPrimaryColumnWidth: maxOptWidth + 2,
			truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "..."),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);

		// 完整选项预览面板（支持换行，展示当前选中选项的完整文本）
		const previewWidth = Math.max(30, termWidth - 8);
		const previewText = new Text("", 0, 0);
		container.addChild(new Spacer(1));
		container.addChild(previewText);

		// 初始化预览为第一个选项
		if (q.options.length > 0) {
			const initialWrapped = wrapTextWithAnsi(q.options[0], previewWidth);
			previewText.setText(
				initialWrapped.map(l => theme.fg("dim", `  ${l}`)).join("\n")
			);
		}

		selectList.onSelectionChange = (item) => {
			if (item.value.startsWith("opt-")) {
				const idx = parseInt(item.value.replace("opt-", ""), 10);
				const fullText = q.options[idx];
				const wrapped = wrapTextWithAnsi(fullText, previewWidth);
				previewText.setText(
					wrapped.map(l => theme.fg("dim", `  ${l}`)).join("\n")
				);
			} else {
				previewText.setText("");
			}
			tui.requestRender();
		};

		container.addChild(new Spacer(1));
		const hint = backable && currentIndex > 1
			? "  ↑↓ 导航 • Enter 选择 • Ctrl+Shift+← 返回上一题 • Esc 取消全部评审"
			: "  ↑↓ 导航 • Enter 选择 • Esc 取消全部评审";
		container.addChild(
			new Text(theme.fg("dim", hint), 0, 0),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				// Ctrl+Shift+← → 返回上一题（SelectList 不处理该键，需自行拦截）
				if (backable && currentIndex > 1 && matchesKey(data, Key.ctrlShift("left"))) {
					done("__BACK__");
					return;
				}
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (value === "__back__") return "__BACK__";
	if (value === null) return null;
	if (value === "__custom__") {
		const custom = await uiInput(ctx, "✏️ 自定义回答",
			previousAnswer && !q.options.includes(previousAnswer)
				? `(上次: ${previousAnswer.slice(0, 60)})`
				: "输入你的回答内容（Esc 取消本题，回到选项）",
			false, true,
			previousAnswer && !q.options.includes(previousAnswer) ? previousAnswer : "",
		);
		if (custom === "__BACK__") return "__BACK__";
		if (custom === undefined) return showQuestionTUI(ctx, q, currentIndex, totalCount, titlePrefix, backable, previousAnswer);
		return custom.trim() || "(空)";
	}

	const optIndex = parseInt(value.replace("opt-", ""), 10);
	return q.options[optIndex] || value;
}

// ── PRD Phase ────────────────────────────────────────────────

/**
 * Run the PRD phase:
 * 1. Ask user if they want to create a PRD
 * 2. Call sub-agent → gets PRD Markdown
 * 3. Save to .pi-dev-output/pi-prd/<name>.md
 * 4. Ask if user wants to start development
 */
export async function runPRDPhase(
	context: string,
	moduleHint: string,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<PRDResult | null> {
	const wantPrd = await uiConfirm(
		ctx,
		"📋 创建 PRD",
		"PRD 将保存到 .pi-dev-output/pi-prd/ 目录。",
	);
	if (!wantPrd) return null;

	const prdContent = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "📝 AI 正在生成 PRD 文档...");
		loader.onAbort = () => done(null);

		const prdTask = [
			"请根据以下上下文生成一份 PRD（产品需求文档）。",
			"输出格式必须是完整的 Markdown 文档。",
			"",
			"=== 上下文 ===",
			context,
		].join("\n");

		spawnSubagent(_defaultPrdAgent, prdTask, ctx.cwd, loader.signal)
			.then((result) => {
				const output = extractFinalOutput(result.output);
				done(output && output.length >= 50 ? output : null);
			})
			.catch(() => done(null));

		return loader;
	});

	if (!prdContent) {
		return null;
	}

	const prdDir = ensureOutputDir(ctx.cwd, PRD_DIRNAME);
	const filename = generatePrdFilename(moduleHint);
	const filePath = path.join(DEV_OUTPUT_DIR, PRD_DIRNAME, filename);
	const fullPath = path.join(prdDir, filename);
	fs.writeFileSync(fullPath, prdContent, "utf-8");

	await askDevelopmentStart(pi, ctx, prdContent, filePath);
	return { content: prdContent, filePath };
}

async function askDevelopmentStart(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	prdContent: string,
	prdFilePath: string,
): Promise<void> {
	const choice = await uiSelect(
		ctx,
		"🚀 是否开始开发？",
		[
			"是 — 根据 PRD 开始开发",
			"否 — 稍后手动开始",
			"✏️ 自定义开发指令",
		],
	);
	if (!choice) return;

	switch (choice) {
		case "是 — 根据 PRD 开始开发": {
			const devMsg = [
				"请根据以下 PRD 文档开始开发：",
				"",
				`PRD 文件: \`${prdFilePath}\``,
				"",
				"--- PRD 全文 ---",
				prdContent,
				"",
				"---",
				"",
				"请按照上述 PRD 逐步实现。先分析代码库结构，给出实施计划，确认后再编写代码。",
			].join("\n");
			pi.sendUserMessage(devMsg, { deliverAs: "followUp" });
			break;
		}
		case "否 — 稍后手动开始":
			break;
		default: {
			const customMsg = await uiInput(ctx, "✏️ 自定义开发指令", "输入你的开发指令（将结合 PRD 一起发送给主代理）");
			if (customMsg === undefined) return askDevelopmentStart(pi, ctx, prdContent, prdFilePath);
			const finalMsg = customMsg.trim()
				? [
					`自定义开发指令: ${customMsg.trim()}`,
					"",
					`PRD 文件: \`${prdFilePath}\``,
					"",
					"--- PRD 全文 ---",
					prdContent,
				].join("\n")
				: [
					"请根据以下 PRD 文档开始开发：",
					"",
					`PRD 文件: \`${prdFilePath}\``,
					"",
					"--- PRD 全文 ---",
					prdContent,
				].join("\n");
			pi.sendUserMessage(finalMsg, { deliverAs: "followUp" });
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
