/**
 * test-no-subagents.mjs — 结构性回归断言
 *
 * Run: node tests/test-no-subagents.mjs
 *
 * 覆盖：
 *   1. 子代理基础设施已删除
 *   2. dev 命令：4 个命令、参数即任务、意图识别复用 pre-check、不再绑定 Grill/PRD
 *   3. 自动审查检测独立为 review-detect.ts
 *   4. git 命令直接执行，不再委派给子代理
 *   5. /grill 与 /prd 是独立命令
 *   6. UI 组件与输出目录约定
 *   7. /dev-pre-check 意图校验（confirmIntent、只读探查规则为共享实现）
 *   8. notify 调用使用合法类型（info / warning / error）
 *   9. 当前版本的 RELEASE 说明覆盖该版本区间内的全部 commit
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
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
//  2. dev 命令：4 个命令，参数即任务，意图识别复用 pre-check
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 dev-prompts.ts\n");

assertNotIncludes("extensions/dev-prompts.ts", "./sub-agents", "不再引入 sub-agents");
assertNotIncludes("extensions/dev-prompts.ts", "./workflow-engine", "不再引入 workflow-engine");
assertNotIncludes("extensions/dev-prompts.ts", "./grill-me-agent", "不再绑定 Grill/PRD 运行时");
assertNotIncludes("extensions/dev-prompts.ts", "runGrillPhase", "不再触发 Grill 追问");
assertNotIncludes("extensions/dev-prompts.ts", "runPRDPhase", "不再触发 PRD 生成");
assertNotIncludes("extensions/dev-prompts.ts", "WizardQuestion", "向导式提问已移除");
assertIncludes("extensions/dev-prompts.ts", 'import { confirmIntent } from "./pre-check"', "意图识别复用 pre-check");
assertIncludes("extensions/dev-prompts.ts", "uiTaskArg(ctx, args", "任务原文来自命令参数，缺省才弹输入框");
assertIncludes("extensions/dev-prompts.ts", "detectProjectDefaults", "默认验收标准来自项目探测");
assertIncludes("extensions/dev-prompts.ts", "defaultAcceptanceItems", "默认验收标准按条目生成");
assertIncludes("extensions/dev-prompts.ts", "## 身份与职责", "提示词包含身份与职责段");
assertIncludes("extensions/dev-prompts.ts", "## 已确认的任务意图", "提示词携带已确认的意图");
assertIncludes("extensions/dev-prompts.ts", "## 验收标准", "提示词包含默认验收标准段");
assertIncludes("extensions/dev-prompts.ts", "pi.sendUserMessage(prompt", "组装后的提示词直接发送给当前代理");

for (const cmd of ["dev-feat", "dev-fix", "dev-refactor", "dev-test"]) {
	assertIncludes("extensions/dev-prompts.ts", `registerDev(pi, "${cmd}"`, `注册 /${cmd}`);
}

for (const cmd of ["dev-doc", "dev-perf", "dev-style", "dev-security", "dev-chore", "dev-explain", "dev-compare"]) {
	assertNotIncludes("extensions/dev-prompts.ts", `"${cmd}"`, `/${cmd} 已移除`);
}

// ═══════════════════════════════════════════════════════════════
//  3. 自动审查检测独立为 review-detect.ts
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 review-detect.ts\n");

assertExists("extensions/review-detect.ts", "自动审查检测独立成扩展");
assertNotIncludes("extensions/review-detect.ts", "./sub-agents", "不再引入 sub-agents");
assertIncludes("extensions/review-detect.ts", 'pi.on("input"', "拦截带审查意图的输入");
assertIncludes("extensions/review-detect.ts", 'event.source === "extension"', "过滤扩展注入消息，防止递归");
assertIncludes("extensions/review-detect.ts", "expandPromptTemplates: true", "skill 命令展开执行");
assertIncludes("extensions/review-detect.ts", '"pi-review"', "自动审查仍查找 pi-review/ 输出目录");

// ═══════════════════════════════════════════════════════════════
//  4. Git 命令直接执行，不再委派给子代理
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 git-commands.ts\n");

assertNotIncludes("extensions/git-commands.ts", "./sub-agents", "不再引入 sub-agents");
assertNotIncludes("extensions/git-commands.ts", "spawnSubagent", "不再 spawn 子进程");
assertIncludes("extensions/git-commands.ts", "分批提交", "空消息时交由主代理分批提交");
assertIncludes("extensions/git-commands.ts", "pi.exec(\"git\"", "通过 pi.exec 直接执行 git");
assertIncludes("extensions/git-commands.ts", "git-commit", "保留 /git-commit 命令");
assertIncludes("extensions/git-commands.ts", "git-push", "保留 /git-push 命令");
assertIncludes("extensions/git-commands.ts", "git-commit-push", "保留 /git-commit-push 命令");

// ═══════════════════════════════════════════════════════════════
//  5. Grill / PRD 是独立命令，运行在当前代理中
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 grill-me-agent.ts\n");

assertNotIncludes("extensions/grill-me-agent.ts", "./sub-agents", "不再引入 sub-agents");
assertNotIncludes("extensions/grill-me-agent.ts", "spawnSubagent", "不再 spawn 子进程");
assertNotIncludes("extensions/grill-me-agent.ts", "recoverFromBackup", "断点恢复随向导一并移除");
assertIncludes("extensions/grill-me-agent.ts", 'registerCommand("grill"', "注册独立 /grill 命令");
assertIncludes("extensions/grill-me-agent.ts", 'registerCommand("prd"', "注册独立 /prd 命令");
assertIncludes("extensions/grill-me-agent.ts", "pollFor", "轮询等待当前代理产物后读取结果");
assertIncludes("extensions/grill-me-agent.ts", "GRILL_ANSWERS_DIRNAME = \"answers\"", "保留 answers 子目录");
assertIncludes("extensions/grill-me-agent.ts", "GRILL_QUESTIONS_DIRNAME = \"questions\"", "保留 questions 子目录");

// ═══════════════════════════════════════════════════════════════
//  6. UI 组件与输出目录约定
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 输出目录与 UI 组件\n");

const reviewSkill = fs.readFileSync(path.resolve(ROOT, "skills/review-html/SKILL.md"), "utf-8");
assert(reviewSkill.includes(".pi-dev-output/pi-review/html/"), "review-html 仍写入 pi-review/html/");

assertIncludes("extensions/session-utils.ts", "detectProjectDefaults", "项目探测（语言/测试/lint/pre-commit/CI）");
assertIncludes("extensions/session-utils.ts", "defaultAcceptanceItems", "生成默认验收标准条目");
assertIncludes("extensions/ui-helpers.ts", "export function uiSelect", "保留 uiSelect");
assertIncludes("extensions/ui-helpers.ts", "export function uiConfirm", "保留 uiConfirm");
assertIncludes("extensions/ui-helpers.ts", "export function uiInput", "保留 uiInput");
assertIncludes("extensions/ui-helpers.ts", "export async function uiTaskArg", "命令参数与输入框二选一取任务文本");
assertNotIncludes("extensions/ui-helpers.ts", "updateWorkflowWidget", "移除工作流 widget");
assertNotIncludes("extensions/ui-helpers.ts", "sendWorkflowResult", "移除工作流结果消息");
assertNotIncludes("extensions/ui-helpers.ts", "WorkflowStepWidgetState", "移除工作流状态类型");

// ═══════════════════════════════════════════════════════════════
//  7. /dev-pre-check 独立意图校验扩展
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 pre-check.ts\n");

assertExists("extensions/pre-check.ts", "提供独立的 pre-check 扩展");
assertIncludes("extensions/pre-check.ts", 'registerCommand("dev-pre-check"', "注册 /dev-pre-check 命令");
assertIncludes("extensions/pre-check.ts", "export async function confirmIntent", "导出共享的意图确认循环");
assertIncludes("extensions/pre-check.ts", "export const READ_ONLY_EXPLORATION_RULES", "只读探查规则为共享导出");
assertIncludes("extensions/pre-check.ts", "## 探索要求（先只读探查，再复述）", "复述前要求先只读探查代码库");
assertIncludes("extensions/pre-check.ts", "### 1. 已核实的现状（探索结果）", "复述输出先交代已核实的现状");
assertIncludes("extensions/pre-check.ts", "用自己的话重述你认为用户的目标是什么，以及用户试图解决的问题是什么", "固定指令：用自己的话重述目标与问题");
assertIncludes("extensions/pre-check.ts", "[pre-check] 任务意图校验：只复述，不执行", "意图校验提示词声明只复述不执行");
assertIncludes("extensions/pre-check.ts", "禁止修改、创建、删除任何文件", "约束禁止任何实质改动");
assertIncludes("extensions/pre-check.ts", "pi.sendUserMessage(buildExecutionPrompt", "确认通过后才发送执行提示词");
assertIncludes("extensions/pre-check.ts", "buildExecutionPrompt(originalPrompt: string, intent: string)", "执行提示词携带已确认的意图复述");
assertIncludes("extensions/pre-check.ts", "ctx.isIdle()", "以代理空闲作为复述完成信号之一");
assertIncludes("extensions/pre-check.ts", "pollFor", "轮询等待复述产物");
assertNotIncludes("extensions/pre-check.ts", "./dev-prompts", "不依赖 /dev-* 命令实现");
assertNotIncludes("extensions/pre-check.ts", "./grill-me-agent", "不依赖 Grill/PRD 运行时");
assertNotIncludes("extensions/dev-prompts.ts", "dev-pre-check", "dev-prompts 不注册覆盖 pre-check 的命令");

// ═══════════════════════════════════════════════════════════════
//  8. notify 调用使用合法类型
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 notify 类型\n");

const NOTIFY_TYPES = ["info", "warning", "error"];
const badNotify = [];
for (const file of fs.readdirSync(path.resolve(ROOT, "extensions"))) {
	if (!file.endsWith(".ts")) continue;
	const lines = fs.readFileSync(path.resolve(ROOT, "extensions", file), "utf-8").split("\n");
	for (const line of lines) {
		const matched = line.match(/\.notify\(.*,\s*"([^"]+)"\s*\)/);
		if (matched && !NOTIFY_TYPES.includes(matched[1])) badNotify.push(`${file} → ${matched[1]}`);
	}
}
assert(
	badNotify.length === 0,
	badNotify.length === 0 ? "所有 notify 调用使用合法类型（info / warning / error）" : `非法 notify 类型: ${badNotify.join(", ")}`,
);

// ═══════════════════════════════════════════════════════════════
//  9. 版本说明覆盖该版本全部 commit
// ═══════════════════════════════════════════════════════════════

console.log("\n📋 版本说明\n");

function git(args) {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();
}

const version = JSON.parse(fs.readFileSync(path.resolve(ROOT, "package.json"), "utf-8")).version;
const releaseDoc = `.version/RELEASE-v${version}.md`;
assertExists(releaseDoc, `存在 ${releaseDoc}`);

const docText = fs.readFileSync(path.resolve(ROOT, releaseDoc), "utf-8");
const listed = docText
	.split("\n")
	.map((line) => line.match(/^[0-9a-f]{7,40}\b/)?.[0])
	.filter(Boolean);
assert(listed.length > 0, "Commit History 至少列出一条 commit");

const unknown = listed.filter((h) => {
	try {
		git(["rev-parse", "--verify", "--quiet", `${h}^{commit}`]);
		return false;
	} catch {
		return true;
	}
});
assert(unknown.length === 0, `列出的 commit 都真实存在（${unknown.join(", ") || "无缺失"}）`);

// 以文档中最新的一条 commit 作为覆盖终点，避免把后续版本的提交算进本版本
const tip = listed.reduce((a, b) =>
	Number(git(["rev-list", "--count", a])) >= Number(git(["rev-list", "--count", b])) ? a : b,
);
const prevTag = git(["tag", "--merged", tip, "--sort=-v:refname"])
	.split("\n")
	.find((tag) => tag && tag !== `v${version}`);
assert(Boolean(prevTag), `找到上一版本 tag（${prevTag}）`);

const range = git(["log", "--format=%h", `${prevTag}..${tip}`]).split("\n").filter(Boolean);
const missing = range.filter((h) => !listed.some((l) => h.startsWith(l) || l.startsWith(h)));
assert(
	missing.length === 0,
	missing.length === 0
		? `${releaseDoc} 覆盖 ${prevTag}..${tip} 全部 ${range.length} 个 commit`
		: `${releaseDoc} 缺少 ${missing.length} 个 commit: ${missing.join(", ")}`,
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
