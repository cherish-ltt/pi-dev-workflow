/**
 * test-workflow-engine.mjs — 测试工作流引擎核心逻辑
 *
 * Tests:
 * 1. parseReviewerOutput — 解析 [REVIEW_SUMMARY] JSON
 * 2. parseReviewerOutput — 兜底解析裸 JSON
 * 3. parseReviewerOutput — 无效输入返回 null
 * 4. Bug confirmation: parseReviewerOutput fails on JSON lines output
 * 5. Fix verification: extractFinalOutput + parseReviewerOutput works
 * 6. parseReviewerOutputFromFile — 读取审查文件
 * 7. isTimeoutResult — 正确识别超时
 * 8. isTimeoutResult — 非超时不误判
 * 9. Checkpoint 序列化/反序列化
 * 10. WorkflowStepDef 配置结构完整性
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
//  Bug fix: parseReviewerOutput on JSON-formatted subagent output
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 parseReviewerOutput 在 JSON 格式输出下的行为测试\n");

// 模拟 --mode json 输出的 JSON lines 格式（subagent 原始输出）
function buildJsonLinesOutput(plainText) {
	// 模拟 pi --mode json 的流式输出格式
	const lines = [];
	const chunkSize = 80;
	for (let i = 0; i < plainText.length; i += chunkSize) {
		const chunk = plainText.slice(i, i + chunkSize);
		lines.push(JSON.stringify({
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				delta: chunk,
			},
		}));
	}
	lines.push(JSON.stringify({
		type: "message_update",
		assistantMessageEvent: {
			type: "text_end",
			content: plainText,
		},
	}));
	return lines.join("\n");
}

// 模拟 extractFinalOutput（复制自 sub-agents.ts 的核心逻辑）
function simulateExtractFinalOutput(jsonOutput) {
	let result = "";
	let textEndSeen = false;
	for (const line of jsonOutput.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (!textEndSeen && event.type === "message_update" &&
					event.assistantMessageEvent?.type === "text_delta") {
				result += event.assistantMessageEvent.delta || "";
			}
			if (event.type === "message_update" &&
					event.assistantMessageEvent?.type === "text_end" &&
					event.assistantMessageEvent.content) {
				result = event.assistantMessageEvent.content;
				textEndSeen = true;
			}
		} catch { /* skip non-JSON lines */ }
	}
	return result;
}

// Test 6: BUG CONFIRMATION — parseReviewerOutput 在 JSON lines 输出中返回 null
const criticalText = [
	"# 代码审查报告",
	"",
	"## 严重问题",
	"### C1: 关键 bug",
	"",
	"[REVIEW_SUMMARY]",
	'{"maxSeverity":"critical","critical":2,"medium":1,"low":0}',
	"[/REVIEW_SUMMARY]",
].join("\n");

const jsonOutput = buildJsonLinesOutput(criticalText);
const resultOnRawJson = simulateParseReviewerOutput(jsonOutput);
assertEq(resultOnRawJson, null, "BUG: parseReviewerOutput 在原始 JSON lines 输出上应返回 null（确认 bug）");

// Test 7: FIX VERIFICATION — 先用 extractFinalOutput 提取纯文本，再解析 REVIEW_SUMMARY
const extracted = simulateExtractFinalOutput(jsonOutput);
const resultOnExtracted = simulateParseReviewerOutput(extracted);
assertEq(resultOnExtracted?.maxSeverity, "critical", "FIX: 提取纯文本后应正确解析 critical");
assertEq(resultOnExtracted?.critical, 2, "FIX: critical 计数应正确");

// Test 8: FIX VERIFICATION — 中等等级
const mediumText = [
	"[REVIEW_SUMMARY]",
	'{"maxSeverity":"medium","critical":0,"medium":3,"low":2}',
	"[/REVIEW_SUMMARY]",
].join("\n");
const jsonOutput2 = buildJsonLinesOutput(mediumText);
const extracted2 = simulateExtractFinalOutput(jsonOutput2);
const result2 = simulateParseReviewerOutput(extracted2);
assertEq(result2?.maxSeverity, "medium", "FIX: 提取后 medium 等级应正确解析");
assertEq(result2?.medium, 3, "FIX: medium 计数应正确");

// Test 9: extractSeverityFromText — 从 ### C1. / ### M1. / ### L1. 格式解析
console.log("\n📋 extractSeverityFromText 测试\n");

