/**
 * Dev Prompts Extension
 *
 * Registers /dev-* commands that interactively collect missing context for
 * high-quality prompt templates (from ai提示词优化.md) and send the assembled
 * prompt directly to the current agent.
 *
 * Commands:
 *   /dev-feat       - New feature / creative generation
 *   /dev-fix         - Bug fix / error troubleshooting
 *   /dev-doc         - Documentation generation
 *   /dev-refactor    - Code refactoring
 *   /dev-test        - Test case generation
 *   /dev-chore       - Maintenance / automation
 *   /dev-perf        - Performance optimization
 *   /dev-style       - Style / format adjustment
 *   /dev-security    - Security review
 *   /dev-explain     - Concept explanation
 *   /dev-compare     - Comparison evaluation
 *
 * Usage: type /dev-<type> and follow the wizard.
 * Leave a field empty (Enter) to skip its section.
 * Press Esc to cancel the entire wizard.
 *
 * Review detection: inputs mentioning review/审查 + code/diff are automatically
 * handled by the review-html skill, running in the current agent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runGrillPhase, runPRDPhase, saveAnswerFile, recoverFromBackup, type GrillOptions } from "./grill-me-agent";
import { detectProjectDefaults, defaultAcceptance, type ProjectDefaults } from "./session-utils";
import { uiSelect, uiConfirm, uiInput, BACK_MARKER } from "./ui-helpers";

// ── Helpers ──────────────────────────────────────────────────

/** Ask a single question with proper wrapping. Returns `undefined` on cancel (Esc), or BACK_MARKER for back. */
async function ask(
	ctx: ExtensionCommandContext,
	label: string,
	placeholder: string,
	backable = false,
	initialValue = "",
): Promise<string | undefined> {
	return uiInput(ctx, label, placeholder, false, backable, initialValue);
}

/** 向导中的一次提问；多个字段用 sep 分隔一次填写，减少提问轮次。 */
interface WizardQuestion {
	label: string;
	placeholder: string;
	/** 绑定的字段集合，答案按 sep 拆分后依序填入。 */
	keys: string[];
	/** 字段分隔符，默认 " / "。 */
	sep?: string;
}

/** 将一次回答填入字段。单字段问题时保留完整输入（不按分隔符拆分），避免误切。 */
function assignAnswers(answers: Record<string, string>, q: WizardQuestion, raw: string): void {
	const parts = q.keys.length === 1 ? [raw] : raw.split(q.sep ?? " / ").map((s) => s.trim());
	q.keys.forEach((k, i) => {
		const part = parts[i];
		if (part) answers[k] = part;
	});
}

/** Check if a field value is empty or explicitly "无". */
function isEmpty(val: string | undefined): boolean {
	return !val || val.trim() === "" || val.trim() === "无";
}

/** Wrap a non-empty value for template insertion. */
function wrap(val: string | undefined, fallback = "..."): string {
	if (isEmpty(val)) return fallback;
	return val!.trim();
}

// ── Review helper ────────────────────────────────────────────

/** Find the newest HTML review file generated after `afterMs`（忽略先前遗留的旧报告）。 */
function findNewestReviewHtml(cwd: string, afterMs: number): string {
	const candidates = [
		path.join(cwd, ".pi-dev-output", "pi-review", "html"),
		path.join(cwd, "pi-review"),
		path.join(cwd, ".pi-dev-output", "pi-review"),
	];

	for (const reviewDir of candidates) {
		try {
			if (fs.existsSync(reviewDir)) {
				const files = fs.readdirSync(reviewDir)
					.filter(f => f.endsWith(".html"))
					.map(f => ({
						name: f,
						mtime: fs.statSync(path.join(reviewDir, f)).mtimeMs,
					}))
					.filter(f => f.mtime > afterMs)
					.sort((a, b) => b.mtime - a.mtime);
				if (files.length > 0) {
					const rel = path.relative(cwd, reviewDir);
					return rel + "/" + files[0].name;
				}
			}
		} catch {
			// ignore fs errors
		}
	}

	return "";
}

