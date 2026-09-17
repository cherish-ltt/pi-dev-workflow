/**
 * test-no-subagents.mjs — 验证子代理系统已移除，其余功能正常工作
 *
 * Run: node tests/test-no-subagents.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

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

function assertNotExists(rel, msg) {
	assert(!fs.existsSync(path.resolve(ROOT, rel)), msg);
}

function assertExists(rel, msg) {
	assert(fs.existsSync(path.resolve(ROOT, rel)), msg);
}

function assertIncludes(rel, substr, msg) {
	const src = fs.readFileSync(path.resolve(ROOT, rel), "utf-8");
	assert(src.includes(substr), msg);
}

function assertNotIncludes(rel, substr, msg) {
	const src = fs.readFileSync(path.resolve(ROOT, rel), "utf-8");
	assert(!src.includes(substr), msg);
}

// ═══════════════════════════════════════════════════════════════
//  1. 子代理基础设施已删除
// ═══════════════════════════════════════════════════════════════

console.log("📋 子代理基础设施\n");

assertNotExists("extensions/sub-agents.ts", "extensions/sub-agents.ts 已删除");
assertNotExists("extensions/workflow-engine.ts", "extensions/workflow-engine.ts 已删除");
assertExists("extensions/session-utils.ts", "extensions/session-utils.ts 提供共享的等待/会话工具");
assertNotExists("agents/", "agents/ 目录已删除");
assertNotExists(".doc/AGENT-FRONTMATTER-REFERENCE.md", "AGENT-FRONTMATTER-REFERENCE.md 已删除");

// ═══════════════════════════════════════════════════════════════
//  2. dev-prompts 不再引用子代理，改为直接发送给当前代理
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 dev-prompts.ts\n");

assertNotIncludes("extensions/dev-prompts.ts", "./sub-agents", "不再引入 sub-agents");
assertNotIncludes("extensions/dev-prompts.ts", "./workflow-engine", "不再引入 workflow-engine");
assertNotIncludes("extensions/dev-prompts.ts", "runWorkflow", "不再调用 runWorkflow");
assertNotIncludes("extensions/dev-prompts.ts", "discoverAgents", "不再自动发现 agent");
assertNotIncludes("extensions/dev-prompts.ts", "WORKFLOW_STEPS", "不再定义工作流步骤链");
assertIncludes("extensions/dev-prompts.ts", "event.source === \"extension\"", "过滤扩展注入消息，防止递归");
assertIncludes("extensions/dev-prompts.ts", "expandPromptTemplates: true", "skill 命令展开执行");
assertIncludes("extensions/dev-prompts.ts", "pi.sendUserMessage(finalPrompt", "组装后的提示词直接发送给当前代理");
assertIncludes("extensions/dev-prompts.ts", "saveAnswerFile(ctx.cwd, finalPrompt)", "保留提示词持久化");
assertIncludes("extensions/dev-prompts.ts", "recoverFromBackup(ctx.cwd)", "保留断点恢复");

// ═══════════════════════════════════════════════════════════════
//  3. Git 命令直接执行，不再委派给子代理
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 git-commands.ts\n");

assertNotIncludes("extensions/git-commands.ts", "./sub-agents", "不再引入 sub-agents");
assertNotIncludes("extensions/git-commands.ts", "spawnSubagent", "不再 spawn 子进程");
assertIncludes("extensions/git-commands.ts", "./session-utils", "从 session-utils 获取共享工具");
assertIncludes("extensions/git-commands.ts", "pi.exec(\"git\"", "通过 pi.exec 直接执行 git");
assertIncludes("extensions/git-commands.ts", "git-commit", "保留 /git-commit 命令");
assertIncludes("extensions/git-commands.ts", "git-push", "保留 /git-push 命令");
assertIncludes("extensions/git-commands.ts", "git-commit-push", "保留 /git-commit-push 命令");

// ═══════════════════════════════════════════════════════════════
//  4. Grill / PRD 运行在当前代理中
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 grill-me-agent.ts\n");

assertNotIncludes("extensions/grill-me-agent.ts", "./sub-agents", "不再引入 sub-agents");
assertNotIncludes("extensions/grill-me-agent.ts", "spawnSubagent", "不再 spawn 子进程");
assertIncludes("extensions/grill-me-agent.ts", "waitForIdleWithTimeout", "带超时等待当前代理完成后读取结果");
assertIncludes("extensions/grill-me-agent.ts", "GRILL_ANSWERS_DIRNAME = \"answers\"", "保留 answers 子目录");
assertIncludes("extensions/grill-me-agent.ts", "GRILL_QUESTIONS_DIRNAME = \"questions\"", "保留 questions 子目录");

// ═══════════════════════════════════════════════════════════════
//  5. UI 组件保留 select/confirm/input，移除工作流面板
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 ui-helpers.ts\n");

assertNotIncludes("extensions/ui-helpers.ts", "updateWorkflowWidget", "移除工作流 widget");
assertNotIncludes("extensions/ui-helpers.ts", "sendWorkflowResult", "移除工作流结果消息");
assertNotIncludes("extensions/ui-helpers.ts", "WorkflowStepWidgetState", "移除工作流状态类型");
assertIncludes("extensions/ui-helpers.ts", "export function uiSelect", "保留 uiSelect");
assertIncludes("extensions/ui-helpers.ts", "export function uiConfirm", "保留 uiConfirm");
assertIncludes("extensions/ui-helpers.ts", "export function uiInput", "保留 uiInput");

// ═══════════════════════════════════════════════════════════════
//  6. 审查技能与输出目录结构保持不变
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 输出目录与技能\n");

const reviewSkill = fs.readFileSync(path.resolve(ROOT, "skills/review-html/SKILL.md"), "utf-8");
assertIncludes("skills/review-html/SKILL.md", ".pi-dev-output/pi-review/html/", "review-html 仍写入 pi-review/html/");

const devPrompts = fs.readFileSync(path.resolve(ROOT, "extensions/dev-prompts.ts"), "utf-8");
assertIncludes("extensions/dev-prompts.ts", ".pi-dev-output/pi-review/html", "自动审查仍查找 pi-review/html/");
assertIncludes("extensions/session-utils.ts", "detectProjectDefaults", "项目探测（语言/测试/lint/pre-commit/CI）");
assertIncludes("extensions/session-utils.ts", "defaultAcceptance", "生成默认验收标准");
assertIncludes("extensions/dev-prompts.ts", "applyDefaults", "未填字段注入默认值");
assertIncludes("extensions/dev-prompts.ts", "**验收标准**", "四段式：验收标准段");
assertIncludes("extensions/dev-prompts.ts", "WizardQuestion", "提问结构支持字段合并");
assertIncludes("extensions/dev-prompts.ts", "assignAnswers", "提问支持单值/多字段填写");

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
	console.log("\n✅ 所有测试通过 — 子代理已移除，其余功能正常运行");
}