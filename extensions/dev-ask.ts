/**
 * dev-ask.ts — 默认供模型直接调用的结构化提问工具
 *
 * 用于需求澄清、方案取舍和 grilling 分轮追问，答案作为工具结果回到当前会话。
 * 每轮把前置条件已明确的问题一次问完，收到答案后再组织依赖这些答案的下一轮。
 * 保持 model-only，不允许其他工具间接调用。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { Key, Markdown, SelectList, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { BACK_OPTION_TEXT, uiInput } from "./ui-helpers";

export const DEV_ASK_TOOL_NAME = "dev_ask";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/** 每个问题自动追加的自定义作答入口。 */
const CUSTOM_CHOICE = "✎ 自己输入…";

const OptionSchema = Type.Object({
	label: Type.String({ maxLength: 60, description: "选项标签，1-5 个词" }),
	description: Type.String({ description: "该选项的含义或取舍，详情区自动换行展示" }),
	preview: Type.Optional(Type.String({
		description: "可选的 Markdown 预览，随当前选项展示；ASCII 结构图、代码或配置请放在代码块中以保留缩进与对齐",
	})),
});

const QuestionSchema = Type.Object({
	header: Type.String({ maxLength: 16, description: "该问题的短标签，最多 16 字符" }),
	question: Type.String({ description: "完整的决策问题，以问号结尾；仅询问前置条件已明确、当前可回答的问题" }),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: `${MIN_OPTIONS}-${MAX_OPTIONS} 个互斥选项，推荐的放第一个并在 label 末尾加「（推荐）」`,
	}),
});

const DevAskParamsSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		description: "本轮前置条件已明确的全部关键问题，一次问完；依赖本轮答案的问题留到收到答案后的下一轮",
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

const DEV_ASK_DESCRIPTION = `默认可用的结构化提问工具，用于需求澄清、方案取舍、用户偏好和 grilling 分轮追问，不依赖 /dev-pre-check。

用法：
- 只问需要用户决定的关键问题：能从代码、文档或环境查到的事实先自己查，不要问琐碎细节或重复询问已回答的问题。
- 每轮只询问前置条件已明确、当前可回答的问题，题数不限，一次调用问完；等待答案后再组织依赖这些答案的下一轮，不要提前猜测。
- 在 grilling 技能指导下强烈推荐直接调用 dev_ask：每轮把设计树当前 frontier 的问题一起提交，收到答案后重算 frontier，再开展下一轮。
- 每题给 ${MIN_OPTIONS}-${MAX_OPTIONS} 个互斥选项，每个选项都有 label（1-5 个词）和 description（含义或取舍）。推荐项放第一个，在 label 末尾加「（推荐）」。
- 不要自行添加自定义输入或返回选项，界面会自动提供；用户可在任一题选「${CUSTOM_CHOICE}」自由作答，按 Esc 可放弃提问。
- 详情区只显示当前高亮选项的 description 和可选 preview，并自动换行。对比布局、结构图、代码或配置时可提供 Markdown preview；ASCII 图和代码用代码块保留对齐，普通偏好问题不必提供预览。
- 答案表示用户对所问决策的选择，不等于授权执行未被要求的操作；未作答不等于同意推荐项。当前会话没有交互界面时改用文字说明待决问题。
- 工具仅供模型直接调用，不通过 codemode 或其他工具间接调用。`;

