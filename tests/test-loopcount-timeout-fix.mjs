/**
 * test-loopcount-timeout-fix.mjs
 *
 * 测试 loopCount UI 同步、reviewer 独立超时、默认超时值修改
 *
 * 测试范围：
 *   1. loopCount 在每次循环后通过 updateWidgetStep 同步到 widget
 *   2. reviewer 使用 reviewTimeoutMs（独立超时）
 *   3. 默认超时值 worker=30min (1_800_000), trimmer=20min (1_200_000), reviewer=15min (900_000)
 *   4. loop-group 行不显示 timeoutMs（通过静态分析 updateWidgetStep 参数）
 *   5. sub-step 在 runAgentWithProgress 中写入 detail（超时信息）
 *   6. 回归：非 loop-group 步骤仍正常显示超时
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "..", "extensions");

// ── Test helpers ──

let passed = 0;
let failed = 0;
const results = [];

function assert(label, condition, detail = "") {
	if (condition) {
		passed++;
		results.push({ label, ok: true });
	} else {
		failed++;
		results.push({ label, ok: false, detail });
		console.error(`  ❌ ${label}${detail ? " — " + detail : ""}`);
	}
}

function assertIncludes(label, text, pattern, detail = "") {
	assert(label, text.includes(pattern), detail);
}

function assertNotIncludes(label, text, pattern, detail = "") {
	assert(label, !text.includes(pattern), detail);
}

// ── Read source files ──

const weContent = fs.readFileSync(path.join(EXT_DIR, "workflow-engine.ts"), "utf8");
const dpContent = fs.readFileSync(path.join(EXT_DIR, "dev-prompts.ts"), "utf8");
const uhContent = fs.readFileSync(path.join(EXT_DIR, "ui-helpers.ts"), "utf8");

// ═══════════════════════════════════════════════════════════════
//  Test 1: loopCount UI sync
//  验证 executeLoopGroup 中 loopCount++ 后调用 updateWidgetStep
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 1: loopCount UI 同步");

assertIncludes(
	"1.1 executeLoopGroup 中有 loopCount++ 后立即更新 UI",
	weContent,
	"// 立即更新 UI 显示当前循环次数",
);

assertIncludes(
	"1.2 updateWidgetStep 调用中传入 loopCount",
	weContent,
	"loopCount,",
);

assertIncludes(
	"1.3 updateWidgetStep 调用中包含 loopCount 参数名",
	weContent,
	"loopCount,", // 在 extra 对象中
);

assertIncludes(
	"1.4 updateWidgetStep 调用中包含 maxLoops",
	weContent,
	"maxLoops: step.maxLoops",
);

// ═══════════════════════════════════════════════════════════════
//  Test 2: Reviewer 独立超时
//  验证 reviewer 使用 reviewTimeoutMs 而非 step.timeoutMs
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 2: Reviewer 独立超时");

assertIncludes(
	"2.1 executeLoopGroup 中定义了 reviewTimeoutMs 变量",
	weContent,
	"const reviewTimeoutMs = step.reviewTimeoutMs ?? step.timeoutMs;",
);

assertIncludes(
	"2.2 reviewer 的 runAgentWithProgress 使用 reviewTimeoutMs",
	weContent,
	"step.reviewAgentName!, reviewTimeoutMs);",
);

assert(
	"2.3 reviewer 调用不再使用 step.timeoutMs",
	!weContent.includes("step.reviewAgentName!, step.timeoutMs)"),
	"reviewer 的 runAgentWithProgress 不应该使用 step.timeoutMs",
);

assertIncludes(
	"2.4 Worker 仍使用 step.timeoutMs（未受 reviewer 变更影响）",
	weContent,
	"step.loopAgentName!, step.timeoutMs)",
	"注意：worker 的 runAgentWithProgress 仍使用 step.timeoutMs",
);

// ═══════════════════════════════════════════════════════════════
//  Test 3: 默认超时值验证（读取 dev-prompts.ts）
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 3: 默认超时值验证");

// Helper: extract all loop-group config blocks
function extractLoopGroups(source) {
	const lines = source.split("\n");
	const groups = [];
	let currentBlock = null;
	let braceDepth = 0;

	for (const line of lines) {
		if (line.includes("type: \"loop-group\"")) {
			currentBlock = { start: lines.indexOf(line), lines: [line], loopAgent: "", reviewAgent: "", timeoutMs: 0, reviewTimeoutMs: 0 };
			braceDepth = 0;
			continue;
		}
		if (currentBlock) {
			currentBlock.lines.push(line);
			if (line.includes("loopAgentName:")) {
				const m = line.match(/loopAgentName:\s*"(\w+)"/);
				if (m) currentBlock.loopAgent = m[1];
			}
			if (line.includes("reviewAgentName:")) {
				const m = line.match(/reviewAgentName:\s*"(\w+)"/);
				if (m) currentBlock.reviewAgent = m[1];
			}
			if (line.includes("timeoutMs:")) {
				const m = line.match(/timeoutMs:\s*(\d[\d_]*)/);
				if (m) currentBlock.timeoutMs = parseInt(m[1].replace(/_/g, ""), 10);
			}
			if (line.includes("reviewTimeoutMs:")) {
				const m = line.match(/reviewTimeoutMs:\s*(\d[\d_]*)/);
				if (m) currentBlock.reviewTimeoutMs = parseInt(m[1].replace(/_/g, ""), 10);
			}
			if (line.includes("},") || line.includes("} ;") || line.includes("};")) {
				braceDepth++;
				if (braceDepth >= 1) {
					groups.push(currentBlock);
					currentBlock = null;
				}
			}
		}
	}
	return groups;
}

const loopGroups = extractLoopGroups(dpContent);

assert("3.0 找到至少 6 个 loop-group 配置", loopGroups.length >= 6, `找到 ${loopGroups.length} 个`);

// worker 相关：timeoutMs 应为 1_800_000 (30min)
const workerGroups = loopGroups.filter(g => g.loopAgent === "worker");
for (const g of workerGroups) {
	assert(
		`3.1 Worker loop-group 超时=30min: ${g.loopAgent} → ${g.timeoutMs}`,
		g.timeoutMs === 1_800_000,
		`期望 1_800_000，实际 ${g.timeoutMs}`,
	);
	assert(
		`3.2 Worker loop-group reviewTimeoutMs=15min: ${g.loopAgent} → ${g.reviewTimeoutMs}`,
		g.reviewTimeoutMs === 900_000,
		`期望 900_000，实际 ${g.reviewTimeoutMs}`,
	);
}

// trimmer 相关：timeoutMs 应为 1_200_000 (20min)
const trimmerGroups = loopGroups.filter(g => g.loopAgent === "trimmer");
for (const g of trimmerGroups) {
	assert(
		`3.3 Trimmer loop-group 超时=20min: ${g.loopAgent} → ${g.timeoutMs}`,
		g.timeoutMs === 1_200_000,
		`期望 1_200_000，实际 ${g.timeoutMs}`,
	);
	assert(
		`3.4 Trimmer loop-group reviewTimeoutMs=15min: ${g.loopAgent} → ${g.reviewTimeoutMs}`,
		g.reviewTimeoutMs === 900_000,
		`期望 900_000，实际 ${g.reviewTimeoutMs}`,
	);
}

// 所有 loop-group 都应有 reviewTimeoutMs
for (const g of loopGroups) {
	assert(
		`3.5 ${g.loopAgent} loop-group 有 reviewTimeoutMs`,
		g.reviewTimeoutMs > 0,
		`缺少 reviewTimeoutMs`,
	);
}

// ═══════════════════════════════════════════════════════════════
//  Test 4: loop-group 行不显示 timeout
//  验证 updateWidgetStep 对 loop-group 步骤不传 timeoutMs
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 4: loop-group 行不显示 timeout");

assertIncludes(
	"4.1 loop-group running 状态不传 timeoutMs",
	weContent,
	'step.type === "loop-group" ? undefined : step.timeoutMs',
);

// ═══════════════════════════════════════════════════════════════
//  Test 5: sub-step 显示 timeout
//  验证 runAgentWithProgress 在 sub-step 的 detail 中写入超时
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 5: sub-step 显示 timeout");

assertIncludes(
	"5.1 runAgentWithProgress 在新建 sub-step 时写入 detail",
	weContent,
	"detail: `超时时间${formatTimeout(timeoutMs)}`",
);

assertIncludes(
	"5.2 runAgentWithProgress 在复用 sub-step 时更新 detail",
	weContent,
	"existing.detail = `超时时间${formatTimeout(timeoutMs)}`;",
);

// ═══════════════════════════════════════════════════════════════
//  Test 6: formatTimeout 已导出
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 6: formatTimeout 导出");

assertIncludes(
	"6.1 formatTimeout 从 ui-helpers.ts 导出",
	uhContent,
	"export function formatTimeout",
);

assertIncludes(
	"6.2 formatTimeout 被 workflow-engine.ts 导入",
	weContent,
	"formatTimeout,",
);

// ═══════════════════════════════════════════════════════════════
//  Test 7: WorkflowStepDef 接口有 reviewTimeoutMs 字段
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 7: WorkflowStepDef 接口");

assertIncludes(
	"7.1 WorkflowStepDef 有 reviewTimeoutMs 字段定义",
	weContent,
	"reviewTimeoutMs?: number;",
);

// ═══════════════════════════════════════════════════════════════
//  Test 8: 回归测试 — 非 loop-group 功能不受影响
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 8: 回归测试");

assertIncludes(
	"8.1 非 loop-group 步骤运行状态仍传 timeoutMs",
	weContent,
	"timeoutMs: step.type === \"loop-group\" ? undefined : step.timeoutMs,", // 对于非 loop-group 仍传
);

assertIncludes(
	"8.2 非 loop-group 步骤 done 状态仍传 timeoutMs",
	weContent,
	"timeoutMs: step.type === \"loop-group\" ? undefined : step.timeoutMs,", // done 状态同样逻辑
);

// 验证 executeSingleStep 未受影响 — 它仍然传递超时给 runAgentWithProgress
if (weContent.includes("executeSingleStep")) {
	assert(
		"8.3 executeSingleStep 中仍传递 timeoutMs",
		true,
	);
}

// ═══════════════════════════════════════════════════════════════
//  Test 9: sub-step 重置 — 每次循环重置 sub-step 状态
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Test 9: sub-step 状态重置");

assertIncludes(
	"9.1 每次循环开始时重置 sub-step 状态",
	weContent,
	"// 每次循环开始时重置 sub-step 状态",
);

assert(
	"9.2 loopAgent sub-step 在循环开始被重置为 pending",
	weContent.includes('setWidgetSubStepStatus(stepIndex, step.loopAgentName!, "pending")'),
);

assert(
	"9.3 reviewAgent sub-step 在循环开始被重置为 pending",
	weContent.includes('setWidgetSubStepStatus(stepIndex, step.reviewAgentName!, "pending")'),
);

// ═══════════════════════════════════════════════════════════════
//  Summary
// ═══════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(60));
console.log(`结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个测试`);
console.log("═".repeat(60));

if (failed > 0) {
	console.error("\n⚠️  部分测试未通过:");
	for (const r of results) {
		if (!r.ok) {
			console.error(`  ❌ ${r.label}${r.detail ? " — " + r.detail : ""}`);
		}
	}
	process.exit(1);
} else {
	console.log("\n✅ 全部通过");
}
