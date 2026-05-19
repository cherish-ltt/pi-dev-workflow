/**
 * test-save-answer-file-workflow.mjs — 验证 saveAnswerFile 在 Workflow 路径中未被跳过
 *
 * Bug: 当用户进入自动化工作流时，handler 在调用 runWorkflow 后立即 return，
 * 导致 workflow 路径后的 saveAnswerFile 调用被绕过，prompt 不会持久化到
 * pi-dev-output/pi-grill/answer-xxx.md。
 *
 * 本测试通过静态分析源码，验证所有进入 workflow 的分支在此之前都已调用 saveAnswerFile。
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

function assertNe(actual, unexpected, msg) {
	if (actual !== unexpected) {
		pass++;
		console.log(`  ✅ ${msg}`);
	} else {
		fail++;
		console.error(`  ❌ ${msg} — 不应等于 ${JSON.stringify(unexpected)}`);
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
//  Test 1: All "enterWorkflow" branches must call saveAnswerFile BEFORE runWorkflow
// ═══════════════════════════════════════════════════════════════

console.log("📋 Test 1: 所有 workflow 入口分支在 runWorkflow 前调用 saveAnswerFile\n");

// Pattern: look for each `if (enterWorkflow) {` block and verify
// it contains saveAnswerFile BEFORE the runWorkflow call.
const workflowBranches = source.match(/if \(enterWorkflow\) \{[\s\S]*?await runWorkflow\([^;]+\);/g);
assert(workflowBranches !== null && workflowBranches.length > 0, "应找到至少一个 workflow 分支");

console.log(`   发现 ${workflowBranches.length} 个 workflow 分支`);

for (let i = 0; i < workflowBranches.length; i++) {
	const branch = workflowBranches[i];
	const hasSaveBeforeRun = branch.indexOf("saveAnswerFile") < branch.indexOf("await runWorkflow");
	assert(hasSaveBeforeRun, `workflow 分支 #${i + 1} 应在 runWorkflow 前调用 saveAnswerFile`);
}

// ═══════════════════════════════════════════════════════════════
//  Test 2: runWizard 的非 workflow 路径也必须调用 saveAnswerFile
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 2: runWizard 非 workflow 路径调用 saveAnswerFile\n");

// Find the runWizard function and check the non-workflow path
// It should have saveAnswerFile before pi.sendUserMessage
const runWizardMatch = source.match(/async function runWizard\([\s\S]*?\n\}/);
assert(runWizardMatch !== null, "应找到 runWizard 函数");

const runWizardFunc = runWizardMatch[0];

// In runWizard, after the workflow block, there should be a saveAnswerFile call
const afterWorkflowInRunWizard = runWizardFunc.split("if (enterWorkflow)")[1];
// There should be a saveAnswerFile call after the closing brace of the workflow if block
assert(
	runWizardFunc.includes("saveAnswerFile(ctx.cwd, prompt);"),
	"runWizard 非 workflow 路径应调用 saveAnswerFile",
);

// ═══════════════════════════════════════════════════════════════
//  Test 3: runWizardWithGrill 的非 workflow 路径原有 saveAnswerFile 未被移除
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 3: runWizardWithGrill 非 workflow 路径保留 saveAnswerFile\n");

// Find the runWizardWithGrill function
const runWizardWithGrillMatch = source.match(/async function runWizardWithGrill\([\s\S]*?\n\}/);
assert(runWizardWithGrillMatch !== null, "应找到 runWizardWithGrill 函数");

const grillFunc = runWizardWithGrillMatch[0];
assert(
	grillFunc.includes("const answerPath = saveAnswerFile(ctx.cwd, finalPrompt);"),
	"runWizardWithGrill 的非 workflow 路径应包含 answerPath = saveAnswerFile(...)",
);

// ═══════════════════════════════════════════════════════════════
//  Test 4: /dev-feat inline handler workflow 路径也调用 saveAnswerFile
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 4: /dev-feat handler workflow 路径调用 saveAnswerFile\n");

// Find the dev-feat registerCommand block
const featMatch = source.match(/pi\.registerCommand\("dev-feat"[\s\S]*?FEAT_WORKFLOW_STEPS \}\);/);
assert(featMatch !== null, "应找到 /dev-feat handler");

const featHandler = featMatch[0];
// Check the workflow branch
const featWorkflowBranch = featHandler.match(/if \(enterWorkflow\) \{[\s\S]*?await runWorkflow\([^;]+\);/);
assert(featWorkflowBranch !== null, "dev-feat handler 应包含 workflow 分支");

// Check saveAnswerFile appears before runWorkflow in this branch
const beforeRunIdx = featWorkflowBranch[0].indexOf("await runWorkflow");
const saveIdx = featWorkflowBranch[0].indexOf("saveAnswerFile");
assert(
	saveIdx >= 0 && saveIdx < beforeRunIdx,
	"dev-feat workflow 分支应在 runWorkflow 前调用 saveAnswerFile",
);

console.log(`    saveAnswerFile 在位置 ${saveIdx}, runWorkflow 在位置 ${beforeRunIdx}`);

// ═══════════════════════════════════════════════════════════════
//  Test 5: 所有 saveAnswerFile 调用之前都有 finalPrompt/prompt 已赋值（空安全）
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 5: saveAnswerFile 调用时的参数非空\n");

// Count all saveAnswerFile(ctx.cwd, ...) calls
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