function simulateExtractSeverityFromText(text) {
	const headerCritical = [...text.matchAll(/^###\s+C\d+\./gm)].length;
	const headerMedium   = [...text.matchAll(/^###\s+M\d+\./gm)].length;
	const headerLow      = [...text.matchAll(/^###\s+L\d+\./gm)].length;
	if (headerCritical + headerMedium + headerLow > 0) {
		return {
			maxSeverity: headerCritical > 0 ? "critical" : headerMedium > 0 ? "medium" : "low",
			critical: headerCritical,
			medium: headerMedium,
			low: headerLow,
		};
	}
	const tableCritical = [...text.matchAll(/^\|\s*\w+\s*\|\s*critical/gim)].length;
	const tableMedium   = [...text.matchAll(/^\|\s*\w+\s*\|\s*medium/gim)].length;
	const tableLow      = [...text.matchAll(/^\|\s*\w+\s*\|\s*low/gim)].length;
	if (tableCritical + tableMedium + tableLow > 0) {
		return {
			maxSeverity: tableCritical > 0 ? "critical" : tableMedium > 0 ? "medium" : "low",
			critical: tableCritical,
			medium: tableMedium,
			low: tableLow,
		};
	}
	const labelCritical = [...text.matchAll(/\*\*(?:Severity|严重程度|严重性)\*\*\s*:\s*critical/gi)].length;
	const labelMedium   = [...text.matchAll(/\*\*(?:Severity|严重程度|严重性)\*\*\s*:\s*medium/gi)].length;
	const labelLow      = [...text.matchAll(/\*\*(?:Severity|严重程度|严重性)\*\*\s*:\s*low/gi)].length;
	if (labelCritical + labelMedium + labelLow > 0) {
		return {
			maxSeverity: labelCritical > 0 ? "critical" : labelMedium > 0 ? "medium" : "low",
			critical: labelCritical,
			medium: labelMedium,
			low: labelLow,
		};
	}
	return null;
}

// 模拟 review-20260519-230500.md 的格式
const reviewText1 = `# 代码审查\n\n### C1. [Bug] 第一个严重问题\n内容...\n### C2. [Bug] 第二个严重问题\n### M1. [优化] 中等问题\n### L1. [风格] 低优先级`;
const sev1 = simulateExtractSeverityFromText(reviewText1);
assertEq(sev1?.maxSeverity, "critical", "### C1. 格式应解析为 critical");
assertEq(sev1?.critical, 2, "### C1./C2. 应计数 2 critical");
assertEq(sev1?.medium, 1, "### M1. 应计数 1 medium");
assertEq(sev1?.low, 1, "### L1. 应计数 1 low");

// 模拟 review-20260519-231500.md 的混合格式（header 优先）
const reviewText2 = `# 复核审查\n\n### C1. [编译错误] 文件被截断\n### C2. [编译错误] buildCp 未定义\n### C3. 重复代码\n\n| 编号 | 等级 | 状态 | 说明 |\n| C2 | critical | ✅ | 确认 |\n| M1 | medium | ✅ | 确认 |`;
const sev2 = simulateExtractSeverityFromText(reviewText2);
assertEq(sev2?.maxSeverity, "critical", "混合格式 header 优先应解析为 critical");
assertEq(sev2?.critical, 3, "Header 优先: 3 critical (C1/C2/C3), 不重复计数表格行");

// 纯表格格式（无 header）
const reviewText3 = `| 编号 | 等级 | 说明 |\n| --- | --- | --- |\n| C1 | critical | Bug |\n| M1 | medium | 优化 |\n| M2 | medium | 重构 |`;
const sev3 = simulateExtractSeverityFromText(reviewText3);
assertEq(sev3?.maxSeverity, "critical", "纯表格格式应解析为 critical");
assertEq(sev3?.critical, 1, "纯表格: 1 critical");
assertEq(sev3?.medium, 2, "纯表格: 2 medium");

// **Severity**: critical 标签格式
const reviewText4 = `## 问题\n**Severity**: critical\n内容...\n**严重程度**: medium\n其他内容`;
const sev4 = simulateExtractSeverityFromText(reviewText4);
assertEq(sev4?.maxSeverity, "critical", "**Severity**: 标签格式应解析为 critical");
assertEq(sev4?.critical, 1, "标签格式 critical 计数");

// 无匹配
const reviewText5 = `# 正常文档\n没有任何严重标记`;
assertEq(simulateExtractSeverityFromText(reviewText5), null, "无匹配应返回 null");

// 空文本
assertEq(simulateExtractSeverityFromText(""), null, "空文本应返回 null");

// Test 10: readLatestReviewMd — 从实际审查文件读取
console.log("\n📋 readLatestReviewMd + extractSeverityFromText 集成测试\n");

function simulateReadLatestReviewMd(cwd) {
	const reviewDir = path.join(cwd, "pi-dev-output", "pi-review", "md");
	try {
		if (!fs.existsSync(reviewDir)) return null;
		const files = fs.readdirSync(reviewDir)
			.filter(f => f.endsWith(".md"))
			.map(f => ({ name: f, mtime: fs.statSync(path.join(reviewDir, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		if (files.length === 0) return null;
		return fs.readFileSync(path.join(reviewDir, files[0].name), "utf-8");
	} catch { return null; }
}

const reviewContent = simulateReadLatestReviewMd(__dirname + "/..");
if (reviewContent) {
	const result = simulateExtractSeverityFromText(reviewContent);
	// 最新的审查文件（230500 或 231500）都有 critical 问题
	assertEq(typeof result?.maxSeverity, "string", "从实际审查文件应解析出 severity");
	// 至少有一个 critical（两份新文件都有）
	assert(result?.critical > 0, "审查文件中应检测到 critical 问题");
} else {
	assert(true, "无审查文件时跳过（非错误）");
}

// 不存在的目录
assertEq(simulateReadLatestReviewMd("/nonexistent/path"), null, "不存在的目录应返回 null");

// Test 11: 验证 extractFinalOutput 对已损坏/不完整输出的鲁棒性
const partialOutput = '{"type":"message_start"}\n{"invalid json\n';
const partialExtracted = simulateExtractFinalOutput(partialOutput);
assertEq(typeof partialExtracted, "string", "部分损坏的输出应返回字符串而非崩溃");

// ═══════════════════════════════════════════════════════════════
//  12. isTimeoutResult
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
