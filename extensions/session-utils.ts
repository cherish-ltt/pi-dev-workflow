/**
 * session-utils.ts — 跨扩展共享的会话与等待工具
 *
 * 职责：
 *   1. waitForIdleWithTimeout() — 带超时的等待，SDK 的 ctx.waitForIdle() 不接受超时参数
 *   2. getLastAssistantTextAfter() — 提取指定时间点之后最后一条 assistant 文本
 *
 * 供 git-commands.ts / grill-me-agent.ts / dev-prompts.ts 等扩展共享使用。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

/** 项目基础信息，用于生成默认验收标准与默认字段。 */
export interface ProjectDefaults {
	language: string;
	testCmd: string;
	lintCmd: string;
	packageManager: string;
	hasPreCommit: boolean;
	hasCI: boolean;
}

function safeReaddir(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".pi-dev-output"]);

/** 浅层递归收集文件扩展名（深度 2），用于语言推断。 */
function scanExtensions(cwd: string, depth: number): string[] {
	const exts = new Set<string>();
	const walk = (dir: string, d: number): void => {
		if (d > depth) return;
		for (const name of safeReaddir(dir)) {
			const full = path.join(dir, name);
			let stat: fs.Stats | undefined;
			try {
				stat = fs.statSync(full);
			} catch {
				continue;
			}
			if (stat.isDirectory()) {
				if (!SKIP_DIRS.has(name)) walk(full, d + 1);
			} else {
				const m = name.match(/\.([a-z0-9]+)$/i);
				if (m) exts.add(m[1]!.toLowerCase());
			}
		}
	};
	walk(cwd, depth);
	return [...exts];
}

/** 探测当前项目的语言/测试/lint 命令与工程规范（pre-commit、CI）。 */
export function detectProjectDefaults(cwd: string): ProjectDefaults {
	const d: ProjectDefaults = {
		language: "",
		testCmd: "",
		lintCmd: "",
		packageManager: "npm",
		hasPreCommit: false,
		hasCI: false,
	};
		try {
		const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
		const scripts = pkg.scripts ?? {};
		const rawTest = scripts.test ?? "";
		d.testCmd = /no test specified/.test(rawTest) ? "" : rawTest;
		d.lintCmd = scripts.lint ?? scripts["lint:fix"] ?? scripts.format ?? "";
		const pm = pkg.packageManager ?? "";
		d.packageManager = /pnpm/.test(pm) ? "pnpm" : /yarn/.test(pm) ? "yarn" : "npm";
		const meta = [pkg.name ?? "", Object.keys(pkg.dependencies ?? {}), Object.keys(pkg.devDependencies ?? {})].flat().join(" ").toLowerCase();
		if (fs.existsSync(path.join(cwd, "tsconfig.json")) || /typescript|tsx/.test(meta)) d.language = "TypeScript";
		else if (/javascript|next|react|vue|node|nest/.test(meta)) d.language = "JavaScript";
	} catch { /* 非 Node 项目 */ }
	if (!d.language) {
		const files = safeReaddir(cwd);
		const exts = scanExtensions(cwd, 2);
		if (fs.existsSync(path.join(cwd, "Cargo.toml"))) d.language = "Rust";
		else if (fs.existsSync(path.join(cwd, "go.mod"))) d.language = "Go";
		else if (fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "requirements.txt"))) d.language = "Python";
		else if (fs.existsSync(path.join(cwd, "pom.xml")) || fs.existsSync(path.join(cwd, "build.gradle"))) d.language = "Java";
		else if (files.some((f) => f.endsWith(".csproj"))) d.language = "C#";
		else if (exts.includes("rs")) d.language = "Rust";
		else if (exts.includes("go")) d.language = "Go";
		else if (exts.includes("py")) d.language = "Python";
		else if (exts.includes("ts") || exts.includes("tsx")) d.language = "TypeScript";
		else if (exts.some((e) => ["js", "mjs", "cjs", "jsx"].includes(e))) d.language = "JavaScript";
	}
	d.hasPreCommit = fs.existsSync(path.join(cwd, ".pre-commit-config.yaml")) || fs.existsSync(path.join(cwd, ".pre-commit-config.yml"));
	d.hasCI = safeReaddir(path.join(cwd, ".github", "workflows")).some((f) => /\.ya?ml$/.test(f));
	return d;
}

/** 根据项目探测结果生成常规验收标准（测试 + lint + pre-commit + CI）。 */
export function defaultAcceptance(d: ProjectDefaults): string {
	const parts: string[] = [];
	if (d.testCmd) parts.push(`运行 ${d.testCmd} 确认全部测试通过、无回归`);
	else parts.push(`按 ${d.language || "项目"} 的常规测试方式编写并运行测试，确认核心逻辑正确、无回归`);
	if (d.lintCmd) parts.push(`运行 ${d.lintCmd} 符合代码规范`);
	if (d.hasPreCommit) parts.push("通过本地 pre-commit 钩子检查");
	if (d.hasCI) parts.push("通过 CI 检查");
	if (parts.length === 0) parts.push("核心逻辑正确、边界情况处理完善、无行为回归");
	return parts.join("；");
}

/**
 * Wait for the agent to become idle, bounded by timeoutMs.
 * SDK 的 `ctx.waitForIdle()` 签名无超时参数（agent-session.d.ts），
 * 直接传入会静默忽略，这里用 race 实现真实超时。
 * 超时后抛出 Error，由调用方自行决定 fallback。
 */
export async function waitForIdleWithTimeout(ctx: ExtensionCommandContext, timeoutMs: number): Promise<void> {
	await Promise.race([
		ctx.waitForIdle(),
		new Promise<never>((_resolve, reject) =>
			setTimeout(() => reject(new Error(`等待代理完成超时 (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs),
		),
	]);
}

/**
 * Extract the most recent assistant message text that arrived after a given moment.
 * Used as fallback when the agent did not write the expected file.
 */
export function getLastAssistantTextAfter(ctx: ExtensionCommandContext, afterMs: number): string {
	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) return "";
	try {
		const branch = ctx.sessionManager.getBranch(leafId);
		let text = "";
		for (const entry of branch) {
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			const ts = new Date(entry.timestamp).getTime();
			if (ts > afterMs) {
				text = extractMessageText(entry.message.content) || text;
			}
		}
		return text;
	} catch {
		return "";
	}
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "type" in part && part.type === "text") {
					return (part as { text: string }).text;
				}
				return "";
			})
			.join("\n");
	}
	return "";
}

// ── Extension factory (required by pi extension loader) ─────

export default function (_pi: ExtensionAPI) {
	// session-utils is a helper module, imported by other extensions.
}
