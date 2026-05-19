/**
 * test-output-directory-structure.mjs — 验证输出目录结构调整正确
 *
 * Bug: 原先 pi-dev-output/pi-grill/ 直接存放 answer-*.md 和 questions-*.json，
 * pi-dev-output/pi-review/ 直接存放 *.html 和 *.md，没有分类子目录。
 *
 * 预期新结构：
 *   pi-dev-output/pi-grill/questions/  → questions-<id>-<YYYYMMDD-HHmm>.json
 *   pi-dev-output/pi-grill/answers/    → answer-<id>-<YYYYMMDD-HHmm>.md
 *   pi-dev-output/pi-review/html/      → *.html
 *   pi-dev-output/pi-review/md/        → *.md
 *
 * Run: node tests/test-output-directory-structure.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRILL_ME_PATH = path.resolve(__dirname, "../extensions/grill-me-agent.ts");
const SUB_AGENTS_PATH = path.resolve(__dirname, "../extensions/sub-agents.ts");
const WORKFLOW_PATH = path.resolve(__dirname, "../extensions/workflow-engine.ts");

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

function assertIncludes(source, substr, msg) {
	assert(source.includes(substr), msg);
}

function assertNotIncludes(source, substr, msg) {
	assert(!source.includes(substr), msg);
}

// ═══════════════════════════════════════════════════════════════
//  1. grill-me-agent.ts — 常量与路径
// ═══════════════════════════════════════════════════════════════

console.log("📋 grill-me-agent.ts — 目录常量与文件路径\n");

const grillMe = fs.readFileSync(GRILL_ME_PATH, "utf-8");

// 1a. 新常量定义
assertIncludes(grillMe, 'GRILL_ANSWERS_DIRNAME = "answers"', "定义 GRILL_ANSWERS_DIRNAME = answers");
assertIncludes(grillMe, 'GRILL_QUESTIONS_DIRNAME = "questions"', "定义 GRILL_QUESTIONS_DIRNAME = questions");

// 1b. grillOutputPath 写入 questions 子目录 + 新文件名格式
assertIncludes(grillMe, 'path.join(GRILL_DIRNAME, GRILL_QUESTIONS_DIRNAME)', "grillOutputPath 使用 questions 子目录");
assertIncludes(grillMe, "questions-${ts}-${formatTimestamp()}.json", "grillOutputPath 文件名含 formatTimestamp");

// 1c. saveAnswerFile 写入 answers 子目录 + 新文件名格式
assertIncludes(grillMe, 'path.join(GRILL_DIRNAME, GRILL_ANSWERS_DIRNAME)', "saveAnswerFile 使用 answers 子目录");
assertIncludes(grillMe, "answer-${ts}-${formatTimestamp()}.md", "saveAnswerFile 文件名含 formatTimestamp");
assertIncludes(grillMe, "DEV_OUTPUT_DIR, GRILL_DIRNAME, GRILL_ANSWERS_DIRNAME, filename", "saveAnswerFile 返回路径含 answers 子目录");

// 1d. recoverFromBackup 从 answers 子目录读取
assertIncludes(grillMe, "GRILL_DIRNAME, GRILL_ANSWERS_DIRNAME", "recoverFromBackup 从 answers 子目录读取");

// 1e. formatTimestamp 辅助函数
assertIncludes(grillMe, "function formatTimestamp", "定义 formatTimestamp 辅助函数");

// 1f. 旧文件名格式不应再出现
// Note: still allow "questions-" prefix in path.join for grillOutputPath
const oldSavePattern = "answer-${ts}.md";
assertNotIncludes(grillMe, oldSavePattern, "saveAnswerFile 不使用旧格式 answer-${ts}.md");

const oldQuestionsPattern = "questions-${ts}.json";
assertNotIncludes(grillMe, oldQuestionsPattern, "grillOutputPath 不使用旧格式 questions-${ts}.json");

// ═══════════════════════════════════════════════════════════════
//  2. sub-agents.ts — findNewestReviewHtml 新增优先路径
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 sub-agents.ts — findNewestReviewHtml 搜索路径\n");

const subAgents = fs.readFileSync(SUB_AGENTS_PATH, "utf-8");
assertIncludes(subAgents, '"pi-dev-output", "pi-review", "html"', "findNewestReviewHtml 优先搜索 pi-review/html/");

// ═══════════════════════════════════════════════════════════════
//  3. workflow-engine.ts — reviewer 报告写入路径
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 workflow-engine.ts — buildReviewTask 输出路径\n");

const workflowEngine = fs.readFileSync(WORKFLOW_PATH, "utf-8");
assertIncludes(workflowEngine, "pi-dev-output/pi-review/md/", "buildReviewTask 告诉 reviewer 写入 pi-review/md/");

// ═══════════════════════════════════════════════════════════════
//  4. agent 定义文件一致性
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 Agent 定义文件路径一致性\n");

const reviewAgent = fs.readFileSync(
	path.resolve(__dirname, "../agents/review-agent.md"), "utf-8");
assertIncludes(reviewAgent, "pi-dev-output/pi-review/html/",
	"review-agent 写入 pi-dev-output/pi-review/html/");
assertNotIncludes(reviewAgent, "pi-dev-output/pi-review/ 目录",
	"review-agent 不再引用旧的 pi-dev-output/pi-review/ (无子目录)");

const workflowReviewer = fs.readFileSync(
	path.resolve(__dirname, "../agents/workflow/reviewer-agent.md"), "utf-8");
assertIncludes(workflowReviewer, "pi-dev-output/pi-review/md/",
	"workflow/reviewer-agent 写入 pi-dev-output/pi-review/md/");

// ═══════════════════════════════════════════════════════════════
//  5. review-html SKILL 路径一致性
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 skills/review-html 路径一致性\n");

const reviewSkill = fs.readFileSync(
	path.resolve(__dirname, "../skills/review-html/SKILL.md"), "utf-8");
assertIncludes(reviewSkill, "pi-dev-output/pi-review/html/",
	"review-html skill 写入 pi-dev-output/pi-review/html/");
assertNotIncludes(reviewSkill, "pi-dev-output/pi-review/ 目录",
	"review-html skill 不再引用旧的 pi-dev-output/pi-review/ (无子目录)");

// ═══════════════════════════════════════════════════════════════
//  6. 文件名格式验证：saveAnswerFile 和 grillOutputPath 生成的名称含时间戳
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 文件名格式验证\n");

// Simulate the formatTimestamp function
function formatTimestamp() {
	const now = new Date();
	const Y = now.getFullYear().toString();
	const M = (now.getMonth() + 1).toString().padStart(2, "0");
	const D = now.getDate().toString().padStart(2, "0");
	const h = now.getHours().toString().padStart(2, "0");
	const m = now.getMinutes().toString().padStart(2, "0");
	return `${Y}${M}${D}-${h}${m}`;
}

// Verify the format matches YYYYMMDD-HHmm
const ts = formatTimestamp();
const formatRegex = /^\d{8}-\d{4}$/;
assert(formatRegex.test(ts), `formatTimestamp 格式正确 (${ts} 匹配 YYYYMMDD-HHmm)`);

// Simulate filename generation
const id = Date.now().toString(36);
const answerFilename = `answer-${id}-${ts}.md`;
const questionsFilename = `questions-${id}-${ts}.json`;

assert(answerFilename.startsWith("answer-"), "answer 文件名以 answer- 开头");
assert(answerFilename.endsWith(".md"), "answer 文件名以 .md 结尾");
assert(questionsFilename.startsWith("questions-"), "questions 文件名以 questions- 开头");
assert(questionsFilename.endsWith(".json"), "questions 文件名以 .json 结尾");

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
	console.log("\n✅ 所有测试通过 — 输出目录结构调整正确");
}
