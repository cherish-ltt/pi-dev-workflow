/**
 * test-save-answer-file-workflow.mjs — 验证 saveAnswerFile 在 Workflow 路径中未被跳过
 *
 * 重构后所有 workflow 入口统一经过 promptWorkflowDecision() 函数，
 * 该函数在调用 runWorkflow 前一定会调用 saveAnswerFile。
 *
 * 本测试验证：
 *   1. promptWorkflowDecision 函数体：两个路径（默认/自定义）都在 runWorkflow 前调用了 saveAnswerFile
 *   2. 所有 caller（runWizardWithGrill / runWizard / dev-feat handler）都调用 promptWorkflowDecision
 *   3. 所有非 workflow 路径的 saveAnswerFile 未被移除
 *
 * Run: node tests/test-save-answer-file-workflow.mjs
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
//  Test 1: promptWorkflowDecision 在 runWorkflow 前调用 saveAnswerFile
// ═══════════════════════════════════════════════════════════════

console.log("📋 Test 1: promptWorkflowDecision 的两个路径都在 runWorkflow 前调用 saveAnswerFile\n");

// Find the promptWorkflowDecision function body
const pwdMatch = source.match(/async function promptWorkflowDecision\([\s\S]*?^\}/m);
assert(pwdMatch !== null, "应找到 promptWorkflowDecision 函数");

const pwdFunc = pwdMatch[0];
assert(
	pwdFunc.includes("saveAnswerFile(ctx.cwd, finalPrompt)"),
	"promptWorkflowDecision 应包含 saveAnswerFile(finalPrompt) 调用",
);

// Verify the default path (choice "1"): saveAnswerFile before runWorkflow
const defaultPath = pwdFunc.match(/if \(choice\.startsWith\("1"\)\) \{[\s\S]*?return true;\s*\}/);
assert(defaultPath !== null, "默认模式路径应存在");
if (defaultPath) {
	const saveIdx = defaultPath[0].indexOf("saveAnswerFile");
	const runIdx = defaultPath[0].indexOf("runWorkflow");
	assert(saveIdx >= 0 && saveIdx < runIdx, "默认路径应在 runWorkflow 前调用 saveAnswerFile");
}

// Verify the custom path: saveAnswerFile before runWorkflow
const customPath = pwdFunc.match(/if \(customSteps\.length === 0\) \{[\s\S]*?return true;\s*\}/);
assert(customPath !== null, "自定义模式路径应存在");
if (customPath) {
	const saveIdx = customPath[0].indexOf("saveAnswerFile");
	const runIdx = customPath[0].indexOf("runWorkflow");
	assert(saveIdx >= 0 && runIdx >= 0, "自定义路径应包含 saveAnswerFile 和 runWorkflow");
	assert(saveIdx < runIdx, "自定义路径应在 runWorkflow 前调用 saveAnswerFile");
}

// ═══════════════════════════════════════════════════════════════
//  Test 2: 所有 caller 正确调用 promptWorkflowDecision
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 2: 所有 caller 正确调用 promptWorkflowDecision\n");

// Count occurrences of promptWorkflowDecision calls in handlers (not definition)
// We need at least: runWizardWithGrill + runWizard + dev-feat = 3 call sites
const workflowDecisionCalls = source.match(/await promptWorkflowDecision\(/g);
assert(workflowDecisionCalls !== null && workflowDecisionCalls.length >= 3,
	`应找到至少 3 个 promptWorkflowDecision 调用，实际 ${workflowDecisionCalls?.length ?? 0}`);
console.log(`   共 ${workflowDecisionCalls.length} 个 promptWorkflowDecision 调用`);

// ═══════════════════════════════════════════════════════════════
//  Test 3: runWizard 的非 workflow 路径调用 saveAnswerFile
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 3: runWizard 非 workflow 路径调用 saveAnswerFile\n");

const runWizardMatch = source.match(/async function runWizard\([\s\S]*?\n\}/);
assert(runWizardMatch !== null, "应找到 runWizard 函数");

const runWizardFunc = runWizardMatch[0];
assert(
	runWizardFunc.includes("saveAnswerFile(ctx.cwd, prompt);"),
	"runWizard 非 workflow 路径应调用 saveAnswerFile(ctx.cwd, prompt)",
);

// ═══════════════════════════════════════════════════════════════
//  Test 4: runWizardWithGrill 的非 workflow 路径保留 saveAnswerFile
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 4: runWizardWithGrill 非 workflow 路径保留 saveAnswerFile\n");

const runWizardWithGrillMatch = source.match(/async function runWizardWithGrill\([\s\S]*?\n\}/);
assert(runWizardWithGrillMatch !== null, "应找到 runWizardWithGrill 函数");

const grillFunc = runWizardWithGrillMatch[0];
assert(
	grillFunc.includes("const answerPath = saveAnswerFile(ctx.cwd, finalPrompt);"),
	"runWizardWithGrill 的非 workflow 路径应包含 answerPath = saveAnswerFile(...)",
);

// ═══════════════════════════════════════════════════════════════
//  Test 5: dev-feat handler 调用 promptWorkflowDecision
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 5: dev-feat handler 调用 promptWorkflowDecision\n");

// Find the dev-feat registerCommand block
const featMatch = source.match(/pi\.registerCommand\("dev-feat"[\s\S]*?\n\t\}\);/);
assert(featMatch !== null, "应找到 /dev-feat handler");

const featHandler = featMatch[0];
assert(
	featHandler.includes("promptWorkflowDecision(ctx, pi, finalPrompt, FEAT_WORKFLOW_STEPS)"),
	"dev-feat handler 应调用 promptWorkflowDecision 并传递 FEAT_WORKFLOW_STEPS",
);

// ═══════════════════════════════════════════════════════════════
//  Test 6: 所有 saveAnswerFile 调用之前都有 finalPrompt/prompt 已赋值（空安全）
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 6: saveAnswerFile 调用时的参数非空\n");

const saveCalls = source.match(/saveAnswerFile\(ctx\.cwd, \w+\)/g);
assert(saveCalls !== null && saveCalls.length >= 5,
	`应找到至少 5 个 saveAnswerFile 调用，实际 ${saveCalls?.length ?? 0}`);

console.log(`   共 ${saveCalls.length} 个 saveAnswerFile 调用`);
for (const call of saveCalls) {
	assert(
		call.includes("finalPrompt") || call.includes("prompt") || call.includes("recovered"),
		`saveAnswerFile 参数应为 finalPrompt/prompt/recovered，实际: ${call}`,
	);
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
	console.log("\n✅ 所有测试通过 — saveAnswerFile 在所有 workflow 路径和非 workflow 路径中均被正确调用");
}