function askQuestion(
	ctx: ExtensionContext,
	title: string,
	question: DevAskQuestion,
	backable: boolean,
): Promise<string | undefined> {
	const choices: Static<typeof OptionSchema>[] = [
		...question.options,
		{ label: CUSTOM_CHOICE, description: "输入自己的答案，不使用上述选项。" },
	];
	if (backable) choices.unshift({ label: BACK_OPTION_TEXT, description: "返回上一题并重新作答。" });

	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const selectList = new SelectList(
			choices.map((choice, index) => ({ value: String(index), label: choice.label })),
			choices.length,
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		);
		let detailOffset = 0;
		let detailHeight = 1;
		let detailLength = 0;
		const previews = new Map<number, Markdown>();
		selectList.onSelect = (item) => done(choices[Number(item.value)]!.label);
		selectList.onCancel = () => done(undefined);
		selectList.onSelectionChange = () => {
			detailOffset = 0;
		};

		return {
			render(width) {
				const wide = width >= 80;
				const leftWidth = wide ? Math.min(32, Math.floor(width * 0.35)) : width;
				const detailWidth = wide ? width - leftWidth - 3 : width;
				const innerWidth = Math.max(1, detailWidth - 4);
				const titleLines = wrapTextWithAnsi(title, width).map((line) => theme.fg("accent", line));
				const hintLines = wrapTextWithAnsi("↑↓ 导航 • Enter 选择 • Esc 取消 • PgUp/PgDn 翻阅详情", width)
					.map((line) => theme.fg("dim", line));
				const options = selectList.render(leftWidth);
				const index = Number(selectList.getSelectedItem()!.value);
				const choice = choices[index]!;
				const content = [
					...wrapTextWithAnsi(choice.label, innerWidth).map((line) => theme.fg("accent", line)),
					"",
					...wrapTextWithAnsi(choice.description, innerWidth).map((line) => theme.fg("text", line)),
				];
				if (choice.preview) {
					let preview = previews.get(index);
					if (!preview) {
						preview = new Markdown(choice.preview, 0, 0, getMarkdownTheme());
						previews.set(index, preview);
					}
					content.push("", ...preview.render(innerWidth));
				}
				detailLength = content.length;
				detailHeight = Math.max(1, tui.terminal.rows - titleLines.length - hintLines.length - 6
					- (wide ? 0 : options.length + 1));
				detailOffset = Math.max(0, Math.min(detailOffset, detailLength - detailHeight));
				const details = content.slice(detailOffset, detailOffset + detailHeight);
				const panel = detailWidth < 4 ? details : [
					theme.fg("border", `╭${"─".repeat(detailWidth - 2)}╮`),
					...details.map((line) => {
						const padding = " ".repeat(Math.max(0, detailWidth - 3 - visibleWidth(line)));
						return `${theme.fg("border", "│")} ${line}${padding}${theme.fg("border", "│")}`;
					}),
					theme.fg("border", `╰${"─".repeat(detailWidth - 2)}╯`),
				];
				const body = wide
					? Array.from({ length: Math.max(options.length, panel.length) }, (_, row) => {
						const left = options[row] ?? "";
						return `${left}${" ".repeat(leftWidth - visibleWidth(left) + 3)}${panel[row] ?? ""}`;
					})
					: [...options, "", ...panel];
				const position = detailLength > detailHeight
					? theme.fg("dim", `详情 ${detailOffset + 1}-${Math.min(detailLength, detailOffset + detailHeight)}/${detailLength}`)
					: "";
				return ["", ...titleLines, "", ...body, ...wrapTextWithAnsi(position, width), ...hintLines, ""];
			},
			invalidate() {
				selectList.invalidate();
				previews.clear();
			},
			handleInput(data) {
				if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
					const step = matchesKey(data, Key.pageUp) ? -detailHeight : detailHeight;
					detailOffset = Math.max(0, Math.min(detailOffset + step, detailLength - detailHeight));
				} else {
					selectList.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}

/** 逐题弹「题目 + 选项」，可回上一题、可自由输入；Esc 放弃剩余的题。 */
async function runQuestionnaire(
	ctx: ExtensionContext,
	questions: DevAskQuestion[],
): Promise<DevAskDetails> {
	const chosen = new Map<number, string>();

	for (let i = 0; i < questions.length; ) {
		const question = questions[i]!;
		const title = `不确定项 ${i + 1}/${questions.length}｜${question.header}\n${question.question}`;
		const picked = await askQuestion(ctx, title, question, i > 0);

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
			"未作答的问题仍是开放问题，不代表用户同意推荐项；列出待决问题，不要把它们当作已确认决策。",
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
	promptSnippet: "向用户提结构化问题，用于需求澄清、方案取舍与 grilling 分轮追问（每题 2-4 个选项，题数不限）",
	promptGuidelines: [
		"需要用户做关键决策时直接使用 dev_ask；能查到的事实先自己查，已回答的问题不要重复提问。",
		"grilling 中强烈推荐每轮直接调用 dev_ask 问完当前 frontier，等待答案后再问依赖这些答案的问题，不通过 codemode 调用。",
	],
	exposure: "model-only",
	defaultActive: true,
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
