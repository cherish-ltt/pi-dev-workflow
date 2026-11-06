import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

try {
	const request = JSON.parse(readFileSync(0, "utf8"));
	if (!request || Object.keys(request).length !== 1 || typeof request.baseRef !== "string" ||
		!request.baseRef || request.baseRef.startsWith("-") || /[\s\x00-\x1f]/.test(request.baseRef)) {
		throw new Error('基准输入必须是仅含一个非空 baseRef 字符串的 JSON 对象，如 {"baseRef":"main"}；引用不能以连字符开头。');
	}
	let cwd = process.cwd();
	function git(args, allowNoAncestor = false) {
		const result = spawnSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
		if (result.error) throw result.error;
		if (allowNoAncestor && result.status === 1 && !result.stderr) return "";
		if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} 失败（${result.status}）`);
		return result.stdout;
	}

	cwd = git(["rev-parse", "--show-toplevel"]).trim();
	const headSha = git(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]).trim();
	let baseSha;
	try {
		baseSha = git(["rev-parse", "--verify", "--end-of-options", `${request.baseRef}^{commit}`]).trim();
	} catch (error) {
		throw new Error(`无法解析本地基准引用 ${JSON.stringify(request.baseRef)}：${error.message}`);
	}
	const ancestors = git(["merge-base", "--all", baseSha, headSha], true).trim().split("\n").filter(Boolean);
	if (ancestors.length === 0) throw new Error("基准与 HEAD 没有可用的共同祖先；请检查引用及本地历史是否完整。");
	if (ancestors.length !== 1) throw new Error("基准与 HEAD 存在多个共同祖先；请显式提供一个更明确的基准 commit。");
	const mergeBaseSha = ancestors[0];
	const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", mergeBaseSha, headSha, "--"];
	const patch = git(diffArgs);
	const files = git([...diffArgs.slice(0, 5), "--name-only", "-z", ...diffArgs.slice(5)]).split("\0").filter(Boolean);
	const numstat = git([...diffArgs.slice(0, 5), "--numstat", ...diffArgs.slice(5)]);
	const hasUncommittedChanges = git(["status", "--porcelain", "--untracked-files=normal"]).length > 0;
	process.stdout.write(JSON.stringify({
		baseRef: request.baseRef,
		baseSha,
		mergeBaseSha,
		headSha,
		hasUncommittedChanges,
		semantics: "唯一 merge-base 到固定 HEAD 的已提交净变更；仅使用当前本地引用，不包含 index、工作区或未跟踪文件。",
		files,
		numstat,
		patch,
	}, null, 2) + "\n");
} catch (error) {
	process.stderr.write(`基准审查已停止：${error.message}\n请确认输入格式、本地 Git 仓库和基准引用后重试；未生成审查报告。\n`);
	process.exitCode = 1;
}
