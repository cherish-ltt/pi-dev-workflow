/**
 * test-workflow-config.mjs — 验证所有 dev-* 命令正确激活 Workflow 选项
 *
 * Bug: /dev-fix 的 handler 调用 runWizardWithGrill 时未传入 workflowConfig，
 * 导致 FIX_WORKFLOW_STEPS（已定义却未使用）永远不会被触发。工作流确认对话框不出现，
 * 用户无法进入自动化工作流。
 *
 * 本测试通过静态分析源码，验证：
 *   1. 每个定义了 *_WORKFLOW_STEPS 常量的 dev-* 命令，其 handler 必须将
 *      该常量作为 workflowConfig 传给 runWizardWithGrill / runWizard，
 *      或在内联 handler 中直接调用 runWorkflow。
 *   2. 没有遗漏或「定义但未使用」的 WORKFLOW_STEPS。
 *
 * Run: node tests/test-workflow-config.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.resolve(__dirname, "../extensions/dev-prompts.ts");

// ── Helpers ──────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function assert(condition, msg) {
	if (condition) {
		pass++;
		console.log(`  ✅ ${msg}`);
	} else {
		fail++;
		console.error(`  ❌ ${msg}`);
	}
}

function assertEq(actual, expected, msg) {
	if (actual === expected) {
		pass++;
		console.log(`  ✅ ${msg}`);
	} else {
		fail++;
		console.error(`  ❌ ${msg} — 期望 ${JSON.stringify(expected)}, 得到 ${JSON.stringify(actual)}`);
	}
}

// ═══════════════════════════════════════════════════════════════
//  Read source
// ═══════════════════════════════════════════════════════════════

let source;
try {
	source = fs.readFileSync(SOURCE_PATH, "utf-8");
} catch (e) {
	console.error(`Failed to read source file: ${e.message}`);
	process.exit(1);
}

console.log(`📄 源文件: ${SOURCE_PATH}`);
console.log(`📏 文件大小: ${source.length} 字节\n`);

// ═══════════════════════════════════════════════════════════════
//  Test 1: Every *_WORKFLOW_STEPS constant is used by its handler
// ═══════════════════════════════════════════════════════════════

console.log("📋 Test 1: 所有 *_WORKFLOW_STEPS 常量被其 handler 使用\n");

// Each entry: [constantName, expectedCommandName, expectedHandlerType]
// handlerType: "runWizardWithGrill" | "runWizard" | "inline"
const workflowSteps = [
	{ const: "FEAT_WORKFLOW_STEPS",   command: "dev-feat",   type: "inline" },              // inline handler
	{ const: "FIX_WORKFLOW_STEPS",    command: "dev-fix",    type: "runWizardWithGrill" },   // was BROKEN — missing arg
	{ const: "DOC_WORKFLOW_STEPS",    command: "dev-doc",    type: "runWizardWithGrill" },   // has it
	{ const: "REFACTOR_WORKFLOW_STEPS", command: "dev-refactor", type: "runWizardWithGrill" }, // has it
	{ const: "TEST_WORKFLOW_STEPS",   command: "dev-test",   type: "runWizardWithGrill" },   // has it
	{ const: "PERF_WORKFLOW_STEPS",   command: "dev-perf",   type: "runWizardWithGrill" },   // has it
	{ const: "STYLE_WORKFLOW_STEPS",  command: "dev-style",  type: "runWizard" },            // has it
	{ const: "SECURITY_WORKFLOW_STEPS", command: "dev-security", type: "runWizard" },         // has it
];

for (const ws of workflowSteps) {
	// 1. Verify constant is defined in source
	const constDefined = source.includes(`const ${ws.const}: WorkflowStepDef[] = [`);
	assert(constDefined, `${ws.const} 应在源文件中定义`);

	// 2. Usage check: the constant name must appear in the source more than just its definition.
	//    Count occurrences of the bare constant name (e.g. "FIX_WORKFLOW_STEPS").
	//    Definition has 1 occurrence (const XXX: ...), usage adds at least 1 more.
	const bareName = ws.const;
	const allOccurrences = source.match(new RegExp(bareName, 'g'));
	const occurrenceCount = allOccurrences ? allOccurrences.length : 0;
	// Minimum: 1 for definition + 1 for usage = 2
	assert(occurrenceCount >= 2,
		`${bareName} 应至少出现 2 次 (定义 + 使用), 实际 ${occurrenceCount} 次`);
}

// ═══════════════════════════════════════════════════════════════
//  Test 2: runWizardWithGrill calls pass both grillOptions and workflowConfig
// ═════════════════──────────────────────────────────────────────
//  All runWizardWithGrill calls that have a workflowConfig should
//  have it as the last argument before the closing parenthesis.

console.log("\n📋 Test 2: runWizardWithGrill 调用完整性\n");

// Find all runWizardWithGrill(...) calls
const grillCalls = source.match(/await runWizardWithGrill\([\s\S]*?\);/g);
assert(grillCalls !== null && grillCalls.length >= 4,
	`应找到至少 4 个 runWizardWithGrill 调用，实际 ${grillCalls?.length ?? 0}`);

console.log(`   共 ${grillCalls.length} 个 runWizardWithGrill 调用`);

for (let i = 0; i < grillCalls.length; i++) {
	const call = grillCalls[i];

	// Extract the command type from the call
	const typeMatch = call.match(/await runWizardWithGrill\(\s*ctx,\s*pi,\s*"([^"]+)"/);
	const type = typeMatch ? typeMatch[1] : `#${i}`;

	// Count arguments: split by top-level commas (ignoring those inside braces/brackets)
	let depth = 0;
	let argCount = 0;
	for (const ch of call) {
		if (ch === '(' || ch === '{' || ch === '[') depth++;
		else if (ch === ')' || ch === '}' || ch === ']') depth--;
		else if (ch === ',' && depth === 1) argCount++;
	}
	// Number of arguments = commas + 1 (inside top-level parens)
	// But the last comma before `)` doesn't count, so total args = number of top-level commas + 1
	// Actually, let me recalculate: top-level commas separate args.
	// For `runWizardWithGrill(a, b, c, ...)` — the paren depth at commas inside the function call is 1.
	// The last `)` decrements depth and we shouldn't count commas after that.
	// Let me just count the number of top-level commas before the last closing paren.
	
	let topLevelCommas = 0;
	depth = 0;
	for (const ch of call) {
		if (ch === '(') depth++;
		else if (ch === ')') { depth--; if (depth === 0) break; }
		else if (ch === ',' && depth === 1) topLevelCommas++;
	}
	const totalArgs = topLevelCommas + 1;

	// runWizardWithGrill has 8 parameters (ctx, pi, type, label, questions, assembler, grillOptions?, workflowConfig?)
	// If we see 7 args → missing workflowConfig; 8 args → has workflowConfig
	const hasWorkflowConfig = totalArgs >= 8;

	assert(hasWorkflowConfig,
		`runWizardWithGrill("${type}") 应有 8 个参数 (当前 ${totalArgs}) — 缺少 workflowConfig 参数`);

	if (hasWorkflowConfig) {
		console.log(`    ✅ "${type}": ${totalArgs} 参数, workflowConfig 已传递`);
	} else {
		console.error(`    ❌ "${type}": ${totalArgs} 参数, 缺少 workflowConfig`);
	}
}

// ═══════════════════════════════════════════════════════════════
//  Test 3: Inline handlers (dev-feat) also pass workflow
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 3: 内联 handler 的 workflow 调用\n");

// dev-feat: inline handler that calls runWorkflow directly
const featHandler = source.match(/pi\.registerCommand\("dev-feat"[\s\S]*?FEAT_WORKFLOW_STEPS \}\);/);
assert(featHandler !== null, "应找到 /dev-feat handler");

const featCallsRunWorkflow = featHandler && featHandler[0].includes("await runWorkflow(ctx, pi, finalPrompt, { steps: FEAT_WORKFLOW_STEPS })");
assert(featCallsRunWorkflow, "/dev-feat 内联 handler 应调用 runWorkflow 并传递 FEAT_WORKFLOW_STEPS");

// dev-workflow-continue: also uses FEAT_WORKFLOW_STEPS
const continueHandler = source.match(/pi\.registerCommand\("dev-workflow-continue"[\s\S]*?FEAT_WORKFLOW_STEPS \}\);/);
assert(continueHandler !== null, "应找到 /dev-workflow-continue handler");
if (continueHandler) {
	assert(
		continueHandler[0].includes("{ steps: FEAT_WORKFLOW_STEPS }"),
		"/dev-workflow-continue handler 应引用 FEAT_WORKFLOW_STEPS",
	);
}

// ═══════════════════════════════════════════════════════════════
//  Test 4: runWizard calls that have workflow steps
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 4: runWizard 调用完整性\n");

// Find all runWizard(...) calls
const wizardCalls = source.match(/await runWizard\([\s\S]*?\);/g);
assert(wizardCalls !== null && wizardCalls.length >= 5,
	`应找到至少 5 个 runWizard 调用，实际 ${wizardCalls?.length ?? 0}`);

console.log(`   共 ${wizardCalls.length} 个 runWizard 调用`);

// runWizard has 7 parameters (ctx, pi, type, label, questions, assembler, workflowConfig?)
// If the command has _WORKFLOW_STEPS defined nearby, it should pass it.
const nonWorkflowCommands = ["chore", "explain", "compare"]; // intentionally no workflow

for (let i = 0; i < wizardCalls.length; i++) {
	const call = wizardCalls[i];
	const typeMatch = call.match(/await runWizard\(\s*ctx,\s*pi,\s*"([^"]+)"/);
	const type = typeMatch ? typeMatch[1] : `#${i}`;

	// Count top-level arguments
	let topLevelCommas = 0;
	let depth = 0;
	for (const ch of call) {
		if (ch === '(') depth++;
		else if (ch === ')') { depth--; if (depth === 0) break; }
		else if (ch === ',' && depth === 1) topLevelCommas++;
	}
	const totalArgs = topLevelCommas + 1;

	const expectsWorkflow = !nonWorkflowCommands.includes(type);

	if (expectsWorkflow) {
		const hasWorkflowConfig = totalArgs >= 7;
		assert(hasWorkflowConfig,
			`runWizard("${type}") 应有 7 个参数 (当前 ${totalArgs}) — 缺少 workflowConfig`);
		if (hasWorkflowConfig) {
			console.log(`    ✅ "${type}": ${totalArgs} 参数, workflowConfig 已传递`);
		}
	} else {
		// These commands intentionally don't pass workflowConfig
		const noWorkflowConfig = totalArgs <= 6;
		assert(noWorkflowConfig,
			`runWizard("${type}") 应有 6 个参数 (当前 ${totalArgs}) — 此类命令不含 workflow`);
	}
}

// ═══════════════════════════════════════════════════════════════
//  Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`结果: ${pass} 通过, ${fail} 失败, 共 ${pass + fail} 个测试`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

if (fail > 0) {
	console.error("\n⚠️  部分测试未通过");
	process.exit(1);
} else {
	console.log("\n✅ 所有测试通过 — 所有 dev-* 命令的 Workflow 配置均完整可用");
}
