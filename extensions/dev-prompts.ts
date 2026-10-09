/**
 * Dev Prompts Extension
 *
 * 四个命令：/dev-feat、/dev-fix、/dev-refactor、/dev-test。
 *
 * 每个命令的流程一致：
 *   1. 命令参数就是任务原文；不带参数时弹一次必填输入框
 *   2. 复用 pre-check 的意图确认循环：代理先复述目标与问题，用户确认后才继续
 *   3. 提示词只补三件事：先只读探查代码库的要求、AI 的身份与职责、未说明时的默认收尾验收标准
 *      —— 任务目标来自第 2 步已确认的意图，不在这里重新解释需求
 *   4. 投递给当前代理执行
 *
 * 追问完善（/grill）与 PRD（/prd）是独立命令，不由这里触发。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { confirmIntent, READ_ONLY_EXPLORATION_RULES } from "./pre-check";
import { detectProjectDefaults, defaultAcceptanceItems, type ProjectDefaults } from "./session-utils";
import { uiTaskArg } from "./ui-helpers";

interface DevType {
	description: string;
	/** 身份描述，拼在「你是…」之后。 */
	role: (d: ProjectDefaults) => string;
	/** 职责清单。 */
	duties: string[];
	/** 在项目默认验收标准之上追加的条目。 */
	extraAcceptance?: string[];
}

const FEAT: DevType = {
	description: "(dev) 新功能实现 — 先复述确认意图，再按 身份职责 + 默认验收标准 组装提示词执行",
	role: (d) => `资深 ${d.language || "项目"} 工程师`,
	duties: [
		"给出逐步实施计划（要修改/新建的文件、迁移、对现有代码的假设），经我确认后再写代码",
		"只实现任务要求的功能，不顺手重构无关代码",
		"保持现有公共 API 兼容，不为假设性需求添加抽象层",
	],
};

const FIX: DevType = {
	description: "(dev) 问题修复 — 先复述确认意图，再按 根因定位职责 + 默认验收标准 组装提示词执行",
	role: (d) => `资深 ${d.language || "项目"} 调试工程师`,
	duties: [
		"先用只读探查定位根因（相关代码、日志、调用链），不用消除报错的方式掩盖症状",
		"修复前说明根因与方案取舍，只改与该问题相关的代码",
		"补一个能复现该问题的测试",
	],
	extraAcceptance: ["新增的复现测试在修复前失败、修复后通过"],
};

const REFACTOR: DevType = {
	description: "(dev) 重构 — 先复述确认意图，再按 行为不变职责 + 默认验收标准 组装提示词执行",
	role: (d) => `资深 ${d.language || "项目"} 工程师`,
	duties: [
		"重构前后对外行为与公共 API 签名完全一致",
		"先指出要消除的具体结构性问题（带真实文件与位置），再动手；不做与目标无关的调整",
		"不新增功能、不修改业务逻辑",
	],
	extraAcceptance: ["对外行为与公共 API 不变，现有测试全部通过"],
};

const TEST: DevType = {
	description: "(dev) 测试补充 — 先复述确认意图，再按 测试职责 + 默认验收标准 组装提示词执行",
	role: () => "资深测试工程师",
	duties: [
		"覆盖成功路径、边界条件与错误分支，测试必须真实执行",
		"断言明确无歧义，不写只验证 mock 的测试",
		"保持与项目既有测试框架和风格一致",
	],
	extraAcceptance: ["新增测试覆盖成功路径、边界条件与错误分支，且全部通过"],
};

/** 取任务首行作为提示词标题，避免把整段需求塞进标题。 */
function taskSummary(task: string): string {
	return task.split("\n")[0]!.trim().slice(0, 100);
}

function buildDevPrompt(
	command: string,
	type: DevType,
	task: string,
	intent: string,
	d: ProjectDefaults,
): string {
	const acceptance = [...defaultAcceptanceItems(d), ...(type.extraAcceptance ?? [])];
	return [
		`[${command}] ${taskSummary(task)}`,
		"",
		"## 任务（原始描述）",
		task,
		"",
		"## 已确认的任务意图",
		intent,
		"",
		"## 探索要求（先只读探查，再动手）",
		"动手前必须先看真实代码；实施计划里引用的文件与符号都必须是本轮真实读到的。",
		...READ_ONLY_EXPLORATION_RULES,
		"",
		"## 身份与职责",
		`你是${type.role(d)}。`,
		...type.duties.map((duty) => `- ${duty}`),
		"",
		"## 验收标准",
		"以下为默认收尾验收基线；任务描述中另有明确验收标准时，以任务描述为准。",
		...acceptance.map((item) => `- ${item}`),
	].join("\n");
}

async function runDevCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	command: string,
	type: DevType,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`/${command} 需要交互式界面才能确认意图`, "error");
		return;
	}

	const task = await uiTaskArg(ctx, args, "任务描述（必填）", "如 实现邮箱密码登录接口");
	if (!task) return;

	const intent = await confirmIntent(task, ctx, pi);
	if (!intent) {
		ctx.ui.notify("已取消，未执行任何改动", "info");
		return;
	}

	const prompt = buildDevPrompt(command, type, task, intent, detectProjectDefaults(ctx.cwd));
	pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	ctx.ui.notify(`意图已确认，/${command} 提示词已发送给当前代理`, "info");
}

function registerDev(pi: ExtensionAPI, command: string, type: DevType): void {
	pi.registerCommand(command, {
		description: type.description,
		handler: async (args, ctx) => {
			await runDevCommand(pi, ctx, args, command, type);
		},
	});
}

export default function (pi: ExtensionAPI) {
	registerDev(pi, "dev-feat", FEAT);
	registerDev(pi, "dev-fix", FIX);
	registerDev(pi, "dev-refactor", REFACTOR);
	registerDev(pi, "dev-test", TEST);
}
