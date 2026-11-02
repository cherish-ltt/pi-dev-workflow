/**
 * Pre-Check Extension
 *
 * 提供 `/dev-pre-check` 命令：在真正执行任务前插入一道「意图校验」闸门。
 *
 * 流程：
 *   1. 取用户原始 prompt（命令参数，缺省则弹输入框）
 *   2. 组合提示词 =「用户原始 prompt」+ 每次读取的 prompt-check 技能指导，
 *      并把本轮任务意图改成「只做意图理解，不产生任何实质改动」
 *   3. 使用默认可用的 dev_ask 工具：模型把关键不确定项做成「题目 + 选项」问用户
 *   4. 等待代理给出复述（代理空闲 + 本轮新增的 assistant 文本）
 *   5. 用户确认意图：正确 → 开始真正的工作；补充 → 并入意图后直接开工（不重新复述）；
 *      不正确 → 补充说明后重新复述；取消 → 结束
 *   6. 确认后，把「原始 prompt + 已确认的意图复述（含补充）」投递给代理开始执行
 *
 * 补全排序：命令名补全的模糊分数在 /dev* 之间相同，同分回落到扩展文件顺序，
 * 所以本扩展在 session_start 时包装一层补全 provider，把 /dev-pre-check 提到最前。
 *
 * confirmIntent() 是上述 2-5 步的通用实现，/dev-feat 等 dev 命令同样复用：
 * 它们把已确认的意图接进自己组装的提示词，而不是另造一套意图识别。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { uiInput, uiSelect } from "./ui-helpers";
import { getLastAssistantTextAfter } from "./session-utils";

// ── 提示词组装 ────────────────────────────────────────────────

/** 组装意图校验提示词：原始 prompt + 技能指导（+ 历史修正说明）。 */
export function buildPreCheckPrompt(originalPrompt: string, corrections: string[]): string {
	const lines: string[] = [
		"[pre-check] 任务意图校验：只复述，不执行",
		"",
		"## 用户原始 prompt（原文）",
		originalPrompt,
		"",
		"## prompt-check 技能指导",
		readFileSync(join(__dirname, "..", "skills", "prompt-check", "SKILL.md"), "utf-8"),
		"",
		"本轮只执行技能的确认前只读分析；关键问题优先使用 dev_ask。报告完成后立即停止，由命令界面负责确认，不要自行请求确认或执行任务。",
	];

	if (corrections.length > 0) {
		lines.push(
			"",
			"## 用户对上一次复述的修正（必须吸收）",
			...corrections.map((c, i) => `${i + 1}. ${c}`),
		);
	}

	return lines.join("\n");
}

/** 组装确认后的执行提示词：原始 prompt + 已确认的意图复述。 */
export function buildExecutionPrompt(originalPrompt: string, intent: string): string {
	return [
		"[execute] 意图已确认，开始执行",
		"",
		"## 用户原始 prompt（原文，权威需求）",
		originalPrompt,
		"",
		"## 已由用户确认的任务意图",
		intent,
		"",
		"## 要求",
		"- 现在开始执行用户原始 prompt 描述的工作。",
		"- 以上已确认意图是本任务的权威前提；与你的理解冲突时，以该意图为准。",
		"- 执行前若仍需澄清，先向我提问，不要臆测。",
	].join("\n");
}

// ── 意图确认循环 ─────────────────────────────────────────────

const PRE_CHECK_TIMEOUT_MS = 20 * 60_000;

/** 整个复述环节的绝对上限：dev_ask 等交互期间不计时，但不能无限等下去。 */
const PRE_CHECK_MAX_WAIT_MS = 30 * 60_000;

const OPT_ACCEPT = "是 — 意图正确，开始执行";
const OPT_ACCEPT_WITH_NOTE = "是 + 补充 — 补充说明后直接开工（不重新复述）";
const OPT_REDO = "否 — 意图不正确，我要补充说明后重新分析";
const OPT_CANCEL = "取消";

/** 确认结果：已确认的意图，或需要重新复述的修正说明。 */
type Decision = { intent: string } | { correction: string };

function withSupplement(intent: string, supplement: string): string {
	return [intent, "", "### 用户补充（已确认，直接采纳，不需重新复述）", supplement].join("\n");
}

/** 复述后的确认环节：接受、补充后直接开工、或补充后重新复述。 */
async function resolveDecision(ctx: ExtensionCommandContext, intent: string): Promise<Decision | undefined> {
	for (;;) {
		const decision = await uiSelect(ctx, "意图确认：以上复述是否准确反映你的目标？", [
			OPT_ACCEPT,
			OPT_ACCEPT_WITH_NOTE,
			OPT_REDO,
			OPT_CANCEL,
		]);

		if (!decision || decision === OPT_CANCEL) return undefined;
		if (decision === OPT_ACCEPT) return { intent };

		const supplement = decision === OPT_ACCEPT_WITH_NOTE;
		const note = await uiInput(
			ctx,
			supplement ? "补充说明（并入意图，不重新复述）" : "补充/修正说明",
			supplement ? "如 只改后端，别动前端" : "说明哪里理解错了、遗漏了什么",
			supplement,
		);
		if (note === undefined) continue; // Esc → 退回确认选项

		const text = note.trim();
		if (supplement) return { intent: withSupplement(intent, text) };
		return { correction: text || "（用户未提供具体说明，请重新检查复述）" };
	}
}

