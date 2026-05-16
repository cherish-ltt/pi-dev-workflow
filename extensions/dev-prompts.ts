/**
 * Dev Prompts Extension
 *
 * Registers /dev-* commands that interactively collect missing context for
 * high-quality prompt templates (from ai提示词优化.md) and send the assembled
 * prompt directly to the main agent.
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
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runGrillPhase, runPRDPhase, type AgentDef, type GrillOptions } from "../helpers/grill-me-agent";

// ── Helpers ──────────────────────────────────────────────────

/** Ask a single question. Returns `undefined` on cancel (Esc). */
async function ask(
	ctx: ExtensionCommandContext,
	label: string,
	placeholder: string,
): Promise<string | undefined> {
	return ctx.ui.input(label, { placeholder, required: false });
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
	lines.push("**角色**：你是一个代码风格专家。");
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

// ── Specialized Agent Definitions for Grill ─────────────────

/** Bug fix root cause analysis & reproduction review. */
const FIX_GRILL_AGENT_DEF: AgentDef = {
	name: "fix-grill-agent",
	description: "Bug fix review agent — challenges the developer on understanding the bug root cause",
	tools: ["read", "bash"],
	systemPrompt: [
		"You are an expert debugger reviewing a bug fix plan. Interview the developer relentlessly.",
		"",
		"## Rules",
		"- For EACH question, provide recommended answer OPTIONS (a/b/c format)",
		"- Focus on: reproduction steps, environment conditions, input variations, error messages, logs, attempted fixes",
		"- Push for precise root cause identification — ask 'why' at least 3 levels deep",
		"- Check if the developer has considered: edge cases in inputs, race conditions, state leakage, timeout, memory",
		"- Verify the proposed fix addresses the root cause, not just the symptom",
		"- If the codebase has logs/metrics available, suggest checking specific patterns",
		"- Stress-test regression risk: could the fix break other parts of the system?",
		"- Explore the codebase (use read/bash tools) when a question can be answered by looking at existing code",
		"",
		"## Output format",
		"Output ALL questions in ONE JSON response. No preamble or explanation.",
		'Only output the JSON object: { "questions": [{ "id": 1, "question": "...", "options": ["..."] }] }',
		"",
		"## Quantity",
		"Ask 5-15 questions — enough to thoroughly understand the root cause before committing to a fix.",
		"",
		"## Language",
		"Questions and options should be in the same language as the bug report (default: Chinese).",
	].join("\n"),
	timeoutMs: 300_000,
};

/** Document outline & structure review. */
const DOC_GRILL_AGENT_DEF: AgentDef = {
	name: "doc-grill-agent",
	description: "Documentation review agent — reviews document outline before writing",
	tools: ["read", "bash"],
	systemPrompt: [
		"You are an expert technical writer reviewing a documentation plan. Interview the developer.",
		"",
		"## Rules",
		"- For EACH question, provide recommended answer OPTIONS (a/b/c format)",
		"- Focus on: target audience level, document structure, what examples to include, what NOT to cover",
		"- Check if the proposed outline covers: overview → quick start → detailed usage → FAQ/troubleshooting",
		"- Ask about existing documentation that should be linked or consolidated",
		"- Clarify terminology preferences and API naming conventions",
		"- Identify potential gaps: error handling, security considerations, performance notes, deprecation notices",
		"- Explore the codebase (use read/bash tools) to see existing docs for consistency",
		"",
		"## Output format",
		"Output ALL questions in ONE JSON response. No preamble or explanation.",
		'Only output the JSON object: { "questions": [{ "id": 1, "question": "...", "options": ["..."] }] }',
		"",
		"## Quantity",
		"Ask 3-10 questions — enough to define the scope and structure.",
		"",
		"## Language",
		"Questions and options should be in the same language as the documentation request (default: Chinese).",
	].join("\n"),
	timeoutMs: 300_000,
};

/** Refactoring plan review. */
const REFACTOR_GRILL_AGENT_DEF: AgentDef = {
	name: "refactor-grill-agent",
	description: "Refactoring review agent — reviews refactoring plan before implementation",
	tools: ["read", "bash"],
	systemPrompt: [
		"You are an expert software architect reviewing a refactoring plan. Interview the developer.",
		"",
		"## Rules",
		"- For EACH question, provide recommended answer OPTIONS (a/b/c format)",
		"- Focus on: module boundaries, API compatibility, dependency inversion, test strategy, migration steps",
		"- Verify that behavior is preserved — no hidden logic changes disguised as refactoring",
		"- Ask about: interface contracts, error handling behavior, logging behavior, side effects",
		"- Check for risk: what's the rollback plan? Can we refactor incrementally?",
		"- Ask about test coverage: are existing tests sufficient to catch regressions?",
		"- Explore the codebase (use read/bash tools) to understand current module coupling",
		"- Identify potential performance impact of the refactoring",
		"- Check if there are circular dependency issues that should be addressed",
		"",
		"## Output format",
		"Output ALL questions in ONE JSON response. No preamble or explanation.",
		'Only output the JSON object: { "questions": [{ "id": 1, "question": "...", "options": ["..."] }] }',
		"",
		"## Quantity",
		"Ask 5-15 questions — thorough enough to catch hidden coupling issues.",
		"",
		"## Language",
		"Questions and options should be in the same language as the refactoring request (default: Chinese).",
	].join("\n"),
	timeoutMs: 300_000,
};

/** Test plan coverage review. */
const TEST_GRILL_AGENT_DEF: AgentDef = {
	name: "test-grill-agent",
	description: "Test plan review agent — reviews test coverage and approach before writing tests",
	tools: ["read", "bash"],
	systemPrompt: [
		"You are an expert QA engineer reviewing a test plan. Interview the developer.",
		"",
		"## Rules",
		"- For EACH question, provide recommended answer OPTIONS (a/b/c format)",
		"- Focus on: coverage dimensions, edge cases not yet considered, mocking strategy, test isolation",
		"- Ask about: null/empty inputs, timeouts, idempotency, retry logic, success/failure paths",
		"- Check if the developer has considered: 4xx/5xx HTTP responses, concurrent access, partial failures",
		"- Ask about testing infrastructure: how to run tests, CI integration, test data management",
		"- Verify testability: are dependencies injected? Can we mock external services?",
		"- Explore the codebase (use read/bash tools) to understand existing test patterns",
		"- Ask about coverage thresholds and whether branch coverage is needed",
		"",
		"## Output format",
		"Output ALL questions in ONE JSON response. No preamble or explanation.",
		'Only output the JSON object: { "questions": [{ "id": 1, "question": "...", "options": ["..."] }] }',
		"",
		"## Quantity",
		"Ask 5-12 questions — enough to define a thorough test strategy.",
		"",
		"## Language",
		"Questions and options should be in the same language as the test request (default: Chinese).",
	].join("\n"),
	timeoutMs: 300_000,
};

/** Performance optimization plan review. */
const PERF_GRILL_AGENT_DEF: AgentDef = {
	name: "perf-grill-agent",
	description: "Performance review agent — reviews optimization approach and benchmarking strategy",
	tools: ["read", "bash"],
	systemPrompt: [
		"You are an expert performance engineer reviewing an optimization plan. Interview the developer.",
		"",
		"## Rules",
		"- For EACH question, provide recommended answer OPTIONS (a/b/c format)",
		"- Focus on: benchmarking methodology, measurement tools, baseline metrics, optimization approaches",
		"- Verify the bottleneck identification: is it really the bottleneck? What's the evidence?",
		"- Ask about: existing profiling data, hot paths, memory vs CPU trade-offs",
		"- Check if simpler solutions exist (e.g., caching before algorithm rewrite)",
		"- Ask about regression risk: could the optimization introduce correctness issues?",
		"- Explore the codebase (use read/bash tools) to understand current implementation",
		"- Ask about monitoring: how will we measure the improvement in production?",
		"- Challenge assumptions: is this optimization premature? What's the user-facing impact?",
		"",
		"## Output format",
		"Output ALL questions in ONE JSON response. No preamble or explanation.",
		'Only output the JSON object: { "questions": [{ "id": 1, "question": "...", "options": ["..."] }] }',
		"",
		"## Quantity",
		"Ask 5-12 questions — enough to validate the approach before implementation.",
		"",
		"## Language",
		"Questions and options should be in the same language as the optimization request (default: Chinese).",
	].join("\n"),
	timeoutMs: 300_000,
};

// ── Command runner ───────────────────────────────────────────

/**
 * Run a wizard with an optional Grill phase:
 * Wizard → Assemble → (Grill?) → Send
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
	ctx.ui.notify(`📋 /dev-${type} — ${label}，请逐项填写以下信息（留空跳过对应段落，Esc 取消）`, "info");

	const answers: Record<string, string> = {};
	for (const q of questions) {
		const val = await ask(ctx, q.label, q.placeholder);
		if (val === undefined) {
			ctx.ui.notify("❌ 已取消", "warning");
			return;
		}
		answers[q.key] = val;
	}

	const basePrompt = assembler(answers);

	// ── Grill phase (if agentDef provided) ────────────────────
	let finalPrompt = basePrompt;
	if (grillOptions) {
		const grillResult = await runGrillPhase(basePrompt, ctx, {
			agentDef: grillOptions.agentDef,
			title: grillOptions.title,
			description: grillOptions.description,
			questionTitle: grillOptions.questionTitle,
			loaderLabel: grillOptions.loaderLabel,
		});
		if (grillResult.cancelled) {
			ctx.ui.notify("❌ 操作已取消", "warning");
			return;
		}
		finalPrompt = grillResult.enhancedPrompt;
	}

	ctx.ui.notify(`✅ 提示词已组装完成，正在发送给主代理...`, "success");
	pi.sendUserMessage(finalPrompt);
	ctx.ui.notify(`📝 /dev-${type} 提示词已投递，主代理正在处理`, "info");
}

/**
 * Run a wizard: ask questions, assemble prompt, send to agent.
 * @param ctx     Command context
 * @param pi      Extension API (for sendUserMessage)
 * @param type    Display name of the prompt type (e.g. "feat")
 * @param label   Friendly label (e.g. "新功能/创意生成")
 * @param questions  Array of [label, placeholder] pairs
 * @param assembler  Function that takes answers and returns the prompt string
 */
async function runWizard(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	type: string,
	label: string,
	questions: Array<{ label: string; placeholder: string; key: string }>,
	assembler: (answers: Record<string, string>) => string,
): Promise<void> {
	ctx.ui.notify(`📋 /dev-${type} — ${label}，请逐项填写以下信息（留空跳过对应段落，Esc 取消）`, "info");

	const answers: Record<string, string> = {};

	for (const q of questions) {
		const val = await ask(ctx, q.label, q.placeholder);
		if (val === undefined) {
			ctx.ui.notify("❌ 已取消", "warning");
			return;
		}
		answers[q.key] = val;
	}

	const prompt = assembler(answers);
	ctx.ui.notify(`✅ 提示词已组装完成，正在发送给主代理...`, "success");

	// Send the assembled prompt to the main agent
	pi.sendUserMessage(prompt);

	// Also show the prompt in a notification for reference
	ctx.ui.notify(`📝 /dev-${type} 提示词已投递，主代理正在处理`, "info");
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
	// ── /dev-feat ──────────────────────────────────────────────
	pi.registerCommand("dev-feat", {
		description: "(prompt wizard) 新功能/创意生成 — 支持设计评审 (Grill) + PRD 生成",
		handler: async (_args, ctx) => {
			// ── Phase 1: Wizard ──────────────────────────────────
			ctx.ui.notify("📋 /dev-feat — 新功能/创意生成，请逐项填写以下信息（留空跳过对应段落，Esc 取消）", "info");

			const answers: Record<string, string> = {};
			for (const q of FEAT_QUESTIONS) {
				const val = await ask(ctx, q.label, q.placeholder);
				if (val === undefined) {
					ctx.ui.notify("❌ 已取消", "warning");
					return;
				}
				answers[q.key] = val;
			}

			// ── Phase 2: Assemble base prompt ───────────────────
			const basePrompt = assembleFeatPrompt(answers as FeatFields);
			ctx.ui.notify(`✅ 基本信息已收集，共 ${FEAT_QUESTIONS.length} 项`, "success");

			// ── Phase 3: Grill (设计评审) ───────────────────────
			const grillResult = await runGrillPhase(basePrompt, ctx);
			if (grillResult.cancelled) {
				ctx.ui.notify("❌ 操作已取消", "warning");
				return;
			}
			const finalPrompt = grillResult.enhancedPrompt;

			// ── Phase 4: Send to main agent ─────────────────────
			ctx.ui.notify(`✅ 提示词已组装完成，正在发送给主代理...`, "success");
			pi.sendUserMessage(finalPrompt);
			ctx.ui.notify(`📝 /dev-feat 提示词已投递，主代理正在处理`, "info");

			// ── Phase 5: Wait for agent to finish ───────────────
			await ctx.waitForIdle();

			// ── Phase 6: PRD generation ─────────────────────────
			const moduleHint = (answers as FeatFields).module || "feature";
			const grillContext = finalPrompt;
			await runPRDPhase(grillContext, moduleHint, pi, ctx);
		},
	});

	// ── /dev-fix ───────────────────────────────────────────────
	pi.registerCommand("dev-fix", {
		description: "(prompt wizard) 问题排查/错误修正 — 支持根因分析评审 (Grill)",
		handler: async (_args, ctx) => {
			await runWizardWithGrill(
				ctx, pi, "fix", "问题排查/错误修正",
				FIX_QUESTIONS, assembleFixPrompt,
				{
					agentDef: FIX_GRILL_AGENT_DEF,
					title: "🐛 Bug 根因分析评审",
					description: "是否进入 Bug 根因分析评审 (Grill) 模式？\nAI 会从复现条件、根因推理、修复方案、回归风险等维度挑战你的理解。",
					questionTitle: "Bug 根因分析",
					loaderLabel: "🧠 AI 正在分析代码并生成根因评审问题...",
				},
			);
		},
	});

	// ── /dev-doc ───────────────────────────────────────────────
	pi.registerCommand("dev-doc", {
		description: "(prompt wizard) 文档生成/总结 — 支持大纲评审 (Grill)",
		handler: async (_args, ctx) => {
			await runWizardWithGrill(
				ctx, pi, "doc", "文档生成/总结",
				DOC_QUESTIONS, assembleDocPrompt,
				{
					agentDef: DOC_GRILL_AGENT_DEF,
					title: "📄 文档大纲评审",
					description: "是否进入文档大纲评审 (Grill) 模式？\nAI 会从受众定位、结构安排、示例选择等维度审视你的文档计划。",
					questionTitle: "文档大纲评审",
					loaderLabel: "🧠 AI 正在分析并生成文档大纲评审问题...",
				},
			);
		},
	});

	// ── /dev-refactor ──────────────────────────────────────────
	pi.registerCommand("dev-refactor", {
		description: "(prompt wizard) 重构/优化现有结构 — 支持重构计划评审 (Grill)",
		handler: async (_args, ctx) => {
			await runWizardWithGrill(
				ctx, pi, "refactor", "重构/优化",
				REFACTOR_QUESTIONS, assembleRefactorPrompt,
				{
					agentDef: REFACTOR_GRILL_AGENT_DEF,
					title: "🔧 重构方案评审",
					description: "是否进入重构方案评审 (Grill) 模式？\nAI 会从模块边界、API 兼容性、测试策略、迁移风险等维度审视你的重构计划。",
					questionTitle: "重构方案评审",
					loaderLabel: "🧠 AI 正在分析代码并生成重构评审问题...",
				},
			);
		},
	});

	// ── /dev-test ──────────────────────────────────────────────
	pi.registerCommand("dev-test", {
		description: "(prompt wizard) 测试用例生成 — 支持测试计划评审 (Grill)",
		handler: async (_args, ctx) => {
			await runWizardWithGrill(
				ctx, pi, "test", "测试用例/评估",
				TEST_QUESTIONS, assembleTestPrompt,
				{
					agentDef: TEST_GRILL_AGENT_DEF,
					title: "🧪 测试计划评审",
					description: "是否进入测试计划评审 (Grill) 模式？\nAI 会从覆盖维度、边界条件、模拟策略等角度审视你的测试方案。",
					questionTitle: "测试计划评审",
					loaderLabel: "🧠 AI 正在分析并生成测试评审问题...",
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
		description: "(prompt wizard) 性能优化 — 支持优化方案评审 (Grill)",
		handler: async (_args, ctx) => {
			await runWizardWithGrill(
				ctx, pi, "perf", "性能优化",
				PERF_QUESTIONS, assemblePerfPrompt,
				{
					agentDef: PERF_GRILL_AGENT_DEF,
					title: "⚡ 性能优化方案评审",
					description: "是否进入性能优化方案评审 (Grill) 模式？\nAI 会从基准测试方法、优化方向、回归风险等维度审视你的方案。",
					questionTitle: "性能优化方案评审",
					loaderLabel: "🧠 AI 正在分析并生成性能优化评审问题...",
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
