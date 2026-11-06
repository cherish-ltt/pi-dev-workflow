/**
 * grill-me-agent.ts — 设计追问（Grill）与 PRD 生成的运行时（运行在当前代理中）
 *
 * 职责：
 *   1. 注册 /grill 与 /grill-resume 命令 — 打磨方案、暂停恢复、保存问答并可选交给当前代理
 *   2. 注册 /prd 命令   — 按需求描述生成 PRD，保存到 .pi-dev-output/pi-prd/
 *   3. runGrillPhase()  — 由当前代理生成评审问题，TUI 逐题呈现（选项 + 自定义输入）
 *   4. runPRDPhase()    — 由当前代理生成 PRD，并询问是否立即开始开发
 *
 * 这些命令不依附于 /dev-* 命令。
 *
 * 与旧版的区别：不再创建隔离的子代理进程，而是把追问/PRD 任务交给当前代理执行。
 * 当前模型普遍具备 >=1M 上下文窗口，无需通过子代理隔离上下文。
 *
 * 关键设计：
 *   当前代理通过 `write` 工具将结果写入临时文件，主进程事后读取。
 *   不依赖从响应文本中解析 JSON（多轮 tool-calling 场景不可靠）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
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
import { uiSelect, uiConfirm, uiInput, uiTaskArg } from "./ui-helpers";
import { pollFor, getLastAssistantTextAfter } from "./session-utils";

// ── Types ────────────────────────────────────────────────────

/** A single grill question returned by the agent. */
export interface GrillQuestion {
	id: number;
	question: string;
	options: string[];
}

/** Result of the grill phase. */
export interface GrillResult {
	/** Whether the user cancelled. */
	cancelled: boolean;
	paused?: boolean;
	/** The Q&A pairs collected. */
	pairs: Array<{ question: string; answer: string }>;
	/** Final enriched prompt (original prompt + all Q&A). */
	enhancedPrompt: string;
}

