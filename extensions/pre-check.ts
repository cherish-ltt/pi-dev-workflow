/**
 * Pre-Check Extension
 *
 * 提供 `/dev-pre-check` 命令：在真正执行任务前插入一道「意图校验」闸门。
 *
 * 流程：
 *   1. 取用户原始 prompt（命令参数，缺省则弹输入框）
 *   2. 组合提示词 =「用户原始 prompt」+ 固定的「用自己的话重述目标与问题」指令，
 *      并把本轮任务意图改成「只做意图理解，不产生任何实质改动」
 *   3. 等待代理给出复述（代理空闲 + 本轮新增的 assistant 文本）
 *   4. 用户确认意图：正确 → 开始真正的工作；不正确 → 补充说明后重新复述；取消 → 结束
 *   5. 确认正确后，把「原始 prompt + 已确认的意图复述」投递给代理开始执行
 *
 * confirmIntent() 是上述 2-4 步的通用实现，/dev-feat 等 dev 命令同样复用：
 * 它们把已确认的意图接进自己组装的提示词，而不是另造一套意图识别。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { uiInput, uiSelect } from "./ui-helpers";
import { pollFor, getLastAssistantTextAfter } from "./session-utils";

// ── 提示词组装 ────────────────────────────────────────────────

/** 固定的「意图复述」指令，与用户原始 prompt 组合成意图校验提示词。 */
const RESTATE_INSTRUCTION = [
	"## 你的任务",
	"用自己的话重述你认为用户的目标是什么，以及用户试图解决的问题是什么。",
	"",
	"## 硬性约束（最高优先级）",
	"- 本轮只做意图理解与复述，不执行任何实质工作。",
	"- 禁止修改、创建、删除任何文件；禁止运行任何有副作用的命令。",
	"- 禁止调用写入类工具（如 write、edit，以及 bash 中的写操作）；只允许只读探查（如 read、grep）。",
	"- 禁止输出代码、补丁、diff、实施计划、解决方案或改进建议。",
	"- 不要反问用户、不要请求确认、不要给出下一步行动。",
	"- 若原始 prompt 存在歧义或信息缺口，在「不确定之处」中明确指出，但不要替用户做决定。",
	"",
	"## 输出格式（严格遵循）",
	"### 1. 用户的目标",
	"（用自己的话，2-4 句）",
	"",
	"### 2. 用户试图解决的问题",
	"（用自己的话，2-4 句）",
	"",
	"### 3. 不确定之处",
	"（逐条列出，无则写「无」）",
	"",
	"### 4. 一句话概括",
	"（一句话说清「用户想让我做什么」）",
	"",
	"复述完成后立即停止，等待用户确认意图。",
].join("\n");

/** 组装意图校验提示词：原始 prompt + 固定复述指令（+ 历史修正说明）。 */
export function buildPreCheckPrompt(originalPrompt: string, corrections: string[]): string {
	const lines: string[] = [
		"[pre-check] 任务意图校验：只复述，不执行",
		"",
		"## 用户原始 prompt（原文）",
		originalPrompt,
		"",
		RESTATE_INSTRUCTION,
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

const PRE_CHECK_TIMEOUT_MS = 5 * 60_000;

/**
 * 复述 → 确认 →（必要时）修正 的意图确认循环。
 * 返回已确认的意图复述；用户取消或始终未取到复述时返回 undefined。
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
		const intent = await pollFor(
			() => (ctx.isIdle() ? getLastAssistantTextAfter(ctx, sentAt) || undefined : undefined),
			PRE_CHECK_TIMEOUT_MS,
		);

		if (!intent) {
			const retry = await uiSelect(ctx, "未获取到代理的意图复述", ["重试", "取消"]);
			if (retry === "重试") continue;
			return undefined;
		}

		const decision = await uiSelect(ctx, "意图确认：以上复述是否准确反映你的目标？", [
			"是 — 意图正确，开始执行",
			"否 — 意图不正确，我要补充说明后重新分析",
			"取消",
		]);

		if (!decision || decision === "取消") return undefined;
		if (decision.startsWith("是")) return intent;

		const fix = await uiInput(
			ctx,
			"补充/修正说明",
			"说明哪里理解错了、遗漏了什么",
			false,
		);
		if (fix === undefined) return undefined;
		corrections.push(fix.trim() || "（用户未提供具体说明，请重新检查复述）");
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

// ── Extension ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("dev-pre-check", {
		description: "(pre-check) 先让 AI 复述任务意图并确认，确认正确后再开始真正的工作",
		handler: async (args, ctx) => {
			await runPreCheck(pi, ctx, args);
		},
	});
}