/** Run a code review in the current agent and report the result. */
async function runReview(task: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<string | undefined> {
	const startTime = Date.now();
	ctx.ui.notify("🤖 正在运行代码审查，请稍候...", "info");

	pi.sendUserMessage(`/skill:review-html\n\n${task}`, {
		deliverAs: "followUp",
		expandPromptTemplates: true,
	});

	// 以“报告文件生成为完成标志”进行轮询；不使用 waitForIdle，
	// 避免其在 sendUserMessage 触发的新 turn 开始前立即返回，导致误报“已完成”。
	const deadline = Date.now() + 10 * 60_000;
	let filePath = "";
	while (Date.now() < deadline) {
		filePath = findNewestReviewHtml(ctx.cwd, startTime);
		if (filePath) break;
		await new Promise((r) => setTimeout(r, 2_000));
	}

	const dur = ((Date.now() - startTime) / 1000).toFixed(1);
	if (filePath) {
		ctx.ui.notify(`📄 审查报告已生成: ${filePath} (${dur}s)`, "success");
	} else {
		ctx.ui.notify(`⚠️ 审查未生成报告 (${dur}s)，请查看当前代理的回复或稍后重试`, "warning");
	}
	return filePath;
}

// ── Template Assemblers ──────────────────────────────────────

interface FeatFields {
	language: string;
	techStack: string;
	module: string;
	description: string;
	painPoint: string;
	testCmd: string;
	acceptance?: string;
	extra?: string;
}

function assembleFeatPrompt(f: FeatFields): string {
	const lines: string[] = [];
	lines.push(`[feat] 在 ${wrap(f.module)} 中实现 ${wrap(f.description)}`);
	lines.push("");
	lines.push(`**角色**：你是一个资深 ${wrap(f.language)} 工程师。`);
	if (!isEmpty(f.techStack) || !isEmpty(f.painPoint)) {
		lines.push(
			`**背景**：项目使用 ${wrap(f.techStack)}，当前缺少 ${wrap(f.description)}` +
			(isEmpty(f.painPoint) ? "。" : `，用户痛点是 ${f.painPoint!.trim()}。`),
		);
	}
	lines.push("**任务**：");
	lines.push("1. 先分析代码库结构，给出逐步实施计划（列出要修改/创建的文件、数据库迁移、对现有代码的假设）。");
	lines.push("2. 计划经我确认后再编写代码。");
	if (!isEmpty(f.testCmd)) {
		lines.push(`3. 实现后编写测试用例验证核心逻辑，并运行 ${f.testCmd!.trim()} 确认通过。`);
	} else {
		lines.push("3. 实现后编写测试用例验证核心逻辑。");
	}
	lines.push("**输出**：提供 unified diff 和两句话的变更说明。");
	lines.push("**约束**：禁止顺手重构无关代码；保持所有公共 API 签名兼容；不要为假设性需求添加抽象层。");
	if (!isEmpty(f.testCmd)) {
		lines.push(`**验证**：运行 ${f.testCmd!.trim()} 确保无回归。`);
	}
	appendMeta(lines, f);
	return lines.join("\n");
}

interface FixFields {
	filePath: string;
	lineNumber: string;
	bugDesc: string;
	inputDesc: string;
	expected: string;
	actualError: string;
	testCmd: string;
	acceptance?: string;
	extra?: string;
}

function assembleFixPrompt(f: FixFields): string {
	const lines: string[] = [];
	const loc = isEmpty(f.lineNumber) ? f.filePath.trim() : `${f.filePath.trim()} #L${f.lineNumber!.trim()}`;
	lines.push(`[fix] 修复 ${loc} 中的 ${wrap(f.bugDesc)}`);
	lines.push("");
	lines.push("**背景**：");
	lines.push(`- 输入：${isEmpty(f.inputDesc) ? "见代码上下文" : f.inputDesc!.trim()}`);
	lines.push(`- 预期行为：${wrap(f.expected, "请描述预期结果")}`);
	lines.push(`- 当前错误：${wrap(f.actualError, "请描述当前错误")}`);
	lines.push("**任务**：");
	lines.push("1. 不要仅仅消除报错（Suppress），要解决根本原因。");
	lines.push("2. 先读取相关代码和日志，诊断根因（多步推理，不要先给结论）。");
	lines.push("3. 提供至少一种修复方案，并说明为什么这样做。");
	lines.push("4. 编写测试用例复现该 Bug 并确认修复有效。");
	lines.push("**输出**：提供 diff 和两句话的根因分析。");
	lines.push("**约束**：只修 bug，不做重构；最小化改动；不要假设错误是微不足道的。");
	if (!isEmpty(f.testCmd)) {
		lines.push(`**验证**：运行 ${f.testCmd!.trim()} 确认修复。`);
	}
	appendMeta(lines, f);
	return lines.join("\n");
}

interface DocFields {
	moduleName: string;
	audience: string;
	keyInfo: string;
	language: string;
	existingMaterial: string;
	acceptance?: string;
	extra?: string;
}

function assembleDocPrompt(f: DocFields): string {
	const lines: string[] = [];
	lines.push(`[doc] 为 ${wrap(f.moduleName)} 撰写一份文档`);
	lines.push("");
	lines.push("**角色**：你是一位技术文档工程师。");
	if (!isEmpty(f.audience) || !isEmpty(f.keyInfo)) {
		lines.push(`**背景**：目标受众是 ${wrap(f.audience)}，他们需要了解 ${wrap(f.keyInfo)}。`);
	}
	lines.push("**任务**：");
	lines.push("1. 提取核心要点，按逻辑结构重组（概述 → 快速开始 → 详细说明 → 常见问题）。");
	lines.push(`2. 添加至少 1 个真实可运行的示例（使用 ${wrap(f.language)} 语法高亮）。`);
	lines.push("3. 如存在争议点，列出不同观点并注明\"无共识\"。");
	if (!isEmpty(f.existingMaterial)) {
		lines.push(`**已有材料**：${f.existingMaterial!.trim()}`);
	}
	lines.push("**输出格式**：Markdown 层级标题，必要时插入表格/列表。");
	lines.push("**约束**：避免空洞词汇（如\"细致入微\"\"深入探究\"）；每段都应有实质信息；保持原意，不添加原文没有的事实。");
	lines.push("**验证**：请先提供大纲，经我确认后再扩展。");
	appendMeta(lines, f);
	return lines.join("\n");
}

interface RefactorFields {
	filePath: string;
	lineCount: string;
	problems: string;
	goal: string;
	testCmd: string;
	acceptance?: string;
	extra?: string;
}

function assembleRefactorPrompt(f: RefactorFields): string {
	const lines: string[] = [];
	const loc = isEmpty(f.lineCount) ? f.filePath.trim() : `${f.filePath.trim()}（约 ${f.lineCount!.trim()} 行）`;
	lines.push(`[refactor] 对 ${loc} 进行重构，提升 ${wrap(f.goal, "可读性 / 可维护性")}`);
	lines.push("");
	lines.push(`**背景**：当前代码存在 ${wrap(f.problems)}。`);
	lines.push("**任务**：");
	lines.push("1. 识别主要问题。");
	lines.push("2. 提出重构方案，说明改动前后差异。");
	lines.push("3. 输出重构后的完整版本。");
	lines.push("**硬性约束**：");
	lines.push("- 不改变任何行为，保留所有公共 API 签名不变。");
	lines.push("- 禁止顺手优化、禁止添加新功能、禁止修改业务逻辑。");
	if (!isEmpty(f.testCmd)) {
		lines.push(`- 拆分后运行 ${f.testCmd!.trim()} 确认无回归。`);
	}
	lines.push("**输出**：提供 diff 和新模块的依赖关系图。");
	if (!isEmpty(f.testCmd)) {
		lines.push(`**验证**：运行 ${f.testCmd!.trim()} 并确保全部通过。`);
	}
	appendMeta(lines, f);
	return lines.join("\n");
}

interface TestFields {
	filePath: string;
	framework: string;
	coverage: string;
	edgeCases: string;
	testCmd: string;
	acceptance?: string;
	extra?: string;
}

function assembleTestPrompt(f: TestFields): string {
	const lines: string[] = [];
	lines.push(`[test] 为 ${wrap(f.filePath)} 中的变更生成表驱动测试`);
	lines.push("");
	lines.push(`**角色**：你是一个资深测试工程师。`);
	lines.push(`**背景**：使用 ${wrap(f.framework)} 框架，追求 ≥${wrap(f.coverage, "90")}% 分支覆盖率。`);
	lines.push("**任务**：");
	lines.push(`1. 覆盖维度：${isEmpty(f.edgeCases) ? "null 值、空值、超时、幂等性、重试、成功路径、4xx/5xx 错误、边界条件" : f.edgeCases!.trim()}。`);
	lines.push("2. 优先让测试先失败（红），再提供补丁使其通过（绿）。");
	lines.push("**输出格式**：表格列出场景 → 预期结果 → 权重，末尾附评分模板。");
	lines.push("**约束**：评分准则必须无歧义；不要假设输入总是合法的。");
	if (!isEmpty(f.testCmd)) {
		lines.push(`**验证**：运行 ${f.testCmd!.trim()} 并展示覆盖率报告。`);
	}
	appendMeta(lines, f);
	return lines.join("\n");
}

interface ChoreFields {
	configPath: string;
	task: string;
	envDesc: string;
	targetVersion: string;
	verifyCmd: string;
	acceptance?: string;
	extra?: string;
}

function assembleChorePrompt(f: ChoreFields): string {
	const lines: string[] = [];
	lines.push(`[chore] 在 ${wrap(f.configPath)} 中 ${wrap(f.task)}`);
	lines.push("");
	lines.push("**角色**：你是一个 DevOps 工程师。");
	lines.push(`**背景**：当前环境 ${wrap(f.envDesc)}，目标版本 ${wrap(f.targetVersion)}。`);
	lines.push("**任务**：");
	lines.push(`1. 只做 ${wrap(f.task)}，不做任何其他改动。`);
	if (!isEmpty(f.verifyCmd)) {
		lines.push(`2. 改动后运行 ${f.verifyCmd!.trim()} 确认无破坏性变更。`);
	}
	lines.push("**硬性约束**：");
	lines.push("- NEVER 修改生产环境配置文件（如 config/production.yml）。");
	lines.push("- NEVER 运行任何部署命令（除非用户明确要求）。");
	lines.push("- 禁止顺手升级无关依赖、禁止修改代码逻辑。");
	lines.push("**输出**：提供变更前后对比和影响说明。");
	if (!isEmpty(f.verifyCmd)) {
		lines.push(`**验证**：运行 ${f.verifyCmd!.trim()} 并展示结果。`);
	}
	appendMeta(lines, f);
	return lines.join("\n");
}

interface PerfFields {
	filePath: string;
	bottleneck: string;
	currentCost: string;
	targetLatency: string;
	benchCmd: string;
	acceptance?: string;
	extra?: string;
}

function assemblePerfPrompt(f: PerfFields): string {
	const lines: string[] = [];
	lines.push(`[perf] 优化 ${wrap(f.filePath)} 中的 ${wrap(f.bottleneck)}`);
	lines.push("");
	lines.push("**角色**：你是一位性能优化专家。");
	lines.push(`**背景**：当前执行耗时约 ${wrap(f.currentCost)}，用户可接受的延迟为 ${wrap(f.targetLatency)}。`);
	lines.push("**任务**：");
	lines.push("1. Think deeply about this performance issue.");
	lines.push("2. 先分析当前性能数据，给出基准指标。");
	lines.push("3. 列出 ≥2 种优化方案，分析每个方案的预估提升幅度、实现复杂度、潜在风险。");
	if (!isEmpty(f.benchCmd)) {
		lines.push(`4. 选择推荐方案并实现。优化后运行 ${f.benchCmd!.trim()} 对比前后数据。`);
	} else {
		lines.push("4. 选择推荐方案并实现。优化后运行基准测试对比前后数据。");
	}
	lines.push("**输出**：提供 before/after 性能对比表格。");
	lines.push("**约束**：不要牺牲核心准确性；优先给出低风险改动；不为了微优化牺牲可读性。");
	appendMeta(lines, f);
	return lines.join("\n");
}

interface StyleFields {
	targetStyle: string;
	description: string;
	terms: string;
	lintCmd: string;
	acceptance?: string;
	extra?: string;
}

function assembleStylePrompt(f: StyleFields): string {
	const lines: string[] = [];
	lines.push(`[style] 将以下内容调整为 ${wrap(f.targetStyle)}`);
	lines.push("");
	lines.push("**角色**：你是一位代码风格专家。");
	lines.push(`**原文**：${wrap(f.description, "（见当前上下文）")}`);
	lines.push("**任务**：");
	lines.push("1. 保持原意和信息完整，仅改变表达风格/代码格式。");
	if (!isEmpty(f.terms)) {
		lines.push(`2. 术语统一为：${f.terms!.trim()}。`);
		lines.push("3. 输出两种备选风格供我对比。");
	} else {
		lines.push("2. 输出两种备选风格供我对比。");
	}
	lines.push("**约束**：不要添加原文没有的新事实，不要改变关键数据和逻辑；同时指出原文中可能存在的歧义表达。");
	if (!isEmpty(f.lintCmd)) {
		lines.push(`**验证**：对代码运行 ${f.lintCmd!.trim()} 确保符合规范。`);
	}
	appendMeta(lines, f);
	return lines.join("\n");
}

interface SecurityFields {
	filePath: string;
	focus: string;
	acceptance?: string;
	extra?: string;
}

function assembleSecurityPrompt(f: SecurityFields): string {
	const lines: string[] = [];
	lines.push(`[security] 对 ${wrap(f.filePath)} 运行安全审查`);
	lines.push("");
	lines.push("**角色**：你是一名安全审计专家（独立于编写代码的 Agent）。");
	lines.push("**任务**：");
	lines.push(`1. 审查清单：${isEmpty(f.focus) ? "认证边界、注入漏洞、敏感数据暴露、CSRF/CORS 配置、权限校验缺失" : f.focus!.trim()}。`);
	lines.push("2. 提供带行号的修复方案及理由。");
	lines.push("3. 只审查不修改，输出审查报告。");
	lines.push("**硬性约束**：在隔离上下文中运行，不继承主 Agent 的记忆。");
	lines.push("**输出**：Markdown 报告，每个问题包含严重级别、行号、风险描述、修复建议。");
	appendMeta(lines, f);
	return lines.join("\n");
}

interface ExplainFields {
	concept: string;
	audience: string;
	depth: string;
	acceptance?: string;
	extra?: string;
}

function assembleExplainPrompt(f: ExplainFields): string {
	const lines: string[] = [];
	lines.push(`[explain] 解释 ${wrap(f.concept)}`);
	lines.push("");
	lines.push("**角色**：你是一位资深技术导师，擅长用类比引导初学者理解复杂概念。");
	lines.push(`**背景**：目标受众是 ${wrap(f.audience)}，需要理解 ${wrap(f.concept)} 的 ${wrap(f.depth, "基础")} 层面。`);
	lines.push("**任务**：");
	lines.push("1. 用生活化的类比引入概念，建立直觉。");
	lines.push("2. 由浅入深逐步展开，先给大局观再进入细节。");
	lines.push("3. 提供至少一个真实世界的应用场景。");
	lines.push("4. 如有常见误区，明确指出。");
	lines.push("**输出格式**：Markdown，必要时插入图示描述。");
	lines.push("**验证**：请先给出一句话总结，经我确认后再展开。");
	appendMeta(lines, f);
	return lines.join("\n");
}

interface CompareFields {
	itemA: string;
	itemB: string;
	dimensions: string;
	acceptance?: string;
	extra?: string;
}

function assembleComparePrompt(f: CompareFields): string {
	const lines: string[] = [];
	lines.push(`[compare] 对比 ${wrap(f.itemA)} 与 ${wrap(f.itemB)}`);
	lines.push("");
	lines.push("**角色**：你是一位客观中立的评测专家。");
	lines.push(`**背景**：需要从 ${wrap(f.dimensions, "多个方面")} 对 ${wrap(f.itemA)} 和 ${wrap(f.itemB)} 进行全面对比。`);
	lines.push("**任务**：");
	lines.push("1. 构建多维度评估矩阵，量化或半量化评分。");
	lines.push("2. 分析各维度的权衡（Trade-offs），说明在什么场景下哪个更优。");
	lines.push("3. 给出综合结论和建议。");
	lines.push("**输出格式**：Markdown 表格 + 简短分析。");
	lines.push("**约束**：客观中立，不偏袒任何一方，明确标注不确定的结论。");
	appendMeta(lines, f);
	return lines.join("\n");
}

// ── 四段式收尾：验收标准 + 额外补充 ───────────────────────────

/** 追加“验收标准 / 额外补充”段落（用户填写或默认填充，保证提示词不空白）。 */
function appendMeta(lines: string[], f: { acceptance?: string; extra?: string }): void {
	if (f.acceptance?.trim()) {
		lines.push("");
		lines.push(`**验收标准**：${f.acceptance.trim()}`);
	}
	if (f.extra?.trim()) {
		lines.push("");
		lines.push(`**额外补充**：${f.extra.trim()}`);
	}
}

// ── 默认字段填充：未提问/跳过的字段注入流畅默认值 ───────────────

const FIELD_DEFAULTS: Record<string, (d: ProjectDefaults) => Record<string, string>> = {
	feat: (d) => ({
		language: d.language || "项目使用的主流语言",
		techStack: "项目当前技术栈",
		module: "项目相关模块",
		testCmd: d.testCmd,
	}),
	fix: (d) => ({
		expected: "修复后行为符合预期",
		actualError: "当前实际的报错信息",
		testCmd: d.testCmd,
	}),
	doc: (d) => ({
		audience: "目标读者",
		keyInfo: "该模块的核心用法与关键概念",
		language: d.language || "项目语言",
	}),
	refactor: (d) => ({
		problems: "可读性/可维护性等结构性问题",
		goal: "可读性与可维护性",
		testCmd: d.testCmd,
	}),
	test: (d) => ({
		framework: "项目采用的测试框架",
		coverage: "90",
		edgeCases: "null 值、空值、超时、幂等性、重试、成功路径、4xx/5xx 错误、边界条件",
		testCmd: d.testCmd,
	}),
	chore: (d) => ({
		envDesc: "项目运行环境",
		targetVersion: "按任务指定的版本",
		verifyCmd: d.testCmd || d.lintCmd,
	}),
	perf: () => ({
		bottleneck: "性能瓶颈",
		currentCost: "需先测量基准",
		targetLatency: "按需求设定的延迟",
		benchCmd: "",
	}),
	style: (d) => ({
		targetStyle: "简洁清晰的风格",
		lintCmd: d.lintCmd,
	}),
	security: () => ({
		focus: "认证边界、注入漏洞、敏感数据暴露、CSRF/CORS 配置、权限校验缺失",
	}),
	explain: () => ({
		audience: "对概念感兴趣的技术读者",
		depth: "基础",
	}),
	compare: () => ({
		dimensions: "性能、生态、学习曲线、社区支持",
	}),
};

/** 注入未填字段的默认值；验收标准为空时使用项目常规验收。 */
function applyDefaults(answers: Record<string, string>, type: string, d: ProjectDefaults): void {
	const injected = FIELD_DEFAULTS[type]?.(d) ?? {};
	for (const [k, v] of Object.entries(injected)) {
		if (!answers[k]?.trim()) answers[k] = v;
	}
	if (!answers.acceptance?.trim()) answers.acceptance = defaultAcceptance(d);
}

/**
 * Run a wizard: ask questions, assemble prompt, persist it, and send to the current agent.
 */
async function runWizard(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	type: string,
	label: string,
	questions: WizardQuestion[],
	assembler: (answers: Record<string, string>) => string,
): Promise<void> {
	const answers: Record<string, string> = {};
	let idx = 0;

	while (idx >= 0 && idx < questions.length) {
		const q = questions[idx]!;
		const existingVal = answers[q.keys[0]!];
		const placeholder = existingVal
			? `(之前: ${existingVal.slice(0, 60)}) ${q.placeholder}`
			: q.placeholder;
		const val = await ask(ctx, q.label, placeholder, true, existingVal || "");
		if (val === undefined) {
			// Esc → cancel whole wizard
			return;
		}
		if (val === BACK_MARKER) {
			// Go back to previous question
			if (idx > 0) {
				idx--;
				continue;
			}
			// Already at first question → cancel
			return;
		}
		assignAnswers(answers, q, val);
		idx++;
	}

	applyDefaults(answers, type, detectProjectDefaults(ctx.cwd));
	const prompt = assembler(answers);

	// ── Guard & persist before sending ──────────────────────
	const finalPrompt = prompt || recoverFromBackup(ctx.cwd) || "";
	if (!finalPrompt) return;

	saveAnswerFile(ctx.cwd, finalPrompt);
	pi.sendUserMessage(finalPrompt, { deliverAs: "followUp" });
}

/**
 * Run a wizard with an optional Grill phase, then send to the current agent.
 */
async function runWizardWithGrill(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	type: string,
	label: string,
	questions: WizardQuestion[],
	assembler: (answers: Record<string, string>) => string,
	grillOptions?: GrillOptions,
): Promise<void> {
	const answers: Record<string, string> = {};
	let idx = 0;

	while (idx >= 0 && idx < questions.length) {
		const q = questions[idx]!;
		const existingVal = answers[q.keys[0]!];
		const placeholder = existingVal
			? `(之前: ${existingVal.slice(0, 60)}) ${q.placeholder}`
			: q.placeholder;
		const val = await ask(ctx, q.label, placeholder, true, existingVal || "");
		if (val === undefined) {
			return;
		}
		if (val === BACK_MARKER) {
			if (idx > 0) {
				idx--;
				continue;
			}
			return;
		}
		assignAnswers(answers, q, val);
		idx++;
	}

	applyDefaults(answers, type, detectProjectDefaults(ctx.cwd));
	const basePrompt = assembler(answers);

	// ── Grill phase (current agent) ─────────────────────────
	let finalPrompt = basePrompt;
	if (grillOptions) {
		const grillResult = await runGrillPhase(basePrompt, ctx, pi, {
			title: grillOptions.title,
			description: grillOptions.description,
			questionTitle: grillOptions.questionTitle,
		});
		if (grillResult.cancelled) {
			return;
		}
		finalPrompt = grillResult.enhancedPrompt;
	}

	// ── Guard & persist before sending ──────────────────────
	if (!finalPrompt) {
		const recovered = recoverFromBackup(ctx.cwd);
		if (recovered) {
			finalPrompt = recovered;
		} else {
			return;
		}
	}
	saveAnswerFile(ctx.cwd, finalPrompt);
	pi.sendUserMessage(finalPrompt, { deliverAs: "followUp" });
}

// ── Questions for each command ────────────────────────────────
// 每命令 2-5 问：核心字段 + 验收标准（可跳过，回车用默认）+ 额外补充（可跳过）。

const FEAT_QUESTIONS: WizardQuestion[] = [
	{ label: "核心功能描述（必填）", placeholder: "如 实现邮箱密码注册登录；模块/技术细节可在最后补充", keys: ["description"] },
	{ label: "验收标准（可跳过）", placeholder: "直接回车将使用默认：项目测试 + lint + pre-commit + CI 常规验收", keys: ["acceptance"] },
	{ label: "额外补充（可跳过）", placeholder: "如 目标模块 src/auth/login.ts、技术栈 NestJS、当前痛点、测试命令等", keys: ["extra"] },
];

const FIX_QUESTIONS: WizardQuestion[] = [
	{ label: "问题文件路径", placeholder: "如 src/auth/login.ts（可带 #L42）", keys: ["filePath"] },
	{ label: "Bug 现象描述", placeholder: "如 登录接口在密码正确时返回 401", keys: ["bugDesc"] },
	{ label: "验收标准（可跳过）", placeholder: "直接回车将使用默认验收标准（测试/lint/pre-commit/CI）", keys: ["acceptance"] },
	{ label: "额外补充（可跳过）", placeholder: "如 输入现象、预期行为、当前报错、测试命令等", keys: ["extra"] },
];

const DOC_QUESTIONS: WizardQuestion[] = [
	{ label: "文档对象（模块/API/doc 名称）", placeholder: "如 REST API v2、AuthService", keys: ["moduleName"] },
	{ label: "验收标准（可跳过）", placeholder: "直接回车将使用默认验收标准", keys: ["acceptance"] },
	{ label: "额外补充（可跳过）", placeholder: "如 目标受众、关键信息点、示例语言、已有材料", keys: ["extra"] },
];

const REFACTOR_QUESTIONS: WizardQuestion[] = [
	{ label: "文件路径", placeholder: "如 src/auth/login.ts（可标约行数）", keys: ["filePath"] },
	{ label: "验收标准（可跳过）", placeholder: "直接回车将使用默认验收标准", keys: ["acceptance"] },
	{ label: "额外补充（可跳过）", placeholder: "如 具体问题、重构目标、测试命令", keys: ["extra"] },
];

const TEST_QUESTIONS: WizardQuestion[] = [
	{ label: "文件路径", placeholder: "如 src/auth/login.ts", keys: ["filePath"] },
	{ label: "验收标准（可跳过）", placeholder: "直接回车将使用默认验收标准（含覆盖率与边界条件）", keys: ["acceptance"] },
	{ label: "额外补充（可跳过）", placeholder: "如 测试框架、目标覆盖率、重点边界条件、测试命令", keys: ["extra"] },
];

const CHORE_QUESTIONS: WizardQuestion[] = [
	{ label: "配置文件/目标路径", placeholder: "如 package.json、.github/workflows/ci.yml", keys: ["configPath"] },
	{ label: "具体任务", placeholder: "如 升级 eslint 到 v9、调整构建脚本", keys: ["task"] },
	{ label: "验收标准（可跳过）", placeholder: "直接回车将使用默认验收标准", keys: ["acceptance"] },
	{ label: "额外补充（可跳过）", placeholder: "如 当前环境、目标版本、验证命令", keys: ["extra"] },
];

const PERF_QUESTIONS: WizardQuestion[] = [
	{ label: "文件路径", placeholder: "如 src/services/query.ts", keys: ["filePath"] },
	{ label: "验收标准（可跳过）", placeholder: "直接回车将使用默认验收标准（含基准对比）", keys: ["acceptance"] },
	{ label: "额外补充（可跳过）", placeholder: "如 瓶颈、当前耗时/成本、目标延迟、基准命令", keys: ["extra"] },
];

const STYLE_QUESTIONS: WizardQuestion[] = [
	{ label: "待调整内容", placeholder: "如 调整以下函数的命名风格，或粘贴文本", keys: ["description"] },
	{ label: "验收标准（可跳过）", placeholder: "直接回车将使用默认验收标准（含 lint）", keys: ["acceptance"] },
	{ label: "额外补充（可跳过）", placeholder: "如 目标风格、术语统一、校验命令", keys: ["extra"] },
];

const SECURITY_QUESTIONS: WizardQuestion[] = [
	{ label: "文件路径", placeholder: "如 src/api/auth.ts", keys: ["filePath"] },
	{ label: "验收标准（可跳过）", placeholder: "直接回车将使用默认安全审查清单", keys: ["acceptance"] },
];

const EXPLAIN_QUESTIONS: WizardQuestion[] = [
	{ label: "概念名称", placeholder: "如 React Server Component、HTTP/3", keys: ["concept"] },
	{ label: "验收标准（可跳过）", placeholder: "直接回车将使用默认验收标准", keys: ["acceptance"] },
	{ label: "额外补充（可跳过）", placeholder: "如 目标受众、理解深度", keys: ["extra"] },
];

const COMPARE_QUESTIONS: WizardQuestion[] = [
	{ label: "对比对象 A", placeholder: "如 Vue 3", keys: ["itemA"] },
	{ label: "对比对象 B", placeholder: "如 React 18", keys: ["itemB"] },
	{ label: "验收标准（可跳过）", placeholder: "直接回车将使用默认验收标准", keys: ["acceptance"] },
	{ label: "额外补充（可跳过）", placeholder: "如 评估维度（性能/生态/学习曲线等）", keys: ["extra"] },
];

// ── Extension ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Auto review detection (runs in the current agent) ─────────
	pi.on("input", async (event, ctx) => {
		if (!ctx.hasUI) return { action: "continue" };
		// 扩展注入的消息（sendUserMessage，source 为 "extension"）不重入本处理器，避免无限递归
		if (event.source === "extension") return { action: "continue" };

		const text = event.text.trim().toLowerCase();

		// Detect review-html skill invocation or explicit review request.
		const isReviewSkill = text.startsWith("/skill:review-html");
		const hasReviewIntent = text.includes("review") ||
			text.includes("审查") || text.includes("审阅") || text.includes("review-html");
		const hasCodeTarget = text.includes("code") || text.includes("代码") ||
			text.includes("diff") || text.includes("commit") ||
			text.includes("html") || text.includes("report") || text.includes("报告") ||
			text.includes("本次改动") || text.includes("这次改动");
		const isReviewRequest = !isReviewSkill && hasReviewIntent && hasCodeTarget;

		if (!isReviewSkill && !isReviewRequest) return { action: "continue" };

		// ── Skill invocation: run review directly ─────────────────
		if (isReviewSkill) {
			await runReview(event.text, ctx, pi);
			return { action: "handled" };
		}

		// ── Review intent: let the user choose ────────────────────
		const mode = await uiSelect(
			ctx,
			"🔍 检测到审查意图",
			[
				"1. 后台审查(非阻塞,异步通知)",
				"2. 仅审查(阻塞,等待结果)",
				"3. 不是审查(放行给主代理)",
			],
		);

		if (!mode || mode.startsWith("3")) {
			return { action: "continue" };
		}

		const isAsync = mode.startsWith("1");

		if (isAsync) {
			ctx.ui.notify("🔍 已在后台启动代码审查，完成后会在此对话中通知您。", "info");
			// Run in the background without blocking the main conversation.
			(async () => {
				try {
					await runReview(event.text, ctx, pi);
				} catch (err) {
					console.error("[dev-prompts] Background review failed:", err);
				}
			})();
		} else {
			await runReview(event.text, ctx, pi);
		}

		return { action: "handled" };
	});

	// ── /dev-feat ──────────────────────────────────────────────
	pi.registerCommand("dev-feat", {
		description: "(prompt wizard) 新功能/创意生成 — 支持设计方案追问完善 (Grill)",
		handler: async (_args, ctx) => {
			const answers: Record<string, string> = {};
			let featIdx = 0;
			while (featIdx >= 0 && featIdx < FEAT_QUESTIONS.length) {
				const q = FEAT_QUESTIONS[featIdx]!;
				const existingVal = answers[q.keys[0]!];
				const placeholder = existingVal
					? `(之前: ${existingVal.slice(0, 60)}) ${q.placeholder}`
					: q.placeholder;
				const val = await ask(ctx, q.label, placeholder, true, existingVal || "");
				if (val === undefined) {
					return;
				}
				if (val === BACK_MARKER) {
					if (featIdx > 0) {
						featIdx--;
						continue;
					}
					return;
				}
				assignAnswers(answers, q, val);
				featIdx++;
			}

			applyDefaults(answers, "feat", detectProjectDefaults(ctx.cwd));
			const basePrompt = assembleFeatPrompt(answers as FeatFields);

			const grillResult = await runGrillPhase(basePrompt, ctx, pi, {
				title: "🔍 设计方案追问完善",
				description: "AI 会通过系统性追问帮你打磨方案：从术语精确化到边界条件验证，确保架构决策的每个分支都经过推敲。",
				questionTitle: "设计方案追问完善",
			});
			if (grillResult.cancelled) {
				return;
			}
			const finalPrompt = grillResult.enhancedPrompt || basePrompt;

			// ── PRD phase (current agent) ──────────────────────────
			await runPRDPhase(finalPrompt, (answers as FeatFields).module || "feature", pi, ctx);

			saveAnswerFile(ctx.cwd, finalPrompt);
			pi.sendUserMessage(finalPrompt, { deliverAs: "followUp" });
		},
	});

	// ── /dev-fix ───────────────────────────────────────────────
	pi.registerCommand("dev-fix", {
		description: "(prompt wizard) 问题排查/错误修正 — 支持 Bug 根因追问 (Grill)",
		handler: async (_args, ctx) => {
			await runWizardWithGrill(
				ctx, pi, "fix", "问题排查/错误修正",
				FIX_QUESTIONS, assembleFixPrompt,
				{
					title: "🐛 Bug 根因追问",
					description: "AI 会通过系统性追问帮你精准定位根因：从复现条件到根本原因推理，再到修复方案验证和回归风险评估。",
					questionTitle: "Bug 根因分析",
				},
			);
		},
	});

	// ── /dev-doc ───────────────────────────────────────────────
	pi.registerCommand("dev-doc", {
		description: "(prompt wizard) 文档生成/总结 — 支持文档大纲追问完善 (Grill)",
		handler: async (_args, ctx) => {
			await runWizardWithGrill(
				ctx, pi, "doc", "文档生成/总结",
				DOC_QUESTIONS, assembleDocPrompt,
				{
					title: "📄 文档大纲追问完善",
					description: "AI 会通过追问帮你完善文档大纲：从受众定位到结构安排，确认术语一致性和示例覆盖范围。",
					questionTitle: "文档大纲追问完善",
				},
			);
		},
	});

	// ── /dev-refactor ──────────────────────────────────────────
	pi.registerCommand("dev-refactor", {
		description: "(prompt wizard) 重构/优化现有结构 — 支持重构方案追问 (Grill)",
		handler: async (_args, ctx) => {
			await runWizardWithGrill(
				ctx, pi, "refactor", "重构/优化",
				REFACTOR_QUESTIONS, assembleRefactorPrompt,
				{
					title: "🔧 重构方案追问",
					description: "AI 会通过追问帮你识别隐藏耦合风险：从模块边界到 API 兼容性，验证行为保持和迁移路径安全性。",
					questionTitle: "重构方案追问",
				},
			);
		},
	});

	// ── /dev-test ──────────────────────────────────────────────
	pi.registerCommand("dev-test", {
		description: "(prompt wizard) 测试用例生成 — 支持测试策略追问 (Grill)",
		handler: async (_args, ctx) => {
			await runWizardWithGrill(
				ctx, pi, "test", "测试用例/评估",
				TEST_QUESTIONS, assembleTestPrompt,
				{
					title: "🧪 测试策略追问",
					description: "AI 会通过追问帮你发现测试缺口：从覆盖维度到边界条件，验证模拟策略和测试隔离是否到位。",
					questionTitle: "测试策略追问",
				},
			);
		},
	});

	// ── /dev-chore ─────────────────────────────────────────────
	pi.registerCommand("dev-chore", {
		description: "(prompt wizard) 日常维护/杂项自动化 — 交互填写后发送优化提示词给主代理",
		handler: async (_args, ctx) => {
			await runWizard(ctx, pi, "chore", "日常维护/自动化", CHORE_QUESTIONS, assembleChorePrompt);
		},
	});

	// ── /dev-perf ──────────────────────────────────────────────
	pi.registerCommand("dev-perf", {
		description: "(prompt wizard) 性能优化 — 支持性能优化方案追问 (Grill)",
		handler: async (_args, ctx) => {
			await runWizardWithGrill(
				ctx, pi, "perf", "性能优化",
				PERF_QUESTIONS, assemblePerfPrompt,
				{
					title: "⚡ 性能优化方案追问",
					description: "AI 会通过追问帮你验证瓶颈判断和优化方向：从基准测试方法到潜在回归风险，确保方案合理性。",
					questionTitle: "性能优化方案追问",
				},
			);
		},
	});

	// ── /dev-style ─────────────────────────────────────────────
	pi.registerCommand("dev-style", {
		description: "(prompt wizard) 风格/格式调整 — 交互填写后发送优化提示词给主代理",
		handler: async (_args, ctx) => {
			await runWizard(ctx, pi, "style", "风格/格式调整", STYLE_QUESTIONS, assembleStylePrompt);
		},
	});

	// ── /dev-security ──────────────────────────────────────────
	pi.registerCommand("dev-security", {
		description: "(prompt wizard) 安全审查 — 交互填写后发送优化提示词给主代理",
		handler: async (_args, ctx) => {
			await runWizard(ctx, pi, "security", "安全审查", SECURITY_QUESTIONS, assembleSecurityPrompt);
		},
	});

	// ── /dev-explain ───────────────────────────────────────────
	pi.registerCommand("dev-explain", {
		description: "(prompt wizard) 概念解释 — 交互填写后发送优化提示词给主代理",
		handler: async (_args, ctx) => {
			await runWizard(ctx, pi, "explain", "概念解释", EXPLAIN_QUESTIONS, assembleExplainPrompt);
		},
	});

	// ── /dev-compare ───────────────────────────────────────────
	pi.registerCommand("dev-compare", {
		description: "(prompt wizard) 对比评估 — 交互填写后发送优化提示词给主代理",
		handler: async (_args, ctx) => {
			await runWizard(ctx, pi, "compare", "对比评估", COMPARE_QUESTIONS, assembleComparePrompt);
		},
	});
}
