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
import { waitForIdleWithTimeout } from "./session-utils";
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

/** Find the newest HTML review file in .pi-dev-output/pi-review/html/. */
function findNewestReviewHtml(cwd: string): string {
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
	try {
		await waitForIdleWithTimeout(ctx, 10 * 60_000);
	} catch {
		// Agent may have failed; check for output anyway
	}

	const dur = ((Date.now() - startTime) / 1000).toFixed(1);
	const filePath = findNewestReviewHtml(ctx.cwd);

	if (filePath) {
		ctx.ui.notify(`📄 审查报告已生成: ${filePath} (${dur}s)`, "success");
	} else {
		ctx.ui.notify(`✅ 代码审查完成 (${dur}s)`, "info");
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
	return lines.join("\n");
}

interface DocFields {
	moduleName: string;
	audience: string;
	keyInfo: string;
	language: string;
	existingMaterial: string;
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
	return lines.join("\n");
}

interface RefactorFields {
	filePath: string;
	lineCount: string;
	problems: string;
	goal: string;
	testCmd: string;
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
	return lines.join("\n");
}

interface TestFields {
	filePath: string;
	framework: string;
	coverage: string;
	edgeCases: string;
	testCmd: string;
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
	return lines.join("\n");
}

interface ChoreFields {
	configPath: string;
	task: string;
	envDesc: string;
	targetVersion: string;
	verifyCmd: string;
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
	return lines.join("\n");
}

interface PerfFields {
	filePath: string;
	bottleneck: string;
	currentCost: string;
	targetLatency: string;
	benchCmd: string;
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
	return lines.join("\n");
}

interface StyleFields {
	targetStyle: string;
	description: string;
	terms: string;
	lintCmd: string;
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
	return lines.join("\n");
}

interface SecurityFields {
	filePath: string;
	focus: string;
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
	return lines.join("\n");
}

interface ExplainFields {
	concept: string;
	audience: string;
	depth: string;
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
	return lines.join("\n");
}

interface CompareFields {
	itemA: string;
	itemB: string;
	dimensions: string;
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
	return lines.join("\n");
}

// ── Command runner ───────────────────────────────────────────

/**
 * Run a wizard: ask questions, assemble prompt, persist it, and send to the current agent.
 */
async function runWizard(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	type: string,
	label: string,
	questions: Array<{ label: string; placeholder: string; key: string }>,
	assembler: (answers: Record<string, string>) => string,
): Promise<void> {
	const answers: Record<string, string> = {};
	let idx = 0;

	while (idx >= 0 && idx < questions.length) {
		const q = questions[idx]!;
		const existingVal = answers[q.key];
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
		answers[q.key] = val;
		idx++;
	}

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
	questions: Array<{ label: string; placeholder: string; key: string }>,
	assembler: (answers: Record<string, string>) => string,
	grillOptions?: GrillOptions,
): Promise<void> {
	const answers: Record<string, string> = {};
	let idx = 0;

	while (idx >= 0 && idx < questions.length) {
		const q = questions[idx]!;
		const existingVal = answers[q.key];
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
		answers[q.key] = val;
		idx++;
	}

	const basePrompt = assembler(answers);

	// ── Grill phase (current agent) ─────────────────────────
	let finalPrompt = basePrompt;
	if (grillOptions) {
		const grillResult = await runGrillPhase(basePrompt, ctx, pi, {
			title: grillOptions.title,
			description: grillOptions.description,
			questionTitle: grillOptions.questionTitle,
			loaderLabel: grillOptions.loaderLabel,
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

const FEAT_QUESTIONS = [
	{ label: "编程语言/框架", placeholder: "如 TypeScript, Python, Rust...", key: "language" },
	{ label: "技术栈", placeholder: "如 NestJS + Prisma, React + Express...", key: "techStack" },
	{ label: "目标模块/文件名", placeholder: "如 src/auth/login.ts", key: "module" },
	{ label: "核心功能描述", placeholder: "用户可以通过邮箱+密码注册并登录", key: "description" },
	{ label: "用户痛点/当前缺少", placeholder: "当前缺少用户认证系统，每次手动校验身份", key: "painPoint" },
	{ label: "测试命令（可选）", placeholder: "如 npm test, cargo test, go test...", key: "testCmd" },
];

const FIX_QUESTIONS = [
	{ label: "文件路径", placeholder: "如 src/auth/login.ts", key: "filePath" },
	{ label: "行号（可选）", placeholder: "如 42，留空则扫描整个文件", key: "lineNumber" },
	{ label: "Bug 描述", placeholder: "登录接口在密码正确时返回 401", key: "bugDesc" },
	{ label: "输入/现象", placeholder: "输入正确邮箱和密码，返回 401 错误", key: "inputDesc" },
	{ label: "预期行为", placeholder: "应返回 200 和 token", key: "expected" },
	{ label: "当前错误信息", placeholder: "Unauthorized (401) - 不符合预期的输出", key: "actualError" },
	{ label: "测试命令（可选）", placeholder: "如 npm test, go test...", key: "testCmd" },
];

const DOC_QUESTIONS = [
	{ label: "模块/API/doc 名称", placeholder: "如 AuthService, REST API v2...", key: "moduleName" },
	{ label: "目标受众", placeholder: "如 小白 / 前端开发者 / 架构师", key: "audience" },
	{ label: "关键信息点", placeholder: "他们需要了解如何使用认证接口", key: "keyInfo" },
	{ label: "示例语言", placeholder: "如 TypeScript, Python, curl...", key: "language" },
	{ label: "已有材料（可选）", placeholder: "现有 README、笔记、文件路径等，留空则从零生成", key: "existingMaterial" },
];

const REFACTOR_QUESTIONS = [
	{ label: "文件路径", placeholder: "如 src/auth/login.ts", key: "filePath" },
	{ label: "代码行数（可选）", placeholder: "如 200 行", key: "lineCount" },
	{ label: "具体问题", placeholder: "如 重复逻辑、耦合度高、可读性差", key: "problems" },
	{ label: "重构目标", placeholder: "如 可读性 / 可维护性 / 模块化", key: "goal" },
	{ label: "测试命令（可选）", placeholder: "如 npm test, cargo test...", key: "testCmd" },
];

const TEST_QUESTIONS = [
	{ label: "文件路径", placeholder: "如 src/auth/login.ts", key: "filePath" },
	{ label: "测试框架", placeholder: "如 Jest / Vitest / pytest / Go test", key: "framework" },
	{ label: "目标覆盖率", placeholder: "如 90，留空默认 90%", key: "coverage" },
	{ label: "边界条件", placeholder: "如 null 值、空值、超时、幂等性、4xx/5xx 错误", key: "edgeCases" },
	{ label: "测试命令（可选）", placeholder: "如 npm test -- --coverage", key: "testCmd" },
];

const CHORE_QUESTIONS = [
	{ label: "配置文件/目标路径", placeholder: "如 package.json, .github/workflows/ci.yml", key: "configPath" },
	{ label: "具体任务", placeholder: "如 更新依赖、修改构建脚本、调整 CI 配置", key: "task" },
	{ label: "当前环境描述", placeholder: "如 Node 18, pnpm 8", key: "envDesc" },
	{ label: "目标版本", placeholder: "如 Node 20, pnpm 9", key: "targetVersion" },
	{ label: "验证命令（可选）", placeholder: "如 npm run build, pnpm test...", key: "verifyCmd" },
];

const PERF_QUESTIONS = [
	{ label: "文件路径", placeholder: "如 src/services/query.ts", key: "filePath" },
	{ label: "瓶颈描述", placeholder: "如 数据库查询延迟过高、内存泄漏", key: "bottleneck" },
	{ label: "当前执行耗时", placeholder: "如 5 秒 / 成本 $0.02/次", key: "currentCost" },
	{ label: "目标延迟", placeholder: "如 200ms", key: "targetLatency" },
	{ label: "基准测试命令（可选）", placeholder: "如 npm run bench, go test -bench=.", key: "benchCmd" },
];

const STYLE_QUESTIONS = [
	{ label: "目标风格", placeholder: "如 正式商务 / 幽默 / 简洁要点式 / Prettier 规范", key: "targetStyle" },
	{ label: "待调整内容描述", placeholder: "如 以下函数需要调整命名风格，或粘贴文本", key: "description" },
	{ label: "术语统一（可选）", placeholder: "如 API → 接口, user → 用户", key: "terms" },
	{ label: "Linter/格式化命令（可选）", placeholder: "如 npx prettier --check, npm run lint", key: "lintCmd" },
];

const SECURITY_QUESTIONS = [
	{ label: "文件路径", placeholder: "如 src/api/auth.ts", key: "filePath" },
	{ label: "审查重点（可选）", placeholder: "如 认证边界、注入漏洞、敏感数据暴露、CSRF/CORS、权限校验", key: "focus" },
];

const EXPLAIN_QUESTIONS = [
	{ label: "概念名称", placeholder: "如 React Server Component, HTTP/3", key: "concept" },
	{ label: "目标受众", placeholder: "如 小白 / 开发者 / 架构师", key: "audience" },
	{ label: "理解深度（可选）", placeholder: "如 基础 / 进阶，留空默认基础", key: "depth" },
];

const COMPARE_QUESTIONS = [
	{ label: "对比对象 A", placeholder: "如 Vue 3, Next.js, PostgreSQL...", key: "itemA" },
	{ label: "对比对象 B", placeholder: "如 React 18, Nuxt 3, MySQL...", key: "itemB" },
	{ label: "评估维度（可选）", placeholder: "如 性能、生态、学习曲线、社区支持", key: "dimensions" },
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
				const existingVal = answers[q.key];
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
				answers[q.key] = val;
				featIdx++;
			}

			const basePrompt = assembleFeatPrompt(answers as FeatFields);

			const grillResult = await runGrillPhase(basePrompt, ctx, pi, {
				title: "🔍 设计方案追问完善",
				description: "AI 会通过系统性追问帮你打磨方案：从术语精确化到边界条件验证，确保架构决策的每个分支都经过推敲。",
				questionTitle: "设计方案追问完善",
				loaderLabel: "🧠 AI 正在分析代码并生成追问问题...",
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
					loaderLabel: "🧠 AI 正在分析代码并生成根因追问问题...",
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
					loaderLabel: "🧠 AI 正在分析并生成文档大纲追问问题...",
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
					loaderLabel: "🧠 AI 正在分析代码并生成重构追问问题...",
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
					loaderLabel: "🧠 AI 正在分析并生成测试追问问题...",
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
					loaderLabel: "🧠 AI 正在分析并生成性能优化追问问题...",
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
