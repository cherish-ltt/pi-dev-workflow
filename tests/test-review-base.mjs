import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(root, "skills/review-html/scripts/review-base.mjs");
const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function fixture(context) {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-review-base-"));
	context.after(() => rmSync(cwd, { recursive: true, force: true }));
	const git = (...args) => execFileSync(gitPath, args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "--quiet", "--initial-branch=main");
	git("config", "user.name", "Review Test");
	git("config", "user.email", "review@example.invalid");
	const commit = (name, content, message) => {
		writeFileSync(path.join(cwd, name), content);
		git("add", "--", name);
		git("commit", "--quiet", "-m", message);
		return git("rev-parse", "HEAD");
	};
	const base = commit("app.js", "export const version = 1;\n", "base");
	git("tag", "v1.0.0");
	git("branch", "base");
	git("switch", "--quiet", "-c", "feature");
	return { cwd, git, commit, base };
}

function run(cwd, input, env = gitEnv) {
	return spawnSync(process.execPath, [script], { cwd, input: JSON.stringify(input), env, encoding: "utf8" });
}

function snapshot(cwd, baseRef, env) {
	const result = run(cwd, { baseRef }, env);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

test("three commits use the net diff for branch, tag and SHA, excluding dirty files", (context) => {
	const { cwd, git, commit, base } = fixture(context);
	commit("app.js", "export const version = 2;\n", "feature");
	commit("app.test.js", "assert.equal(version, 2);\n", "test");
	const head = commit("package.json", '{"version":"1.1.0"}\n', "release metadata");
	assert.equal(git("diff-tree", "--no-commit-id", "--name-only", "-r", head), "package.json");
	writeFileSync(path.join(cwd, "app.js"), "WORKTREE_ONLY\n");
	writeFileSync(path.join(cwd, "staged.txt"), "INDEX_ONLY\n");
	git("add", "staged.txt");
	writeFileSync(path.join(cwd, "untracked.txt"), "UNTRACKED_ONLY\n");
	const expected = git("diff", "--no-ext-diff", "--no-textconv", "--no-color", base, head, "--");
	for (const baseRef of ["base", "v1.0.0", base]) {
		const result = snapshot(cwd, baseRef);
		assert.equal(result.baseRef, baseRef);
		assert.equal(result.baseSha, base);
		assert.equal(result.mergeBaseSha, base);
		assert.equal(result.headSha, head);
		assert.equal(result.hasUncommittedChanges, true);
		assert.deepEqual(result.files, ["app.js", "app.test.js", "package.json"]);
		assert.equal(result.patch.trim(), expected);
		assert.doesNotMatch(result.patch, /WORKTREE_ONLY|INDEX_ONLY|UNTRACKED_ONLY/);
	}
	assert.equal(readFileSync(path.join(cwd, "app.js"), "utf8"), "WORKTREE_ONLY\n");
	assert.equal(git("diff", "--cached", "--name-only"), "staged.txt");
});

test("merged upstream history is excluded and reverted changes produce an empty diff", (context) => {
	const { cwd, git, commit, base } = fixture(context);
	commit("feature.txt", "feature\n", "feature");
	git("switch", "--quiet", "main");
	const upstream = commit("upstream.txt", "upstream\n", "upstream");
	git("switch", "--quiet", "feature");
	git("merge", "--quiet", "--no-edit", "main");
	const result = snapshot(cwd, "main");
	assert.equal(result.mergeBaseSha, upstream);
	assert.deepEqual(result.files, ["feature.txt"]);
	assert.doesNotMatch(result.patch, /upstream.txt/);
	const empty = snapshot(cwd, "HEAD");
	assert.deepEqual(empty.files, []);
	assert.equal(empty.patch, "");
	git("switch", "--quiet", "-c", "reverted", base);
	commit("app.js", "temporary change\n", "temporary");
	git("revert", "--no-edit", "HEAD");
	assert.equal(snapshot(cwd, "base").patch, "");
});

test("rejects missing refs, invalid requests, non-Git directories and unrelated histories", (context) => {
	const { cwd, git } = fixture(context);
	for (const baseRef of ["", "missing", "--help", "HEAD\nbase"]) {
		const result = run(cwd, { baseRef });
		assert.notEqual(result.status, 0);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /基准|引用/);
	}
	for (const request of [{}, { baseRef: ["base", "HEAD"] }, { baseRef: "base", target: "HEAD" }]) {
		assert.notEqual(run(cwd, request).status, 0);
	}
	const plain = path.join(cwd, "outside");
	mkdirSync(plain);
	assert.notEqual(run(plain, { baseRef: "base" }, { ...gitEnv, GIT_CEILING_DIRECTORIES: cwd }).status, 0);
	git("switch", "--quiet", "--orphan", "unrelated");
	git("commit", "--quiet", "--allow-empty", "-m", "unrelated");
	const unrelated = run(cwd, { baseRef: "base" });
	assert.notEqual(unrelated.status, 0);
	assert.equal(unrelated.stdout, "");
	assert.match(unrelated.stderr, /共同祖先/);
});

test("rejects criss-cross history with multiple merge bases", (context) => {
	const { cwd, git, base } = fixture(context);
	const tree = git("rev-parse", "HEAD^{tree}");
	const left = git("commit-tree", tree, "-p", base, "-m", "left");
	const right = git("commit-tree", tree, "-p", base, "-m", "right");
	const mergeLeft = git("commit-tree", tree, "-p", left, "-p", right, "-m", "merge left");
	const mergeRight = git("commit-tree", tree, "-p", right, "-p", left, "-m", "merge right");
	git("update-ref", "refs/heads/base", mergeLeft);
	git("update-ref", "refs/heads/feature", mergeRight);
	const result = run(cwd, { baseRef: "base" });
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /多个共同祖先/);
});

test("special characters remain literal ref data", (context) => {
	const { cwd, git, base } = fixture(context);
	for (const baseRef of ["topic/$(whoami)", "topic/`whoami`", "topic/quote'branch"]) {
		git("branch", baseRef, base);
		assert.equal(snapshot(cwd, baseRef).baseSha, base);
	}
});

test("moving both refs after resolution cannot change the patch", (context) => {
	const { cwd, git, commit, base } = fixture(context);
	const head = commit("app.js", "export const version = 2;\n", "feature");
	const expected = git("diff", "--no-ext-diff", "--no-textconv", "--no-color", base, head, "--");
	const bin = path.join(cwd, "bin");
	mkdirSync(bin);
	writeFileSync(path.join(bin, "git"), `#!${process.execPath}
const { execFileSync, spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("merge-base")) {
	execFileSync(${JSON.stringify(gitPath)}, ["update-ref", "refs/heads/base", ${JSON.stringify(head)}]);
	execFileSync(${JSON.stringify(gitPath)}, ["update-ref", "refs/heads/feature", ${JSON.stringify(base)}]);
}
const result = spawnSync(${JSON.stringify(gitPath)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
	const result = snapshot(cwd, "base", { ...gitEnv, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
	assert.equal(result.baseSha, base);
	assert.equal(result.headSha, head);
	assert.equal(result.patch.trim(), expected);
	assert.equal(git("rev-parse", "base"), head);
	assert.equal(git("rev-parse", "HEAD"), base);
});
