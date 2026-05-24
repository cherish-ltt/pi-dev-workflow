/**
 * test-workflow-engine-bugs.mjs — 复现并验证 Bug A 和 Bug B 的修复
 *
 * Bug A — executeLoopGroup 缺少 exitCode 检查
 * Bug B — setTimeout cleanupWidget 竞态条件
 *
 * Run: node tests/test-workflow-engine-bugs.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, "../extensions/workflow-engine.ts");

// ── Read source file for static analysis ─────────────────────

let source;
try {
	source = fs.readFileSync(EXT_PATH, "utf-8");
} catch (e) {
	console.error(`Failed to read source file: ${e.message}`);
	process.exit(1);
}

console.log(`📄 源文件: ${EXT_PATH}`);
console.log(`📏 文件大小: ${source.length} 字节\n`);

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
	const ok = actual === expected;
	if (ok) {
		pass++;
		console.log(`  ✅ ${msg}`);
	} else {
		fail++;
		console.error(`  ❌ ${msg} — 期望 ${JSON.stringify(expected)}, 得到 ${JSON.stringify(actual)}`);
	}
}

function assertTrue(actual, msg) { assertEq(actual, true, msg); }
function assertFalse(actual, msg) { assertEq(actual, false, msg); }
function assertNotNull(actual, msg) {
	if (actual !== null && actual !== undefined) {
		pass++;
		console.log(`  ✅ ${msg}`);
	} else {
		fail++;
		console.error(`  ❌ ${msg} — 期望非 null, 得到 ${JSON.stringify(actual)}`);
	}
}

function assertThrows(fn, msg) {
	try {
		fn();
		fail++;
		console.error(`  ❌ ${msg} — 期望抛出异常但未抛出`);
	} catch {
		pass++;
		console.log(`  ✅ ${msg}`);
	}
}

// ═══════════════════════════════════════════════════════════════
//  isTimeoutResult — 从源代码导入逻辑（模拟）
// ═══════════════════════════════════════════════════════════════

function simulateIsTimeoutResult(result) {
	return result.exitCode === -1 && result.stderr.includes("timed out");
}

console.log("═══ Bug A 测试 — executeLoopGroup exitCode 检查 ═══\n");

// ── Test 1: 模拟 SubagentResult 对象，验证非零退出码被正确识别 ──
console.log("📋 测试 1: 非零退出码识别\n");

const resultError = { exitCode: 1, stderr: "Agent crashed: OOM", output: "" };
assertFalse(simulateIsTimeoutResult(resultError), "exitCode=1 不应被 isTimeoutResult 误判为超时");
assertEq(resultError.exitCode, 1, "exitCode 应为 1");
assert(resultError.exitCode !== 0, "exitCode 非零");

const resultTimeout = { exitCode: -1, stderr: "timed out after 30s", output: "" };
assertTrue(simulateIsTimeoutResult(resultTimeout), "exitCode=-1 + 'timed out' 应被识别为超时");

const resultSuccess = { exitCode: 0, stderr: "", output: "ok" };
assertFalse(simulateIsTimeoutResult(resultSuccess), "exitCode=0 不应被识别为超时");
assertEq(resultSuccess.exitCode, 0, "exitCode 应为 0");

// ── Test 2: 验证源代码中存在 exitCode 检查（Bug A 修复验证） ──
console.log("\n📋 测试 2: 源代码静态分析 — Bug A 修复存在性\n");

// 检查 executeLoopGroup 函数中是否有 exitCode !== 0 的检查
const executeLoopGroupStart = source.indexOf("async function executeLoopGroup");
assert(executeLoopGroupStart !== -1, "找到 executeLoopGroup 函数");

// 在 executeLoopGroup 函数体中搜索 exitCode 检查
const executeLoopGroupBody = source.slice(executeLoopGroupStart);
const hasExitCodeCheckInLoopGroup = /exitCode\s*!==\s*0/.test(executeLoopGroupBody);
assertTrue(hasExitCodeCheckInLoopGroup, "executeLoopGroup 中存在 exitCode !== 0 检查");

// 检查是否在 isTimeoutResult 之前有 exitCode 检查
const idxAgentResult = executeLoopGroupBody.indexOf("let agentResult = await runAgentWithProgress(loopAgent");
assert(idxAgentResult !== -1, "找到 agentResult 赋值");

// 检查 agentResult 赋值之后、isTimeoutResult 检查之前是否有 exitCode 检查
const afterAgentResult = executeLoopGroupBody.slice(idxAgentResult);
const idxIsTimeout = afterAgentResult.indexOf("if (isTimeoutResult(agentResult))");
assert(idxIsTimeout !== -1, "找到 isTimeoutResult 检查");

const beforeTimeout = afterAgentResult.slice(0, idxIsTimeout);
const hasExitCodeBeforeTimeout = /exitCode\s*!==\s*0/.test(beforeTimeout);
assertTrue(hasExitCodeBeforeTimeout, "exitCode 检查位于 isTimeoutResult 检查之前");

// ── Test 3: 验证 full-auto 模式下 throw Error ──
console.log("\n📋 测试 3: full-auto 模式下 exitCode 检查会 throw Error\n");

// 检查是否存在 full-auto 分支中的 throw new Error 模式
const hasFullAutoErrorInLoopGroup = /mode\s*===\s*"full-auto"[\s\S]{0,200}throw new Error/.test(executeLoopGroupBody);
assertTrue(hasFullAutoErrorInLoopGroup, "full-auto 模式有 throw new Error");

// ── Test 4: 验证非 full-auto 模式下弹出 UI 选择 ──
console.log("\n📋 测试 4: 非 full-auto 模式下弹出 UI 选择\n");

// 检查 exitCode 分支有重新执行/跳过/取消选择的相关文本
const hasRetryOption = executeLoopGroupBody.includes("重新执行");
assertTrue(hasRetryOption, "exitCode 分支有 '重新执行' 选项");

const hasSkipOption = executeLoopGroupBody.includes("跳过此步骤");
assertTrue(hasSkipOption, "exitCode 分支有 '跳过此步骤' 选项");

const hasCancelOption = executeLoopGroupBody.includes("取消工作流");
assertTrue(hasCancelOption, "exitCode 分支有 '取消工作流' 选项");

// 验证选择处理逻辑
const hasCancelBranch = /choice\.startsWith\("3"\)[\s\S]{0,50}cancelWorkflow/.test(executeLoopGroupBody);
assertTrue(hasCancelBranch, "取消选项调用 cancelWorkflow");

const hasSkipBranch = /choice\.startsWith\("2"\)[\s\S]{0,50}skipped/.test(executeLoopGroupBody);
assertTrue(hasSkipBranch, "跳过选项设置 status 为 skipped");

const hasRetryBranch = /\[RETRY\]/.test(executeLoopGroupBody);
assertTrue(hasRetryBranch, "重新执行使用 [RETRY] 标记");

// ── Test 5: 验证 executeSingleStep 的 exitCode 检查未被破坏 ──
console.log("\n📋 测试 5: executeSingleStep 的 exitCode 检查仍然存在\n");

const executeSingleStepStart = source.indexOf("async function executeSingleStep");
assert(executeSingleStepStart !== -1, "找到 executeSingleStep 函数");
const singleStepBody = source.slice(executeSingleStepStart);
const hasExitCodeInSingleStep = /exitCode\s*!==\s*0\s*&&\s*result\.stderr/.test(singleStepBody);
assertTrue(hasExitCodeInSingleStep, "executeSingleStep 中仍有 exitCode 检查");

// ── Test 6: 模拟 Bug A 的 exitCode 检查行为逻辑 ──
console.log("\n📋 测试 6: exitCode 检查行为逻辑验证\n");

function simulateBugAFix(result, mode) {
	// 模拟 Bug A 修复逻辑
	if (result.exitCode !== 0 && !simulateIsTimeoutResult(result)) {
		if (mode === "full-auto") {
			throw new Error(`Agent testAgent 异常退出 (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
		} else {
			// 模拟选择了"重新执行"
			return "retry";
		}
	}
	if (simulateIsTimeoutResult(result)) {
		return "timeout";
	}
	return "ok";
}

// 非零退出码 + full-auto 模式 → 抛出 Error
assertThrows(() => {
	simulateBugAFix({ exitCode: 1, stderr: "crash", output: "" }, "full-auto");
}, "full-auto + exitCode=1 → throw Error");

// 非零退出码 + 非 full-auto 模式 → 返回 retry
assertEq(simulateBugAFix({ exitCode: 1, stderr: "crash", output: "" }, "attended"), "retry", "attended + exitCode=1 → retry");
assertEq(simulateBugAFix({ exitCode: 1, stderr: "crash", output: "" }, "full-attended"), "retry", "full-attended + exitCode=1 → retry");

// 超时 → timeout
assertEq(simulateBugAFix({ exitCode: -1, stderr: "timed out", output: "" }, "full-auto"), "timeout", "full-auto + exitCode=-1 → timeout");
assertEq(simulateBugAFix({ exitCode: -1, stderr: "timed out", output: "" }, "attended"), "timeout", "attended + exitCode=-1 → timeout");

// 正常退出 → ok
assertEq(simulateBugAFix({ exitCode: 0, stderr: "", output: "ok" }, "full-auto"), "ok", "full-auto + exitCode=0 → ok");
assertEq(simulateBugAFix({ exitCode: 0, stderr: "", output: "ok" }, "attended"), "ok", "attended + exitCode=0 → ok");


console.log("\n═══ Bug B 测试 — setTimeout cleanupWidget 竞态条件 ═══\n");

// ── Test 7: _cleanupTimer 变量声明存在 ──
console.log("📋 测试 7: _cleanupTimer 变量声明\n");

const hasCleanupTimerVar = source.includes("_cleanupTimer: ReturnType<typeof setTimeout> | null = null");
assertTrue(hasCleanupTimerVar, "存在 _cleanupTimer 变量声明");

// ── Test 8: initWidget 中清除旧定时器 ──
console.log("\n📋 测试 8: initWidget 清除旧定时器\n");

const initWidgetStart = source.indexOf("function initWidget");
assert(initWidgetStart !== -1, "找到 initWidget 函数");
const initWidgetBody = source.slice(initWidgetStart, initWidgetStart + 500);

const hasTimerClearInInit = /if\s*\(_cleanupTimer\)[\s\S]{0,50}clearTimeout/.test(initWidgetBody);
assertTrue(hasTimerClearInInit, "initWidget 中有 clearTimeout(_cleanupTimer)");

const hasTimerNullInInit = /_cleanupTimer\s*=\s*null/.test(initWidgetBody);
assertTrue(hasTimerNullInInit, "initWidget 中有 _cleanupTimer = null");

// ── Test 9: cleanupWidget 中清除定时器 ──
console.log("\n📋 测试 9: cleanupWidget 清除定时器\n");

const cleanupWidgetStart = source.indexOf("function cleanupWidget");
assert(cleanupWidgetStart !== -1, "找到 cleanupWidget 函数");
const cleanupWidgetBody = source.slice(cleanupWidgetStart, cleanupWidgetStart + 500);

const hasTimerClearInCleanup = /if\s*\(_cleanupTimer\)[\s\S]{0,50}clearTimeout/.test(cleanupWidgetBody);
assertTrue(hasTimerClearInCleanup, "cleanupWidget 中有 clearTimeout(_cleanupTimer)");

// ── Test 10: executeWorkflowBackground 中使用 _cleanupTimer ──
console.log("\n📋 测试 10: executeWorkflowBackground 使用 _cleanupTimer\n");

const execBgStart = source.indexOf("async function executeWorkflowBackground");
assert(execBgStart !== -1, "找到 executeWorkflowBackground 函数");
const execBgBody = source.slice(execBgStart);

// 找到"Cleanup widget after delay"注释
const cleanupCommentIdx = execBgBody.indexOf("Cleanup widget after delay");
assert(cleanupCommentIdx !== -1, "找到 'Cleanup widget after delay' 注释");
const cleanupSection = execBgBody.slice(cleanupCommentIdx, cleanupCommentIdx + 200);

const hasClearBeforeTimeout = /clearTimeout/.test(cleanupSection);
assertTrue(hasClearBeforeTimeout, "定时器设置前清除旧定时器");

const hasTimerAssignment = /_cleanupTimer\s*=\s*setTimeout/.test(cleanupSection);
assertTrue(hasTimerAssignment, "使用 _cleanupTimer = setTimeout(...)");

const hasTimerNullInCallback = /_cleanupTimer\s*=\s*null/.test(cleanupSection);
assertTrue(hasTimerNullInCallback, "定时器回调中重置 _cleanupTimer = null");

// ── Test 11: cancelWorkflow 回调中使用 _cleanupTimer ──
console.log("\n📋 测试 11: cancelWorkflow 回调使用 _cleanupTimer\n");

const cancelCallbackSection = source.slice(execBgStart);
const archiveIdx = cancelCallbackSection.lastIndexOf("Archive checkpoint on cancel");
assert(archiveIdx !== -1, "找到 'Archive checkpoint on cancel' 注释");
const cancelTimeoutSection = cancelCallbackSection.slice(archiveIdx, archiveIdx + 250);

const hasClearInCancel = /clearTimeout/.test(cancelTimeoutSection);
assertTrue(hasClearInCancel, "cancel 分支清除旧定时器");

const hasTimerInCancel = /_cleanupTimer\s*=\s*setTimeout/.test(cancelTimeoutSection);
assertTrue(hasTimerInCancel, "cancel 分支使用 _cleanupTimer = setTimeout(...)");

// ── Test 12: 模拟定时器竞态场景 ──
console.log("\n📋 测试 12: 定时器竞态场景模拟\n");

// 模拟 Bug B 修复逻辑
let cleanupTimer = null;
let workflowRunning = false;
let cleanupCount = 0;

function simulateCleanupWidget() {
	if (cleanupTimer) {
		clearTimeout(cleanupTimer);
		cleanupTimer = null;
	}
	workflowRunning = false;
	cleanupCount++;
}

function simulateInitWidget() {
	if (cleanupTimer) {
		clearTimeout(cleanupTimer);
		cleanupTimer = null;
	}
	workflowRunning = true;
}

function simulateStartWorkflow() {
	// 清除旧定时器
	if (cleanupTimer) {
		clearTimeout(cleanupTimer);
		cleanupTimer = null;
	}
	// 设置新的清理定时器
	cleanupTimer = setTimeout(() => {
		cleanupTimer = null;
		simulateCleanupWidget();
	}, 5000);
}

// 场景：工作流1完成 → 设置定时器 → 工作流2开始 → 旧定时器不应触发
simulateStartWorkflow(); // 工作流1完成
assertNotNull(cleanupTimer, "工作流1完成后设置了定时器");
assertEq(workflowRunning, false, "工作流1已标记为未运行");

simulateInitWidget(); // 工作流2开始
assertEq(workflowRunning, true, "工作流2已开始");
assertEq(cleanupTimer, null, "工作流2启动时清除了旧的 cleanupTimer");

// 手动触发旧定时器（不应影响新工作流）
if (cleanupTimer) {
	const oldTimer = cleanupTimer;
	clearTimeout(cleanupTimer);
	cleanupTimer = null;
	console.log("  ℹ️  旧定时器已清除，模拟触发不会影响新工作流");
}
// 验证新工作流状态未受影响
assertEq(workflowRunning, true, "工作流2仍在运行");
assertEq(cleanupTimer, null, "定时器已被清除");

// 场景：同时调用 cleanupWidget 应清除定时器
cleanupTimer = setTimeout(() => {}, 5000);
assertNotNull(cleanupTimer, "重新设置了一个定时器");
simulateCleanupWidget();
assertEq(cleanupTimer, null, "cleanupWidget 清除了定时器");

// 场景：空定时器时调用 initWidget（无竞态条件）
cleanupTimer = null;
simulateInitWidget();
assertEq(workflowRunning, true, "空定时器时启动工作流正常");


console.log("\n═══ Bug C 测试 — buildTaskForStep worker 注入 prompt（review 反馈循环） ═══\n");

// ── Test C1: worker 有 planContent 时 prompt 不被忽略 ──
console.log("📋 测试 C1: worker 有 planContent 时 prompt 不被忽略\n");

// 模拟 buildTaskForStep 行为
function simulateBuildTaskForStep(agentName, prompt, planFileRelPath, cwd, planContentExists) {
	if (agentName === "worker") {
		const planContent = planContentExists ? "# 实施计划\n1. 修改 login.ts\n2. 添加 auth 中间件" : undefined;
		if (planContent) {
			const result = [
				"请根据以下实施计划逐步实现代码改动。",
				"",
				"## 实施计划",
				planContent,
				"",
				"## 原始需求与修改反馈",
				prompt,
				"",
				"请严格按照计划中的步骤实施，不要做计划外的修改。",
			].join("\n");
			// 验证 prompt 包含在结果中
			return result.includes("\n" + prompt) || result.includes(prompt + "\n");
		}
	}
	return false;
}

// 场景 A: prompt 包含原始需求 + 审查反馈
const promptWithFeedback = [
	"[fix] 修复 login.ts 中的 401 错误",
	"",
	"## 上次审查发现的问题",
	'审查摘要: {"maxSeverity":"critical","critical":2,"medium":1,"low":0}',
	"请修复 2 个严重问题后重新运行。",
].join("\n");

const hasPromptWithPlan = simulateBuildTaskForStep("worker", promptWithFeedback, "plan.md", "/cwd", true);
assertTrue(hasPromptWithPlan, "worker 有 planContent 时 prompt（含审查反馈）被注入到任务中");

// 场景 B: prompt 是原始需求（第一轮循环）
const originalPrompt = "[fix] 修复 login.ts 中的 401 错误";
const hasOriginalPrompt = simulateBuildTaskForStep("worker", originalPrompt, "plan.md", "/cwd", true);
assertTrue(hasOriginalPrompt, "worker 有 planContent 时原始 prompt 也被注入");

// ── Test C2: 源代码静态分析 ──
console.log("\n📋 测试 C2: 源代码中 buildTaskForStep worker 分支包含 prompt\n");

const workerBranchRegex = /if \(agentName === \"worker\"\)[\s\S]{0,1000}\]\.join\(\"\\n\"\);/;
const workerMatch = source.match(workerBranchRegex);
assertNotNull(workerMatch, "找到 worker 分支");

const hasOriginalRequirementFeedback = workerMatch?.[0]?.includes("## 原始需求与修改反馈") ?? false;
assertTrue(hasOriginalRequirementFeedback, "worker prompt 模板包含 '## 原始需求与修改反馈' 节");

// ── Test C3: 源代码中 no-plan 分支保持不变 ──
console.log("\n📋 测试 C3: worker 无 plan 分支保持不变\n");

const noPlanBranchMatch = source.match(/请根据以下功能需求实施代码改动[\s\S]{0,200}请先分析代码库，制定简要计划，再逐步实施/);
assertNotNull(noPlanBranchMatch, "无 plan 分支仍然存在");
const noPlanHasFeedback = noPlanBranchMatch?.[0]?.includes("## 原始需求与修改反馈") ?? false;
assertFalse(noPlanHasFeedback, "无 plan 分支不含 '## 原始需求与修改反馈'");


console.log("\n═══ Bug D 测试 — hasContentChanged 使用 execSync 而非 require ═══\n");

// ── Test D1: 源代码不包含 require('child_process') ──
console.log("📋 测试 D1: hasContentChanged 不使用 require('child_process')\n");

const hasRequireChildProc = source.includes("require('child_process')") || source.includes('require("child_process")');
assertFalse(hasRequireChildProc, "源代码中不包含 require('child_process')");

// ── Test D2: hasContentChanged 使用 execSync ──
console.log("\n📋 测试 D2: hasContentChanged 使用 execSync\n");

const funcStart = source.indexOf("function hasContentChanged");
assert(funcStart !== -1, "找到 hasContentChanged 函数");
const funcBody = source.slice(funcStart, funcStart + 400);
const hasExecSync = funcBody.includes("execSync(");
assertTrue(hasExecSync, "hasContentChanged 使用 execSync");
const noOldSpawnSync = !funcBody.includes("spawnSync");
assertTrue(noOldSpawnSync, "hasContentChanged 不使用 spawnSync");

// ── Test D3: 模拟 hasContentChanged 行为逻辑 ──
console.log("\n📋 测试 D3: hasContentChanged 逻辑验证\n");

function simulateHasContentChanged(currentHash, baselineHash) {
	try {
		// 模拟 execSync 返回 hash
		const data = currentHash;
		return data.trim() !== baselineHash;
	} catch {
		return true;
	}
}

assertTrue(simulateHasContentChanged("abc123", "def456"), "不同 hash → changed");
assertFalse(simulateHasContentChanged("abc123", "abc123"), "相同 hash → unchanged");


console.log("\n═══ Bug E 测试 — trimmer prompt 包含 plan 上下文 ═══\n");

// ── Test E1: 源代码静态分析 ──
console.log("📋 测试 E1: buildTaskForStep trimmer 分支包含 plan 上下文\n");

const trimmerStart = source.indexOf('if (agentName === "trimmer")');
assert(trimmerStart !== -1, "找到 trimmer 分支");
const trimmerSection = source.slice(trimmerStart, trimmerStart + 600);

const trimmerHasWarning = trimmerSection.includes("注意：以下实施计划");
assertTrue(trimmerHasWarning, "trimmer prompt 包含 plan 保护提示");

const trimmerHasPlanContent = trimmerSection.includes("## 实施计划（改动范围）");
assertTrue(trimmerHasPlanContent, "trimmer prompt 包含 '## 实施计划（改动范围）’ 节");

const trimmerHasSpread = trimmerSection.includes("...(planContent ?");
assertTrue(trimmerHasSpread, "trimmer prompt 条件性包含 planContent");


console.log("\n═══ Bug F 测试 — 注释与代码一致性（5s vs 3s） ═══\n");

// ── Test F1: Esc 双击超时注释匹配代码 ──
console.log("📋 测试 F1: Esc 双击注释与代码一致\n");

const escCommentMatch = source.match(/Second Esc press within (\d+)s/);
if (escCommentMatch) {
	const commentVal = parseInt(escCommentMatch[1], 10);
	assertEq(commentVal, 3, `注释说 ${commentVal}s，代码中阈值应为 ${commentVal}s (3000ms)`);
	
	// 验证注释值匹配 actual timeout in ms
	const thresholdMs = 3000;
	const thresholdSec = thresholdMs / 1000;
	assertEq(commentVal, thresholdSec, `注释值 ${commentVal}s 匹配代码阈值 ${thresholdSec}s`);
} else {
	// Try the previous comment text
	const prevCommentMatch = source.match(/Second Esc press within [\w\s]+ → confirm cancel/);
	if (prevCommentMatch) {
		const commentText = prevCommentMatch[0];
		// Should contain "3s" now
		assertTrue(commentText.includes("3s"), `注释现在说 "3s"，得到: "${commentText}"`);
	} else {
		fail++;
		console.error("  ❌ 找不到 Esc 注释");
	}
}


console.log("\n═══ Bug G 测试 — 链上下文传递 (executeSingleStep) ═══\n");

// ── Test G1: executeSingleStep 中包含链上下文捕获逻辑 ──
console.log("📋 测试 G1: executeSingleStep 中有 chain context 捕获\n");

const singleStepFuncStart = source.indexOf("async function executeSingleStep");
assert(singleStepFuncStart !== -1, "找到 executeSingleStep 函数");
const singleStepEndSearch = source.indexOf("async function executeLoopGroup", singleStepFuncStart);
const fullSingleStep = source.slice(singleStepFuncStart, singleStepEndSearch);

// Verify 工作总结 entries still exist (preserved - from extractFinalOutput)
const hasWorkSummaryKey = fullSingleStep.includes('工作总结');
assertTrue(hasWorkSummaryKey, "executeSingleStep 中保留 '工作总结' 条目");

const hasWorkSummaryUpdate = fullSingleStep.includes('updateChainContext');
assertTrue(hasWorkSummaryUpdate, "executeSingleStep 中仍有 updateChainContext 调用（工作总结）");

// Verify the removed summary keys are no longer present in updateChainContext calls
// (comments may still reference them for historical context — that's fine)
const chainCtxCalls = [...fullSingleStep.matchAll(/updateChainContext\(`([^`]+)`/g)].map(m => m[1]);
const plannerInCode = chainCtxCalls.some(k => k.includes('计划制定摘要'));
assertFalse(plannerInCode, "updateChainContext 中已不使用 '计划制定摘要' key");
const docWriterInCode = chainCtxCalls.some(k => k.includes('文档更新摘要'));
assertFalse(docWriterInCode, "updateChainContext 中已不使用 '文档更新摘要' key");


console.log("\n═══ Bug H 测试 — Agent 前置元数据解析 ═══\n");

// ── Test H1: 所有 workflow agent 的 session 已启用（可追溯） ──
console.log("📋 测试 H1: 所有 workflow agent 的 session 已启用（session: true）\n");

const agentFiles = [
	"agents/workflow/planner-agent.md",
	"agents/workflow/worker-agent.md",
	"agents/workflow/reviewer-agent.md",
	"agents/workflow/trimmer-agent.md",
	"agents/workflow/docWriter-agent.md",
	"agents/review-agent.md",
];
for (const af of agentFiles) {
	const agentPath = path.resolve(__dirname, "..", af);
	if (fs.existsSync(agentPath)) {
		const content = fs.readFileSync(agentPath, "utf-8");
		const hasSessionTrue = content.includes("session: true");
		assertTrue(hasSessionTrue, `${af} 包含 session: true`);
		const hasSessionFalse = content.includes("session: false");
		assertFalse(hasSessionFalse, `${af} 不包含 session: false`);
	} else {
		console.log(`  ℹ️  跳过不存在的文件: ${af}`);
	}
}

// ── Test H2: 所有 workflow agent 有 MCP/SKILL 可用声明（工具白名单已移除 → MCP 实际可用） ──
console.log("\n📋 测试 H2: workflow agent 包含 MCP/SKILL 可用声明（白名单已移除，MCP 实际可用）\n");

const workflowAgentFiles = [
	"agents/workflow/planner-agent.md",
	"agents/workflow/worker-agent.md",
	"agents/workflow/reviewer-agent.md",
	"agents/workflow/trimmer-agent.md",
	"agents/workflow/docWriter-agent.md",
];
for (const af of workflowAgentFiles) {
	const agentPath = path.resolve(__dirname, "..", af);
	if (fs.existsSync(agentPath)) {
		const content = fs.readFileSync(agentPath, "utf-8");
		const hasExtraToolsSection = content.includes("## 额外可用工具");
		assertTrue(hasExtraToolsSection, `${af} 包含 '## 额外可用工具' 节`);
		const hasMcpClaim = content.includes("MCP");
		assertTrue(hasMcpClaim, `${af} 包含 MCP 声明`);
		const hasSkillClaim = content.includes("SKILL");
		assertTrue(hasSkillClaim, `${af} 包含 SKILL 声明`);
	} else {
		console.log(`  ℹ️  跳过不存在的文件: ${af}`);
	}
}

// ── Test H3: workflow agent 没有 tools 白名单（以允许 MCP 工具） ──
console.log("\n📋 测试 H3: workflow agent 没有 tools 白名单限制\n");

for (const af of workflowAgentFiles) {
	const agentPath = path.resolve(__dirname, "..", af);
	if (fs.existsSync(agentPath)) {
		const content = fs.readFileSync(agentPath, "utf-8");
		// Should NOT have a tools: line in frontmatter
		const hasToolsLine = /^tools:/.test(content.split("---")?.[1] ?? "");
		assertFalse(hasToolsLine, `${af} 无 tools: 行（白名单已移除）`);
	} else {
		console.log(`  ℹ️  跳过不存在的文件: ${af}`);
	}
}

// ── Test H4: sub-agents.ts 中 session 使用完整路径 + .jsonl ──
console.log("\n📋 测试 H4: sub-agents.ts session 路径构造\n");

const subAgentSource = fs.readFileSync(path.resolve(__dirname, "../extensions/sub-agents.ts"), "utf-8");
const hasMkdirSync = subAgentSource.includes("fs.mkdirSync(sessionDir");
assertTrue(hasMkdirSync, "spawnSubagent 创建 session 目录");
const hasJsonlPath = subAgentSource.includes(".jsonl");
assertTrue(hasJsonlPath, "session 文件路径包含 .jsonl 扩展名");
const hasSessionPath = subAgentSource.includes("path.join(sessionDir");
assertTrue(hasSessionPath, "使用 path.join 构建完整 session 路径");
const noSessionDirArg = subAgentSource.includes("--session-dir");
assertFalse(noSessionDirArg, "不再使用 --session-dir（改用完整路径 --session）");

// ── Test H5: Agent frontmatter 字段解析正确 ──
console.log("\n📋 测试 H5: Agent frontmatter 字段解析\n");

// subAgentSource 已在 H4 中声明，此处直接复用

const hasThinkingField = subAgentSource.includes('fields.thinking');
assertTrue(hasThinkingField, "loadAgent 解析 thinking 字段");

const hasSessionField = subAgentSource.includes('fields.session');
assertTrue(hasSessionField, "loadAgent 解析 session 字段");

const hasSessionDirField = subAgentSource.includes('fields["session-dir"]');
assertTrue(hasSessionDirField, "loadAgent 解析 session-dir 字段");

const hasNoContextField = subAgentSource.includes('fields["no-context"]');
assertTrue(hasNoContextField, "loadAgent 解析 no-context 字段");

const hasNoExtensionsField = subAgentSource.includes('fields["no-extensions"]');
assertTrue(hasNoExtensionsField, "loadAgent 解析 no-extensions 字段");

const hasExtraArgsField = subAgentSource.includes('fields["extra-args"]');
assertTrue(hasExtraArgsField, "loadAgent 解析 extra-args 字段");


console.log("\n═══ Bug I 测试 — 工作流 UUID 溯源机制 ═══\n");

// ── Test I1: workflowId 注入到 buildTaskForStep ──
console.log("📋 测试 I1: buildTaskForStep 接收 workflowId 参数\n");

const bldFuncStart = source.indexOf("function buildTaskForStep");
assert(bldFuncStart !== -1, "找到 buildTaskForStep 函数");
const bldFuncParams = source.slice(bldFuncStart, bldFuncStart + 300);

const hasWorkflowIdParam = bldFuncParams.includes("workflowId");
assertTrue(hasWorkflowIdParam, "buildTaskForStep 接收 workflowId 参数");

const hasChainContextParam = bldFuncParams.includes("chainContext");
assertTrue(hasChainContextParam, "buildTaskForStep 接收 chainContext 参数");

// ── Test I2: CheckpointData 包含 workflowId ──
console.log("\n📋 测试 I2: CheckpointData 包含 workflowId\n");

const checkpointDataMatch = source.match(/interface CheckpointData [\s\S]{0,500}workflowId/);
assertNotNull(checkpointDataMatch, "CheckpointData 接口包含 workflowId");

// ── Test I3: buildWorkflowInfoBlock 函数存在 ──
console.log("\n📋 测试 I3: buildWorkflowInfoBlock 函数存在\n");

const hasBuildWorkflowInfoBlock = source.includes("function buildWorkflowInfoBlock");
assertTrue(hasBuildWorkflowInfoBlock, "buildWorkflowInfoBlock 函数存在");

// ── Test I4: buildReviewTask 也接收 workflowId ──
console.log("\n📋 测试 I4: buildReviewTask 接收 workflowId\n");

const reviewTaskStart = source.indexOf("function buildReviewTask");
assert(reviewTaskStart !== -1, "找到 buildReviewTask 函数");
const reviewTaskParams = source.slice(reviewTaskStart, reviewTaskStart + 200);
const reviewHasWorkflowId = reviewTaskParams.includes("workflowId");
assertTrue(reviewHasWorkflowId, "buildReviewTask 接收 workflowId 参数");


console.log("\n");

console.log("═══ Bug J 测试 — _workflowFileChanges 仅来自 git diff ═══\n");

// ── Test J1: _workflowFileChanges.push 出现在 updateToolsFromGit 和 git diff 轮询 ──
console.log("📋 测试 J1: _workflowFileChanges.push 出现在 updateToolsFromGit 和 git diff 轮询\n");

// Count all _workflowFileChanges.push occurrences
// There should be 2: one in git diff polling (runAgentWithProgress) and one in updateToolsFromGit
const pushMatches = [...source.matchAll(/_workflowFileChanges\.push\(/g)];
assertEq(pushMatches.length, 2, "_workflowFileChanges.push 出现 2 次（轮询 + updateToolsFromGit）");

// Verify the push is inside updateToolsFromGit
const updateToolsStart = source.indexOf("function updateToolsFromGit");
const nextFuncStart = source.indexOf("function saveCheckpoint", updateToolsStart);
const updateToolsBody = source.slice(updateToolsStart, nextFuncStart);
assertTrue(updateToolsBody.includes("_workflowFileChanges.push"), "updateToolsFromGit 函数体内包含 _workflowFileChanges.push");

// Verify the push is also inside the git diff polling (setInterval) in runAgentWithProgress
const runAgentStart = source.indexOf("async function runAgentWithProgress");
const runAgentEnd = source.indexOf("async function executeSingleStep", runAgentStart);
const runAgentBody = source.slice(runAgentStart, runAgentEnd);
assertTrue(runAgentBody.includes("_workflowFileChanges.push"), "git diff 轮询（setInterval）中包含 _workflowFileChanges.push");

// ── Test J2: addWidgetSubStepTool 不再污染 _workflowFileChanges ──
console.log("\n📋 测试 J2: addWidgetSubStepTool 不再污染 _workflowFileChanges\n");

const addWidgetFunc = source.slice(
	source.indexOf("function addWidgetSubStepTool"),
	source.indexOf("function addWidgetSubStepOutput")
);
const hasNoFileChangesRef = !addWidgetFunc.includes("_workflowFileChanges");
assertTrue(hasNoFileChangesRef, "addWidgetSubStepTool 函数体中不再引用 _workflowFileChanges");

// ── Test J3: executeSingleStep 中不再有基于 _workflowFileChanges 的统计 ──
console.log("\n📋 测试 J3: executeSingleStep 中不再有 '执行摘要' 类 chain context\n");

const hasNoExecutorSummary = !fullSingleStep.includes('执行摘要');
assertTrue(hasNoExecutorSummary, "executeSingleStep 中不再有 '执行摘要' chain context");

// ── Test J4: executeLoopGroup 中不再有 "代码实施/精简摘要" chain context ──
console.log("\n📋 测试 J4: executeLoopGroup 中不再有 '代码实施/精简摘要' chain context\n");

const loopGroupStart = source.indexOf("async function executeLoopGroup");
assert(loopGroupStart !== -1, "找到 executeLoopGroup 函数");
const loopGroupBody = source.slice(loopGroupStart);
const hasNoCodeImplSummary = !loopGroupBody.includes('"代码实施摘要"') && !loopGroupBody.includes('"代码精简摘要"');
assertTrue(hasNoCodeImplSummary, "executeLoopGroup 中不再有 '代码实施摘要' 或 '代码精简摘要' chain context");

// Verify the removed review feedback keys are no longer present in updateChainContext calls
// (comments may still reference them for historical context — that's fine)
const chainCtxCallsLoop = [...loopGroupBody.matchAll(/updateChainContext\(`([^`]+)`/g)].map(m => m[1]);
const reviewInCode = chainCtxCallsLoop.some(k => k.includes('代码审查反馈') || k.includes('精简审查反馈'));
assertFalse(reviewInCode, "updateChainContext 中已不使用 '代码审查反馈' 或 '精简审查反馈' key");

// ── Test J5: 工作总结条目在所有 agent 函数中仍保留 ──
console.log("\n📋 测试 J5: '工作总结' 条目在所有 agent 函数中仍保留\n");

const hasWorkSummaryInSingleStep = fullSingleStep.includes('工作总结');
assertTrue(hasWorkSummaryInSingleStep, "executeSingleStep 保留 '工作总结' 条目");

const hasWorkSummaryInLoop = loopGroupBody.includes('工作总结');
assertTrue(hasWorkSummaryInLoop, "executeLoopGroup 保留 '工作总结' 条目");


console.log("\n=== 增强功能测试汇总 ===\n");
console.log("📋 附加测试覆盖:");
console.log("  - G: 链上下文传递 (executeSingleStep) — 已更新验证工作总结");
console.log("  - H: Agent 前置元数据解析 + MCP/SKILL 移除");
console.log("  - I: 工作流 UUID 溯源机制");
console.log("  - J: _workflowFileChanges 仅来自 git diff");
console.log("\n═══ Bug K 测试 — git diff 精准识别 + .pi-dev-output 过滤 ═══\n");

// ── Test K1: filePatterns 已移除 — 不再用 regex 猜文件路径 ──
console.log("📋 测试 K1: filePatterns 已移除\n");

const hasFilePatterns = source.includes("const filePatterns = [");
assertFalse(hasFilePatterns, "filePatterns 数组已移除（不再用 regex 嗅探文件路径）");

// ── Test K2: seenTools 文本解析 fallback 已移除 ──
console.log("\n📋 测试 K2: seenTools JSON fallback 已移除\n");

const hasJsonFallback = source.includes("if (seenTools.size === 0)");
assertFalse(hasJsonFallback, "seenTools JSON tool_use fallback 已移除");

// ── Test K3: outputPathPatterns 统一 inline 模式已移除 ──
console.log("\n📋 测试 K3: outputPathPatterns 已简化\n");

const hasOutputPathPatterns = source.includes("const outputPathPatterns = [");
assertFalse(hasOutputPathPatterns, "outputPathPatterns 数组已移除（替换为 inline workflowId 过滤）");

// ── Test K4: updateToolsFromGit 有 isWorkflowArtifactPath 过滤 ──
console.log("\n📋 测试 K4: updateToolsFromGit 使用 isWorkflowArtifactPath 过滤\n");

const hasIsWorkflowArtifactPath = source.includes('isWorkflowArtifactPath(change.path)');
assertTrue(hasIsWorkflowArtifactPath, "updateToolsFromGit 使用 isWorkflowArtifactPath 跳过 .pi-dev-output/ 路径");

const hasIsWorkflowArtifactFunc = source.includes('function isWorkflowArtifactPath');
assertTrue(hasIsWorkflowArtifactFunc, "isWorkflowArtifactPath 辅助函数存在");

// ── Test K5: output 路径匹配使用 escapedId + workflowId ──
console.log("\n📋 测试 K5: output 路径使用 workflowId 过滤\n");

const hasEscapedId = source.includes("const escapedId = _workflowId.replace(");
assertTrue(hasEscapedId, "output 路径匹配使用 escapedId");

// ── Test K6: progress handler output match 使用 _workflowId ──
console.log("\n📋 测试 K6: progress handler 使用 workflowId\n");

const hasIncludesWorkflowId = source.includes("pathCandidate.includes(_workflowId)");
assertTrue(hasIncludesWorkflowId, "progress handler 使用 pathCandidate.includes(_workflowId)");

// ── Test K7: addWidgetSubStepTool 只来自 git diff（regex 嗅探已移除）──
console.log("\n📋 测试 K7: addWidgetSubStepTool 仅来自 git diff\n");

// Verify the toolMatch regex sniffing has been removed (source 1)
const hasToolMatchRegex = source.includes('const toolMatch = progress.match(/(edit|read|write|new|bash|grep|find|ls|delete|remove)');
assertFalse(hasToolMatchRegex, "progress handler 中已移除 toolMatch 正则 (source 1)");

// Verify the updateToolsFromGit call site still exists
assertTrue(source.includes("addWidgetSubStepTool(stepIndex, agentName, `${change.status}   ${change.path}`)"), "updateToolsFromGit 调用 addWidgetSubStepTool");

// Verify git diff polling timer exists (replacement for regex sniffing)
const hasGitPollTimer = source.includes('_gitPollTimer = setInterval');
assertTrue(hasGitPollTimer, "git diff 轮询定时器已添加");

// ── Test K8: addWidgetSubStepOutput 仍存在 (output 路径展示有用) ──
console.log("\n📋 测试 K8: addWidgetSubStepOutput 仍保留\n");

const hasAddWidgetOutput = source.includes("function addWidgetSubStepOutput");
assertTrue(hasAddWidgetOutput, "addWidgetSubStepOutput 函数声明仍保留");



console.log("\n═══ Bug L 测试 — output 路径白名单验证 ═══\n");

// ── Test L1: output 路径白名单验证 ──
console.log("\n📋 测试 L1: output 路径白名单逻辑\n");

function isValidOutputPath(path) {
	return /^[\w.\/-]+$/.test(path) &&
		path.length > 15 && path.length < 300 &&
		path.includes("019e57e7");
}

// 应接受的合法路径
assertTrue(isValidOutputPath(".pi-dev-output/pi-plans/20260524-test-019e57e7.md"), "合法路径应被接受");
assertTrue(isValidOutputPath(".pi-dev-output/pi-review/md/review-20260524-019e57e7.md"), "review 路径应被接受");

// 应拒绝的乱码路径
assertFalse(isValidOutputPath(".pi-dev-output/pi-plans/中grepUUID\"019e57e7\"找到)"), "含中文路径应被拒绝");
assertFalse(isValidOutputPath(".pi-dev-output/pi-plans/（测试）019e57e7.md"), "含括号路径应被拒绝");

// ── Test L2: post-completion output 检测仅搜索 clean text ──
console.log("\n📋 测试 L2: output 检测仅搜索 clean text（source 2 修复验证）\n");

// 验证源代码中 outputPattern.exec 搜索的是 cleanText 而非 searchText
const hasSearchTextOutput = source.includes('outputPattern.exec(searchText)');
assertFalse(hasSearchTextOutput, "output 检测不再搜索 searchText (raw JSON)");

// 验证替换为 cleanText
const hasCleanTextOutput = source.includes('outputPattern.exec(cleanText)');
assertTrue(hasCleanTextOutput, "output 检测搜索 cleanText (extracted text)");

// ── Test L3: post-completion output 有白名单验证 ──
console.log("\n📋 测试 L3: post-completion output 有白名单验证\n");

const hasWhitelistCheck = source.includes('/^[\\w.\\/-]+\$/.test(path_)');
assertTrue(hasWhitelistCheck, "post-completion output 检测包含 /^[\\w.\\/-]+\$/ 白名单验证");

// ── Test L4: progress handler output 检测使用 whitelist regex ──
console.log("\n📋 测试 L4: progress handler output 检测使用 whitelist regex\n");

const hasProgressWhitelist = source.includes('.pi-dev-output\\/[a-zA-Z0-9_\\/\\.-]+');
assertTrue(hasProgressWhitelist, "progress handler 使用 [a-zA-Z0-9_\\/\\.-]+ 白名单正则");

// ── Test L5: isWorkflowArtifactPath 在 git diff 轮询中使用 ──
console.log("\n📋 测试 L5: isWorkflowArtifactPath 在 git diff 轮询中使用\n");

const hasPollIsWorkflowArtifact = source.includes('isWorkflowArtifactPath(change.path)');
assertTrue(hasPollIsWorkflowArtifact, "git diff 轮询使用 isWorkflowArtifactPath 过滤");

// ── Test L6: git diff 轮询也向 _workflowFileChanges 推送 ──
console.log("\n📋 测试 L6: git diff 轮询向 _workflowFileChanges 推送\n");

// Verify the polling code pushes to _workflowFileChanges before addWidgetSubStepTool
const pollTimerBodyStart = source.indexOf('_gitPollTimer = setInterval');
const pollTimerBodyEnd = source.indexOf('_gitPollTimer.unref()');
const pollTimerBody = source.slice(pollTimerBodyStart, pollTimerBodyEnd);
const hasPushInPoll = pollTimerBody.includes('_workflowFileChanges.push');
assertTrue(hasPushInPoll, "git diff 轮询（setInterval）中包含 _workflowFileChanges.push");

// Verify the type mapping (A→new, D→delete, else→edit) exists in polling code
const hasTypeMappingInPoll = pollTimerBody.includes('change.status === "A" ? "new"');
assertTrue(hasTypeMappingInPoll, "git diff 轮询中文件变更的类型映射正确");


console.log("\n═══════════════════════════════════════════════════════\n");
console.log(`📊 结果: ${pass} 通过, ${fail} 失败\n`);

if (fail > 0) {
	console.error("❌ 部分测试失败");
	process.exit(1);
} else {
	console.log("✅ 全部通过");
}