interface GrillDraft {
	version: 1;
	projectPath: string;
	savedAt: string;
	plan: string;
	questions: GrillQuestion[];
	pairs: GrillResult["pairs"];
	currentIndex: number;
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
const GRILL_DRAFT_PATH = path.join(DEV_OUTPUT_DIR, GRILL_DIRNAME, "draft.json");
const PAUSE_GRILL = Symbol("pause");
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

function readDraftContent(cwd: string): string | undefined {
	try {
		return fs.readFileSync(path.join(cwd, GRILL_DRAFT_PATH), "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function validateGrillDraft(value: unknown, cwd: string): GrillDraft {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("草稿格式无效");
	const draft = value as Record<string, unknown>;
	if (draft.version !== 1) throw new Error("不支持的草稿版本");
	if (draft.projectPath !== fs.realpathSync(cwd)) throw new Error("草稿所属项目与当前项目不匹配");
	if (Object.keys(draft).sort().join(",") !== "currentIndex,pairs,plan,projectPath,questions,savedAt,version"
		|| typeof draft.savedAt !== "string" || !Number.isFinite(Date.parse(draft.savedAt))
		|| new Date(draft.savedAt).toISOString() !== draft.savedAt
		|| typeof draft.plan !== "string" || !draft.plan.trim()
		|| !Array.isArray(draft.questions) || draft.questions.length === 0
		|| !Array.isArray(draft.pairs) || draft.pairs.length > draft.questions.length
		|| !Number.isSafeInteger(draft.currentIndex) || (draft.currentIndex as number) < 0
		|| (draft.currentIndex as number) > draft.pairs.length) throw new Error("草稿字段或问答位置无效");
	const questions = draft.questions as GrillQuestion[];
	if (!questions.every((question) => question && typeof question === "object"
		&& Object.keys(question).sort().join(",") === "id,options,question"
		&& Number.isSafeInteger(question.id) && typeof question.question === "string" && question.question.trim()
		&& Array.isArray(question.options) && question.options.length > 0
		&& question.options.every((option) => typeof option === "string" && option.trim()))
		|| new Set(questions.map((question) => question.id)).size !== questions.length
		|| !draft.pairs.every((pair, index) => pair && typeof pair === "object"
			&& Object.keys(pair).sort().join(",") === "answer,question"
			&& pair.question === questions[index].question && typeof pair.answer === "string" && pair.answer.trim())) {
		throw new Error("草稿题目、选项或答案对应关系无效");
	}
	return draft as unknown as GrillDraft;
}

function writeGrillDraft(cwd: string, draft: GrillDraft): void {
	validateGrillDraft(draft, cwd);
	const directory = ensureOutputDir(cwd, GRILL_DIRNAME);
	const temporaryPath = path.join(directory, `.draft-${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(temporaryPath, JSON.stringify(draft, null, 2) + "\n", { encoding: "utf-8", flag: "wx", mode: 0o600 });
		fs.renameSync(temporaryPath, path.join(cwd, GRILL_DRAFT_PATH));
	} catch (error) {
		try {
			fs.rmSync(temporaryPath, { force: true });
		} catch (cleanupError) {
			throw new Error(`${String(error)}；临时草稿清理失败：${String(cleanupError)}`);
		}
		throw error;
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

// ── File-based result extraction ─────────────────────────────

/**
 * Helper: build the system prompt suffix that tells the agent to
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
		"### ⚠️ CRITICAL: String escaping rules",
		"",
		"Every string value (question text, option text) MUST be valid JSON-escaped:",
		"- Double quotes inside text \u2192 \\\"",
		"- Newlines → \\n",
		"- Backslashes → \\\\",
		"- Tabs → \\t",
		"",
		"### ✅ Self-review before writing",
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
		'      "question": "\\u4ed6\\u8bf4\\u201c\\u8fd9\\u4e2a\\u4e88\\u884c\\u201d\\uff0c\\u8be5\\u5982\\u4f55\\u5904\\u7406\\uff1f",',
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

/**
 * Try to read and parse questions from the output file that the agent
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
 * Parse agent output into a list of GrillQuestions.
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
	title?: string;
	description?: string;
	questionTitle?: string;
}

/**
 * Run the grill phase:
 * 1. Confirm with user
 * 2. Send task to current agent → agent writes questions to a file via `write` tool
 * 3. Read questions from the file
 * 4. Show each question as TUI SelectList + custom input option
 * 5. Collect all Q&A pairs
 * 6. Return enhanced prompt
 */
export async function runGrillPhase(
	assembledPrompt: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	options?: GrillOptions,
): Promise<GrillResult> {
	const defaultResult: GrillResult = {
		cancelled: false,
		pairs: [],
		enhancedPrompt: assembledPrompt,
	};

	const confirmTitle = options?.title ?? "🔍 设计方案追问完善";
	const confirmDesc = options?.description ?? "AI 会通过系统性追问帮你打磨方案：从术语精确化到边界条件验证，确保架构决策的每个分支都经过推敲。";
	const qTitlePrefix = options?.questionTitle ?? "设计方案追问完善";

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

	// ── Step 3: Ask current agent to generate questions ──────
	ctx.ui.notify("🧠 已提交给当前代理生成追问问题，请稍候...", "info");
	const sentAt = Date.now();
	pi.sendUserMessage(enhancedPrompt, { deliverAs: "followUp" });

	let questions = (await pollFor(() => {
		const qs = readQuestionsFromFile(outputFilePath);
		if (qs.length) return qs;
		const parsed = parseGrillQuestions(getLastAssistantTextAfter(ctx, sentAt));
		return parsed.length ? parsed : undefined;
	}, 5 * 60_000)) || [];

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
			"⚠️ AI 未能成功生成追问问题",
			[
				"🔄 重新尝试生成追问问题",
				"⏭️ 跳过 Grill，直接发送 Prompt",
				"❌ 取消 (Esc)",
			],
		);

		switch (choice) {
			case "🔄 重新尝试生成追问问题": {
				const retryPath = grillOutputPath(ctx.cwd);
				const retryPrompt = [
					assembledPrompt,
					writeToolPromptSuffix(retryPath),
					parseErrorMsg
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
						: "",
				].filter(Boolean).join("\n\n");

				const retrySentAt = Date.now();
				pi.sendUserMessage(retryPrompt, { deliverAs: "followUp" });

				const retryQuestions = (await pollFor(() => {
					const qs = readQuestionsFromFile(retryPath);
					if (qs.length) return qs;
					const parsed = parseGrillQuestions(getLastAssistantTextAfter(ctx, retrySentAt));
					return parsed.length ? parsed : undefined;
				}, 5 * 60_000)) || [];
				if (retryQuestions.length === 0) {
					return defaultResult;
				}

				// Replace questions with retry results (with back support)
				questions = retryQuestions;
				break;
			}
			case "⏭️ 跳过 Grill，直接发送 Prompt":
				return defaultResult;
			case "❌ 取消 (Esc)":
			default:
				return { ...defaultResult, cancelled: true };
		}
	}

	return runGrillQuestions(assembledPrompt, questions, ctx, qTitlePrefix);
}

async function runGrillQuestions(
	plan: string,
	questions: GrillQuestion[],
	ctx: ExtensionCommandContext,
	title: string,
	resume?: { draft: GrillDraft; content: string },
): Promise<GrillResult> {
	const pairs = resume ? resume.draft.pairs.map((pair) => ({ ...pair })) : [];
	let qIdx = resume?.draft.currentIndex ?? 0;

	while (qIdx >= 0 && qIdx < questions.length) {
		const q = questions[qIdx]!;
		const previousAnswer = pairs[qIdx]?.answer;
		const answer = await showQuestionTUI(ctx, q, qIdx + 1, questions.length, title,
			qIdx > 0, previousAnswer);

		if (answer === null) {
			return { cancelled: true, pairs, enhancedPrompt: plan };
		}

		if (answer === PAUSE_GRILL) {
			try {
				const existingContent = readDraftContent(ctx.cwd);
				if (existingContent !== undefined && existingContent !== resume?.content) {
					const choice = await uiSelect(ctx,
						`已有草稿：${GRILL_DRAFT_PATH}。保留后可取消当前问卷，再用 /grill-resume 恢复。`,
						["保留已有草稿，继续当前问卷", "替换为当前问卷并暂停"]);
					if (choice !== "替换为当前问卷并暂停") continue;
				}
				writeGrillDraft(ctx.cwd, {
					version: 1,
					projectPath: fs.realpathSync(ctx.cwd),
					savedAt: new Date().toISOString(),
					plan,
					questions,
					pairs,
					currentIndex: qIdx,
				});
				ctx.ui.notify(`问卷已暂停并保存：${GRILL_DRAFT_PATH}（当前第 ${qIdx + 1}/${questions.length} 题，已答 ${pairs.length} 题）。在本项目使用 /grill-resume 继续。`, "info");
				return { cancelled: false, paused: true, pairs, enhancedPrompt: plan };
			} catch (error) {
				ctx.ui.notify(`草稿保存失败，仍停留当前题，之前的草稿未替换：${error instanceof Error ? error.message : String(error)}`, "error");
				continue;
			}
		}

		if (answer === "__BACK__") {
			if (qIdx > 0) {
				qIdx--;
				continue;
			}
			return { cancelled: true, pairs, enhancedPrompt: plan };
		}

		if (qIdx < pairs.length) {
			pairs[qIdx] = { question: q.question, answer };
		} else {
			pairs.push({ question: q.question, answer });
		}
		qIdx++;
	}

	const qaBlock = pairs
		.map((p, i) => `[追问问题 ${i + 1}]\n问题: ${p.question}\n回答: ${p.answer}`)
		.join("\n\n");

	const finalEnhancedPrompt = [
		plan,
		"",
		"---",
		"## 方案追问记录",
		"",
		"以下是在开发前进行的追问式方案打磨记录，所有决策已确认：",
		"",
		qaBlock,
	].join("\n");

	return {
		cancelled: false,
		pairs,
		enhancedPrompt: finalEnhancedPrompt,
	};
}

async function completeGrill(
	result: GrillResult,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	draftContent?: string,
): Promise<void> {
	if (result.paused) return;
	if (result.cancelled) {
		ctx.ui.notify("已取消追问，本轮新增进度未保存，已有草稿未作修改；未发送执行方案的请求", "info");
		return;
	}
	if (result.pairs.length === 0) {
		ctx.ui.notify("未完成追问，未发送执行方案的请求", "info");
		return;
	}

	let answerPath: string;
	try {
		answerPath = saveAnswerFile(ctx.cwd, result.enhancedPrompt);
	} catch (error) {
		ctx.ui.notify(`方案保存失败，草稿未作修改，未发送执行请求：${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	ctx.ui.notify(`完整方案已保存：${answerPath}`, "info");
	if (draftContent !== undefined) {
		try {
			const currentContent = readDraftContent(ctx.cwd);
			if (currentContent === draftContent) fs.unlinkSync(path.join(ctx.cwd, GRILL_DRAFT_PATH));
			else if (currentContent !== undefined) ctx.ui.notify(`草稿已变化，保留当前文件：${GRILL_DRAFT_PATH}`, "warning");
		} catch (error) {
			ctx.ui.notify(`完整方案已归档，但草稿清理失败：${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}
	const choice = await uiSelect(ctx, `追问完成，归档：${answerPath}`, ["仅保存", "保存并发送"]);
	if (choice !== "保存并发送") return;
	try {
		pi.sendUserMessage(result.enhancedPrompt, { deliverAs: "followUp" });
		ctx.ui.notify(`已请求向当前代理发送方案；归档保留：${answerPath}。若 Pi 报告发送失败，可从该文件重试。`, "info");
	} catch (error) {
		ctx.ui.notify(`方案发送失败：${error instanceof Error ? error.message : String(error)}。归档已保留：${answerPath}`, "error");
	}
}

/**
 * Show a single grill question as TUI SelectList with option items and custom input entry.
 *
 * Navigation:
 *   - ↑↓ 选择, Enter 确认, Esc 取消全部评审
 *   - Ctrl+Shift+← 返回上一题（仅当 backable=true 且 currentIndex > 1 时生效）
 *   - 选择 "✏️ 自定义输入" 进入文本输入模式
 */
async function showQuestionTUI(
	ctx: ExtensionCommandContext,
	q: GrillQuestion,
	currentIndex: number,
	totalCount: number,
	titlePrefix = "设计方案追问完善",
	backable = false,
	previousAnswer?: string,
): Promise<string | typeof PAUSE_GRILL | null> {
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
	selectItems.push({ value: "__pause__", label: "暂停并保存草稿" });

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
			? "  ↑↓ 导航 • Enter 选择 • Ctrl+Shift+← 返回上一题 • Esc 取消全部追问"
			: "  ↑↓ 导航 • Enter 选择 • Esc 取消全部追问";
		container.addChild(
			new Text(theme.fg("dim", hint), 0, 0),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
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
	if (value === "__pause__") return PAUSE_GRILL;
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
 * 2. Call current agent → gets PRD Markdown
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

	const prdDir = ensureOutputDir(ctx.cwd, PRD_DIRNAME);
	const filename = generatePrdFilename(moduleHint);
	const filePath = path.join(DEV_OUTPUT_DIR, PRD_DIRNAME, filename);
	const fullPath = path.join(prdDir, filename);

	const prdTask = [
		"请根据以下上下文生成一份 PRD（产品需求文档）。",
		"输出格式必须是完整的 Markdown 文档。",
		"",
		"=== 上下文 ===",
		context,
		"",
		`请使用 write 工具将完整 PRD 写入以下路径: ${fullPath}`,
		"不要在聊天中输出全文，只需确认写入完成。",
	].join("\n");

	ctx.ui.notify("📝 已提交给当前代理生成 PRD，请稍候...", "info");
	const sentAt = Date.now();
	pi.sendUserMessage(prdTask, { deliverAs: "followUp" });

	const prdContent = (await pollFor(() => {
		let c = "";
		try {
			c = fs.readFileSync(fullPath, "utf-8").trim();
		} catch { /* file not written yet */ }
		if (c) return c;
		return getLastAssistantTextAfter(ctx, sentAt) || undefined;
	}, 5 * 60_000)) || "";

	if (!prdContent || prdContent.length < 50) {
		ctx.ui.notify("❌ PRD 生成失败：未获取到有效 PRD 内容，请查看当前代理的回复后重试。", "error");
		return null;
	}

	// Fallback: if the agent chatted the PRD instead of writing it, persist it ourselves.
	if (!fs.existsSync(fullPath)) {
		fs.writeFileSync(fullPath, prdContent, "utf-8");
	}

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

// ── Extension factory ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("grill", {
		description: "(grill) 提交前追问式打磨方案 — 保存原方案与问答，可选发送给当前代理",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/grill 需要交互式界面", "error");
				return;
			}

			const plan = await uiTaskArg(
				ctx,
				args,
				"待打磨的方案 / 任务描述（必填）",
				"如 实现邮箱密码登录：注册、登录、会话保持",
			);
			if (!plan) return;

			const result = await runGrillPhase(plan, ctx, pi, {
				title: "方案追问完善",
				description: "AI 会针对方案逐题追问：术语精确化、边界条件、失败路径、验证方式。",
				questionTitle: "方案追问完善",
			});
			await completeGrill(result, ctx, pi);
		},
	});

	pi.registerCommand("grill-resume", {
		description: "(grill-resume) 恢复本项目主动保存的追问草稿",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/grill-resume 需要交互式界面", "error");
				return;
			}
			let content: string;
			let draft: GrillDraft;
			try {
				const savedContent = readDraftContent(ctx.cwd);
				if (savedContent === undefined) {
					ctx.ui.notify(`没有已保存的追问草稿：${GRILL_DRAFT_PATH}`, "info");
					return;
				}
				content = savedContent;
				draft = validateGrillDraft(JSON.parse(content), ctx.cwd);
			} catch (error) {
				ctx.ui.notify(`无法恢复草稿：${error instanceof Error ? error.message : String(error)}。文件未作修改：${GRILL_DRAFT_PATH}`, "error");
				return;
			}
			const position = draft.currentIndex === draft.questions.length
				? "全部问题已答，恢复后进入保存/发送选择"
				: `当前第 ${draft.currentIndex + 1}/${draft.questions.length} 题`;
			const confirmed = await uiConfirm(ctx, "恢复追问草稿", [
				`原方案：${draft.plan.slice(0, 240)}${draft.plan.length > 240 ? "…" : ""}`,
				`保存时间：${draft.savedAt}`,
				`${position}；已答 ${draft.pairs.length}/${draft.questions.length} 题。`,
				"恢复历史问答，不会重新出题；请自行确认历史判断仍符合当前项目。",
			].join("\n"));
			if (!confirmed) return;
			const result = await runGrillQuestions(draft.plan, draft.questions, ctx, "方案追问完善", { draft, content });
			await completeGrill(result, ctx, pi, content);
		},
	});

	pi.registerCommand("prd", {
		description: "(prd) 按需求描述生成 PRD 文档，并可选直接开始开发",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/prd 需要交互式界面", "error");
				return;
			}

			const requirement = await uiTaskArg(
				ctx,
				args,
				"PRD 需求描述（必填）",
				"如 支持邮箱密码注册登录，含密码重置",
			);
			if (!requirement) return;

			await runPRDPhase(requirement, requirement.split("\n")[0] || "feature", pi, ctx);
		},
	});
}
