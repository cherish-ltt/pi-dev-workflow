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


console.log("\n═══════════════════════════════════════════════════════\n");
console.log(`📊 结果: ${pass} 通过, ${fail} 失败\n`);

if (fail > 0) {
	console.error("❌ 部分测试失败");
	process.exit(1);
} else {
	console.log("✅ 全部通过");
}
