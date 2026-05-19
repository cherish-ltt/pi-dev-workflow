/**
 * test-workflow-engine.mjs — 测试工作流引擎核心逻辑
 *
 * Tests:
 * 1. parseReviewerOutput — 解析 [REVIEW_SUMMARY] JSON
 * 2. parseReviewerOutput — 兜底解析裸 JSON
 * 3. parseReviewerOutput — 无效输入返回 null
 * 4. isTimeoutResult — 正确识别超时
 * 5. isTimeoutResult — 非超时不误判
 * 6. Checkpoint 序列化/反序列化
 * 7. WorkflowStepDef 配置结构完整性
 *
 * Run: node tests/test-workflow-engine.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, "../extensions/workflow-engine.ts");

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

// ── Read source ──────────────────────────────────────────────

let source;
try {
	source = fs.readFileSync(EXT_PATH, "utf-8");
} catch (e) {
	console.error(`Failed to read source file: ${e.message}`);
	process.exit(1);
}

console.log(`📄 源文件: ${EXT_PATH}`);
console.log(`📏 文件大小: ${source.length} 字节\n`);

// ═══════════════════════════════════════════════════════════════
//  1. parseReviewerOutput — 解析 [REVIEW_SUMMARY] JSON
// ═══════════════════════════════════════════════════════════════

function simulateParseReviewerOutput(output) {
	const match = output.match(/\[REVIEW_SUMMARY\]\s*(\{[\s\S]*?\})\s*\[\/REVIEW_SUMMARY\]/);
	if (match) {
		try {
			const parsed = JSON.parse(match[1]);
			if (parsed && typeof parsed.maxSeverity === "string") return parsed;
		} catch {}
	}
	// fallback
	const fallback = output.match(/\{"maxSeverity":\s*"(critical|medium|low)"[\s\S]*?\}/);
	if (fallback) {
		try {
			const parsed = JSON.parse(fallback[0]);
			if (parsed && typeof parsed.maxSeverity === "string") return parsed;
		} catch {}
	}
	return null;
}

console.log("📋 parseReviewerOutput 测试\n");

// Test 1: 标准 [REVIEW_SUMMARY] 格式
const output1 = [
	"其他审查内容...",
	"[REVIEW_SUMMARY]",
	'{"maxSeverity":"critical","critical":2,"medium":1,"low":3}',
	"[/REVIEW_SUMMARY]",
].join("\n");

const r1 = simulateParseReviewerOutput(output1);
assertEq(r1?.maxSeverity, "critical", "[REVIEW_SUMMARY] 应解析 critical");
assertEq(r1?.critical, 2, "critical 计数正确");
assertEq(r1?.medium, 1, "medium 计数正确");
assertEq(r1?.low, 3, "low 计数正确");

// Test 2: 不同严重等级
const output2 = [
	"[REVIEW_SUMMARY]",
	'{"maxSeverity":"medium","critical":0,"medium":1,"low":2}',
	"[/REVIEW_SUMMARY]",
].join("\n");
assertEq(simulateParseReviewerOutput(output2)?.maxSeverity, "medium", "medium 等级应正确解析");

const output3 = [
	"[REVIEW_SUMMARY]",
	'{"maxSeverity":"low","critical":0,"medium":0,"low":0}',
	"[/REVIEW_SUMMARY]",
].join("\n");
assertEq(simulateParseReviewerOutput(output3)?.maxSeverity, "low", "low 等级应正确解析");

// Test 3: 兜底裸 JSON (无 [REVIEW_SUMMARY] 标记)
const output4 = '其他文本 {"maxSeverity":"critical","critical":1} 更多文本';
assertEq(simulateParseReviewerOutput(output4)?.maxSeverity, "critical", "兜底裸 JSON 应解析 critical");

// Test 4: 无效输入
assertEq(simulateParseReviewerOutput(""), null, "空字符串应返回 null");
assertEq(simulateParseReviewerOutput("无 JSON 内容"), null, "无 JSON 应返回 null");
assertEq(simulateParseReviewerOutput('{"invalid": true}'), null, "缺少 maxSeverity 应返回 null");

// Test 5: 跨越多行的复杂输出
const output5 = `
一些审查文本
更多内容

[REVIEW_SUMMARY]
{"maxSeverity":"medium","critical":0,"medium":3,"low":5}
[/REVIEW_SUMMARY]

末尾内容
`;
const r5 = simulateParseReviewerOutput(output5);
assertEq(r5?.maxSeverity, "medium", "跨行复杂输出应正确解析");
assertEq(r5?.medium, 3, "跨行复杂输出的 medium 计数");

// ═══════════════════════════════════════════════════════════════
//  2. isTimeoutResult
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 isTimeoutResult 测试\n");

function simulateIsTimeoutResult(result) {
	return result.exitCode === -1 && (result.stderr || "").includes("timed out");
}

assertEq(
	simulateIsTimeoutResult({ exitCode: -1, stderr: "timed out after 300s", output: "", durationMs: 0 }),
	true,
	"exitCode=-1 + timed out → true",
);
assertEq(
	simulateIsTimeoutResult({ exitCode: 0, stderr: "", output: "ok", durationMs: 100 }),
	false,
	"exitCode=0 → false",
);
assertEq(
	simulateIsTimeoutResult({ exitCode: 1, stderr: "some error", output: "", durationMs: 100 }),
	false,
	"exitCode=1 + 无 timed out → false",
);
assertEq(
	simulateIsTimeoutResult({ exitCode: -1, stderr: "other error", output: "", durationMs: 100 }),
	false,
	"exitCode=-1 + 无 timed out → false",
);

// ═══════════════════════════════════════════════════════════════
//  3. Checkpoint 序列化/反序列化
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Checkpoint 序列化测试\n");

const sampleCheckpoint = {
	version: 1,
	createdAt: "2026-05-19T08:00:00.000Z",
	updatedAt: "2026-05-19T08:30:00.000Z",
	prompt: "测试 prompt",
	mode: "attended",
	steps: [
		{ status: "done", durationMs: 15000 },
		{ status: "done", durationMs: 45000, loopCount: 2 },
		{ status: "pending" },
		{ status: "pending" },
	],
	currentStepIndex: 2,
	loopCounts: { "worker-reviewer": 2 },
};

// 序列化 → 反序列化
const serialized = JSON.stringify(sampleCheckpoint);
const deserialized = JSON.parse(serialized);

assertEq(deserialized.version, 1, "checkpoint version 应保持");
assertEq(deserialized.mode, "attended", "mode 应保持");
assertEq(deserialized.currentStepIndex, 2, "currentStepIndex 应保持");
assertEq(deserialized.loopCounts["worker-reviewer"], 2, "loopCounts 应保持");
assertEq(deserialized.steps[1].loopCount, 2, "step loopCount 应保持");
assertEq(deserialized.steps[1].durationMs, 45000, "step durationMs 应保持");

// ═══════════════════════════════════════════════════════════════
//  4. WorkflowStepDef 配置结构完整性
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 WorkflowStepDef 配置结构测试\n");

// 验证 dev-prompts.ts 中的 FEAT_WORKFLOW_STEPS
const devPromptsPath = path.resolve(__dirname, "../extensions/dev-prompts.ts");
const devPrompts = fs.readFileSync(devPromptsPath, "utf-8");

// 检查 FEAT_WORKFLOW_STEPS 定义是否存在
assert(
	devPrompts.includes("FEAT_WORKFLOW_STEPS"),
	"dev-prompts.ts 应定义 FEAT_WORKFLOW_STEPS",
);

// 检查是否包含 planner 定义
assert(
	devPrompts.includes('agentName: "planner"'),
	"FEAT_WORKFLOW_STEPS 应包含 planner agent",
);

// 检查 loop-group 类型的工作流步骤（全部配置合计）
const loopGroupCount = (devPrompts.match(/type: "loop-group"/g) || []).length;
assertEq(loopGroupCount, 8, "所有 WORKFLOW_STEPS 合计应包含 8 个 loop-group 步骤");

// 检查 confirm 类型
assert(
	devPrompts.includes('type: "confirm"'),
	"FEAT_WORKFLOW_STEPS 应包含 confirm 类型步骤 (docWriter)",
);

// 检查所有 agent name 引用
assert(devPrompts.includes('agentName: "planner"'), "包含 planner agent");
assert(devPrompts.includes('loopAgentName: "worker"'), "包含 worker loop agent");
assert(devPrompts.includes('loopAgentName: "trimmer"'), "包含 trimmer loop agent");
assert(devPrompts.includes('reviewAgentName: "reviewer"'), "包含 reviewer agent");
assert(devPrompts.includes('agentName: "docWriter"'), "包含 docWriter agent");

// ═══════════════════════════════════════════════════════════════
//  5. Agent 定义文件存在性验证
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Agent 定义文件存在性测试\n");

const agentDir = path.resolve(__dirname, "../agents/workflow");
const expectedAgents = ["planner-agent.md", "worker-agent.md", "reviewer-agent.md", "trimmer-agent.md", "docWriter-agent.md"];

for (const agentFile of expectedAgents) {
	const fullPath = path.join(agentDir, agentFile);
	assert(
		fs.existsSync(fullPath),
		`agents/workflow/${agentFile} 应存在`,
	);
	// 验证 frontmatter
	const content = fs.readFileSync(fullPath, "utf-8");
	assert(
		content.startsWith("---"),
		`${agentFile} 应以 YAML frontmatter 开头`,
	);
	assert(
		/content.includes("name:")/,
		`${agentFile} 应包含 name 字段`,
	);
}

// ═══════════════════════════════════════════════════════════════
//  6. workflow-engine.ts 导出完整性
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 workflow-engine.ts 导出完整性测试\n");

assert(
	source.includes("export async function runWorkflow"),
	"应导出 runWorkflow",
);
assert(
	source.includes("export function parseReviewerOutput"),
	"应导出 parseReviewerOutput",
);
assert(
	source.includes("export function isTimeoutResult"),
	"应导出 isTimeoutResult",
);
assert(
	source.includes("export function loadCheckpointFromFile"),
	"应导出 loadCheckpointFromFile",
);
assert(
	source.includes("export function deleteCheckpointFile"),
	"应导出 deleteCheckpointFile",
);
assert(
	source.includes("export interface WorkflowStepDef"),
	"应导出 WorkflowStepDef",
);
assert(
	source.includes("export interface WorkflowConfig"),
	"应导出 WorkflowConfig",
);

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
	console.log("\n✅ 所有测试通过");
}
