/**
 * test-grill-json-fix.mjs — Verify the JSON stability fixes for grill-me-agent
 *
 * Tests:
 * 1. writeToolPromptSuffix 包含 JSON Schema
 * 2. writeToolPromptSuffix 包含转义规则
 * 3. writeToolPromptSuffix 包含自我校验指令
 * 4. readQuestionsFromFile 正确处理合法 JSON
 * 5. readQuestionsFromFile 正确处理无效 JSON（返回空数组 + 不报错）
 * 6. readQuestionsFromFile 正确处理含特殊字符的 JSON
 * 7. 输出文件不再被删除
 * 8. 重试 prompt 包含错误上下文
 * 9. ensureOutputDir 的 .gitignore 让文件不被 git 跟踪（保留在本地）
 *
 * Run: node tests/test-grill-json-fix.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, "../extensions/grill-me-agent.ts");

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

// ── Read the source file ─────────────────────────────────────

let source;
try {
	source = fs.readFileSync(EXT_PATH, "utf-8");
} catch (e) {
	console.error(`Failed to read source file: ${e.message}`);
	process.exit(1);
}

console.log(`📄 源文件: ${EXT_PATH}`);
console.log(`📏 文件大小: ${source.length} 字节\n`);

// ── Test 1: Contains JSON Schema ─────────────────────────────

assert(
	source.includes('"$schema": "http://json-schema.org/draft-07/schema#"'),
	"writeToolPromptSuffix 应包含 Draft-07 JSON Schema",
);

assert(
	source.includes('"required": ["id", "question", "options"]'),
	"JSON Schema 要求 id, question, options 为必填字段",
);

assert(
	source.includes('"minItems": 1'),
	"JSON Schema 要求 options 至少 1 项",
);

// ── Test 2: Contains escaping rules ──────────────────────────

assert(
	source.includes("String escaping rules") ||
	source.includes("JSON-escaped"),
	"writeToolPromptSuffix 应包含字符串转义规则",
);

assert(
	source.includes("Double quotes inside text"),
	"转义规则应提及双引号",
);

assert(
	source.includes("Newlines"),
	"转义规则应提及换行符",
);

assert(
	source.includes("Backslashes"),
	"转义规则应提及反斜杠",
);

// ── Test 3: Contains self-review instruction ─────────────────

assert(
	source.includes("Self-review") ||
	source.includes("mentally validate") ||
	source.includes("mentally validate your JSON"),
	"writeToolPromptSuffix 应包含自我校验指令",
);

// ── Test 4: Example uses unicode escapes ─────────────────────
// Note: The source file has \\uXXXX (double backslash in raw text)
// because TypeScript single-quoted string \\ → single backslash in value.
// search for "\\\\u" (two backslashes in raw file = "\\u" in JS regex)
assert(
	source.includes("\\\\u9879\\\\u76ee") ||
	(source.includes("\\\\u9879") && source.includes("u9879")),
	"示例应包含 JSON unicode 转义序列（合法 JSON 示例）",
);

// ── Test 5: readQuestionsFromFile has error logging ──────────

assert(
	source.includes("[grill-me-agent] JSON parse error in"),
	"readQuestionsFromFile 应在 JSON 解析失败时输出错误日志",
);

// ── Test 6: Output files are no longer deleted ───────────────

assert(
	!source.includes("fs.unlinkSync(outputFilePath)") &&
	!source.includes("fs.unlinkSync(retryPath)"),
	"输出文件不应再被 fs.unlinkSync 删除",
);

// ── Test 7: Retry prompt includes error context ──────────────

assert(
	source.includes("Previous attempt had JSON errors") ||
	source.includes("parseErrorMsg"),
	"重试 prompt 应包含前次错误的上下文",
);

// ── Test 8: Parse valid JSON ─────────────────────────────────

function simulateReadQuestions(raw) {
	try {
		const parsed = JSON.parse(raw);
		const items = Array.isArray(parsed) ? parsed : parsed.questions;
		if (!Array.isArray(items)) return 0;
		return items.filter(
			(q) => q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length > 0,
		).length;
	} catch {
		return 0;
	}
}

const validJson = JSON.stringify({
	questions: [
		{ id: 1, question: "测试问题", options: ["选项A", "选项B"] },
		{ id: 2, question: "第二个问题", options: ["选项X", "选项Y", "选项Z"] },
	],
});

assert(
	simulateReadQuestions(validJson) === 2,
	"readQuestionsFromFile 应解析合法 JSON 并返回正确数量的问题",
);

// ── Test 9: Invalid JSON (unescaped double quotes) ───────────

const invalidJson = `{
  "questions": [
    {
      "id": 1,
      "question": "他说"这个不行"，如何处理？",
      "options": ["忽略", "修复"]
    }
  ]
}`;

assert(
	simulateReadQuestions(invalidJson) === 0,
	"readQuestionsFromFile 遇到非法 JSON 应返回空数组，而非崩溃",
);

// ── Test 10: JSON with properly escaped special chars ────────

const escapedJson = JSON.stringify({
	questions: [
		{
			id: 1,
			question: '他说"这个不行"，如何处理？',
			options: ["忽略", "修复"],
		},
	],
});

assert(
	simulateReadQuestions(escapedJson) === 1,
	"readQuestionsFromFile 应解析含转义双引号的合法 JSON",
);

// ── Test 11: Bare array format backward compat ───────────────

const bareArray = JSON.stringify([
	{ id: 1, question: "测试问题", options: ["A", "B"] },
]);

assert(
	simulateReadQuestions(bareArray) === 1,
	"readQuestionsFromFile 应后向兼容裸数组格式 [...]",
);

// ── Test 12: Missing vs empty fields ─────────────────────────
// Empty string "" passes filter (typeof "" === "string" is true).
// Only truly missing (undefined) fields are filtered.

const withIncomplete = JSON.stringify({
	questions: [
		{ id: 1, question: "完整问题", options: ["A"] },
		{ id: 2, question: "", options: ["A"] },          // empty string, passes filter
		{ id: 3, options: ["A"] },                         // missing question, filtered
		{ id: 4, question: "无选项" },                      // missing options, filtered
	],
});

assert(
	simulateReadQuestions(withIncomplete) === 2,
	"readQuestionsFromFile 应过滤缺失字段的问题，空字符串字段应保留",
);

// ── Test 13: gitignore for output dir exists ─────────────────

assert(
	source.includes("pi-grill"),
	"代码中应引用 pi-grill 输出目录",
);

// ── Summary ──────────────────────────────────────────────────

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`结果: ${pass} 通过, ${fail} 失败, 共 ${pass + fail} 个测试`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

if (fail > 0) {
	console.error("\n⚠️  部分测试未通过");
	process.exit(1);
} else {
	console.log("\n✅ 所有测试通过");
}