/**
 * 等待本轮复述产物：代理忙碌（正在执行工具、或在 dev_ask 上等用户作答）期间不计超时。
 * 用 pollFor 的绝对超时会把「模型正在提问」误判成「未获取到复述」。
 * 同时保留一个绝对上限，避免代理一直不空闲时无限等待。
 */
async function waitForRestatement(ctx: ExtensionCommandContext, sentAt: number): Promise<string | undefined> {
	const startedAt = Date.now();
	let deadline = startedAt + PRE_CHECK_TIMEOUT_MS;

	for (;;) {
		if (Date.now() - startedAt > PRE_CHECK_MAX_WAIT_MS) return undefined;

		if (ctx.isIdle()) {
			const text = getLastAssistantTextAfter(ctx, sentAt);
			if (text) return text;
			if (Date.now() > deadline) return undefined;
		} else {
			deadline = Date.now() + PRE_CHECK_TIMEOUT_MS;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

/**
 * 复述 → 确认 →（必要时）修正 的意图确认循环。
 * 返回已确认的意图复述（可能含用户补充）；用户取消或始终未取到复述时返回 undefined。
 */
export async function confirmIntent(
	task: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<string | undefined> {
	const corrections: string[] = [];

	for (;;) {
		ctx.ui.notify("正在让代理复述任务意图（只分析，不执行）...", "info");
		const sentAt = Date.now();
		pi.sendUserMessage(buildPreCheckPrompt(task, corrections), { deliverAs: "followUp" });

		// 完成标志：代理空闲且本轮产生了新的 assistant 文本。
		// 不依赖 waitForIdle —— 它可能在 followUp 触发的新 turn 开始前就返回。
		const intent = await waitForRestatement(ctx, sentAt);

		if (!intent) {
			const retry = await uiSelect(ctx, "未获取到代理的意图复述", ["重试", "取消"]);
			if (retry === "重试") continue;
			return undefined;
		}

		const decision = await resolveDecision(ctx, intent);
		if (!decision) return undefined;
		if ("intent" in decision) return decision.intent;
		corrections.push(decision.correction);
	}
}

// ── 流程 ─────────────────────────────────────────────────────

async function runPreCheck(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/dev-pre-check 需要交互式界面才能确认意图", "error");
		return;
	}

	let originalPrompt = args.trim();
	if (!originalPrompt) {
		const input = await uiInput(
			ctx,
			"待校验的需求（原始 prompt）",
			"输入你希望 AI 先复述确认的需求原文",
			true,
		);
		if (input === undefined) return;
		originalPrompt = input.trim();
		if (!originalPrompt) return;
	}

	const intent = await confirmIntent(originalPrompt, ctx, pi);
	if (!intent) {
		ctx.ui.notify("已取消，未执行任何改动", "info");
		return;
	}

	pi.sendUserMessage(buildExecutionPrompt(originalPrompt, intent), { deliverAs: "followUp" });
	ctx.ui.notify("意图已确认，开始执行", "info");
}

// ── 补全优先排序 ─────────────────────────────────────────────

/**
 * 补全列表里优先排到最前的命令。
 * 值是命令名（不带前导斜杠），与补全项 value 的形态一致。
 */
const PRIORITY_COMMANDS = ["dev-pre-check"];

/**
 * 包一层补全 provider：命令名补全时把 PRIORITY_COMMANDS 提到最前。
 * 命令名的模糊匹配分数对所有 /dev* 命令相同，排序此时回落到注册顺序（= 扩展文件名顺序），
 * 所以只能在这里显式提权。
 */
function withPriorityCommands(current: AutocompleteProvider): AutocompleteProvider {
	const priorityOf = (value: string): number => {
		const index = PRIORITY_COMMANDS.indexOf(value);
		return index === -1 ? PRIORITY_COMMANDS.length : index;
	};

	const wrapped: AutocompleteProvider = {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			// 只处理命令名补全（prefix 形如 "/dev"）；参数与路径补全保持原序。
			if (!suggestions || !suggestions.prefix.startsWith("/") || suggestions.prefix.includes(" ")) {
				return suggestions;
			}
			if (!suggestions.items.some((item) => PRIORITY_COMMANDS.includes(item.value))) return suggestions;
			return {
				...suggestions,
				items: [...suggestions.items].sort((a, b) => priorityOf(a.value) - priorityOf(b.value)),
			};
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
			current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
	};

	if (current.triggerCharacters) wrapped.triggerCharacters = current.triggerCharacters;
	if (current.shouldTriggerFileCompletion) {
		wrapped.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol) =>
			current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol);
	}

	return wrapped;
}

// ── Extension ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("dev-pre-check", {
		description: "(pre-check) 先让 AI 复述任务意图并确认，确认正确后再开始真正的工作",
		handler: async (args, ctx) => {
			await runPreCheck(pi, ctx, args);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider(withPriorityCommands);
	});
}
