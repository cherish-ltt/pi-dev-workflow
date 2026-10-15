/**
 * dev-ask.ts — /dev 意图识别轮次里的内部提问工具
 *
 * 模型在意图识别（confirmIntent）轮次里把「会影响实现方向、又无法从代码或需求推出」的
 * 不确定项做成「题目 + 2-4 个选项」的交互问用户，答案作为工具结果回到模型，由模型并入复述。
 * 题目数量不限，一次调用问完。
 *
 * 该工具默认不在模型的工具列表里（defaultActive: false + exposure: "model-only"）：
 * confirmIntent() 用 activateDevAsk() 在每轮复述前后临时加入/移除，
 * 避免它在无关会话里出现在工具列表和 system prompt 中。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { BACK_OPTION_TEXT, uiInput, uiSelect, type SelectChoice } from "./ui-helpers";

export const DEV_ASK_TOOL_NAME = "dev_ask";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/** 每个问题自动追加的自定义作答入口。 */
const CUSTOM_CHOICE = "✎ 自己输入…";

const OptionSchema = Type.Object({
	label: Type.String({ maxLength: 60, description: "选项标签，1-5 个词" }),
	description: Type.String({ description: "该选项的含义或取舍，一句话" }),
});

const QuestionSchema = Type.Object({
	header: Type.String({ maxLength: 16, description: "该问题的短标签，最多 16 字符" }),
	question: Type.String({ description: "完整问题文本，以问号结尾" }),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: `${MIN_OPTIONS}-${MAX_OPTIONS} 个互斥选项，推荐的放第一个并在 label 末尾加「（推荐）」`,
	}),
});

const DevAskParamsSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		description: "本轮要问的全部关键问题，一次问完，不要连续多次调用",
	}),
});

type DevAskQuestion = Static<typeof QuestionSchema>;

interface AskAnswer {
	header: string;
	question: string;
	answer: string | null;
}

interface DevAskDetails {
	answers: AskAnswer[];
	cancelled: boolean;
}

const DEV_ASK_DESCRIPTION = `在意图识别轮次里，把「会影响实现方向、又无法从代码或需求推出」的不确定项做成题目问用户。

用法：
- 每题给 ${MIN_OPTIONS}-${MAX_OPTIONS} 个选项，每个选项都要有 label（1-5 个词）和 description（含义或取舍）。
- 题目数量不限：把本轮该问的一次性问完，不要连续多次调用。
- 只问关键决策：能从代码里查到的先自己查，不要问琐碎细节，也不要询问你自己的复述是否准确。
- 用户可在任一题选「${CUSTOM_CHOICE}」自由作答，按 Esc 可放弃提问。
- 把你推荐的那个选项放第一个，并在 label 末尾加「（推荐）」。`;

/** 临时把 dev_ask 加进模型的工具列表，返回恢复函数。 */
export function activateDevAsk(pi: ExtensionAPI): () => void {
	const active = pi.getActiveTools();
	if (active.includes(DEV_ASK_TOOL_NAME)) return () => {};
	pi.setActiveTools([...active, DEV_ASK_TOOL_NAME]);
	return () => pi.setActiveTools(pi.getActiveTools().filter((name) => name !== DEV_ASK_TOOL_NAME));
}

/** 逐题弹「题目 + 选项」，可回上一题、可自由输入；Esc 放弃剩余的题。 */
async function runQuestionnaire(
	ctx: ExtensionContext,
	questions: DevAskQuestion[],
): Promise<DevAskDetails> {
	const chosen = new Map<number, string>();

	for (let i = 0; i < questions.length; ) {
		const question = questions[i]!;
		const choices: SelectChoice[] = [
			...question.options.map((option) => ({ label: option.label, description: option.description })),
			CUSTOM_CHOICE,
		];
		const title = `不确定项 ${i + 1}/${questions.length}｜${question.header}\n${question.question}`;
		const picked = await uiSelect(ctx, title, choices, i > 0);

		if (picked === undefined) {
			return { answers: buildAnswers(questions, chosen), cancelled: true };
		}
		if (picked === BACK_OPTION_TEXT) {
			i -= 1;
			continue;
		}
		if (picked === CUSTOM_CHOICE) {
			const typed = await uiInput(ctx, `自己的答案（${i + 1}/${questions.length}）`, "直接输入你的答案", true);
			if (typed === undefined) continue;
			chosen.set(i, typed.trim());
			i += 1;
			continue;
		}
		chosen.set(i, picked);
		i += 1;
	}

	return { answers: buildAnswers(questions, chosen), cancelled: false };
}

function buildAnswers(questions: DevAskQuestion[], chosen: Map<number, string>): AskAnswer[] {
	return questions.map((question, index) => ({
		header: question.header,
		question: question.question,
		answer: chosen.get(index) ?? null,
	}));
}

function formatResult(answers: AskAnswer[], cancelled: boolean): string {
	const answered = answers.filter((item) => item.answer !== null);
	const lines: string[] = [];

	if (answered.length > 0) {
		lines.push(
			"用户已作答：",
			...answered.map((item, index) => `${index + 1}. 「${item.question}」→ ${item.answer}`),
		);
	}

	if (cancelled) {
		lines.push(
			answered.length > 0 ? "用户随后按 Esc 放弃了剩余提问。" : "用户按 Esc 放弃了提问，没有提供答案。",
			"未作答的问题按你的最佳判断处理，并在「不确定之处」中标注为开放问题。",
		);
	} else {
		lines.push("以上答案视为用户已确认的前提，不要就同一件事再次提问或臆测。");
	}

	return lines.join("\n");
}

const devAskTool = defineTool({
	name: DEV_ASK_TOOL_NAME,
	label: "Dev Ask",
	description: DEV_ASK_DESCRIPTION,
	promptSnippet: "就意图识别中的关键不确定项向用户提结构化问题（题目 + 2-4 个选项，题数不限）",
	exposure: "model-only",
	defaultActive: false,
	parameters: DevAskParamsSchema,

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const details: DevAskDetails = { answers: [], cancelled: true };
		if (!ctx.hasUI) {
			return {
				content: [{ type: "text", text: "当前会话没有交互界面，无法提问。请把不确定项写进文字说明。" }],
				details,
			};
		}

		const outcome = await runQuestionnaire(ctx, params.questions);
		return {
			content: [{ type: "text", text: formatResult(outcome.answers, outcome.cancelled) }],
			details: outcome,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(devAskTool);
}
