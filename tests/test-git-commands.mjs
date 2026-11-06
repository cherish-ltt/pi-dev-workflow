import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
let entry;
try {
	entry = import.meta.resolve("@earendil-works/pi-coding-agent");
} catch (error) {
	if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
	const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	entry = pathToFileURL(path.join(globalModules, "@earendil-works/pi-coding-agent/dist/index.js")).href;
}
const require = createRequire(entry);
const { createJiti } = await import(new URL("./core/extensions/jiti-loader.js", entry));
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", entry));
const extensionPath = path.join(root, "extensions/git-commands.ts");
const register = await createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui") },
}).import(extensionPath, { default: true });

function commandContext({ cwd = root, input, execute } = {}) {
	const commands = new Map();
	const calls = [];
	const messages = [];
	const notices = [];
	register({
		registerCommand: (name, command) => commands.set(name, command),
		sendUserMessage: (message) => messages.push(message),
		exec: async (program, args, options) => {
			calls.push({ program, args, options });
			return execute ? execute(program, args, options) : { code: args[0] === "diff" ? 1 : 0, stdout: "", stderr: "" };
		},
	});
	const ctx = { cwd, ui: {
		custom: async () => input,
		notify: (message, type) => notices.push({ message, type }),
	} };
	return { commands, calls, messages, notices, run: (name, args = "") => {
		assert.ok(commands.has(name), `${name} must be registered`);
		return commands.get(name).handler(args, ctx);
	} };
}

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function fixture(context) {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-staged-"));
	context.after(() => rmSync(cwd, { recursive: true, force: true }));
	git(cwd, "init", "-q");
	git(cwd, "config", "user.name", "Git command test");
	git(cwd, "config", "user.email", "git-command-test@example.invalid");
	git(cwd, "config", "commit.gpgsign", "false");
	git(cwd, "config", "core.hooksPath", path.join(cwd, ".git", "hooks"));
	writeFileSync(path.join(cwd, "A.txt"), "original A\n");
	writeFileSync(path.join(cwd, "B.txt"), "original B\n");
	git(cwd, "add", "A.txt", "B.txt");
	git(cwd, "commit", "-qm", "baseline");
	writeFileSync(path.join(cwd, "A.txt"), "staged A\n");
	git(cwd, "add", "A.txt");
	writeFileSync(path.join(cwd, "A.txt"), "staged A\nunstaged A\n");
	writeFileSync(path.join(cwd, "B.txt"), "unstaged B\n");
	writeFileSync(path.join(cwd, "C.txt"), "untracked C\n");
	return cwd;
}

test("Pi loads both explicit staged commands alongside the original commands", async () => {
	const loaded = await loadExtensions([extensionPath], root);
	assert.deepEqual(loaded.errors, []);
	assert.deepEqual([...loaded.extensions[0].commands.keys()].sort(), [
		"git-commit", "git-commit-push", "git-commit-staged", "git-commit-staged-push", "git-push",
	]);
});

test("staged command passes the exact message as one argument and never stages files", async () => {
	const message = "  --message 'quoted' \"double\" $(touch should-not-exist) `literal`\nsecond line  ";
	const context = commandContext();
	await context.run("git-commit-staged", message);
	assert.deepEqual(context.calls.map(({ args }) => args), [
		["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "--"],
		["commit", "--cleanup=verbatim", "-m", message],
	]);
	for (const call of context.calls) {
		assert.equal(call.program, "git");
		assert.deepEqual(call.options, { cwd: root, timeout: 120_000 });
	}
	assert.deepEqual(context.messages, []);
});

test("missing, cancelled and blank staged messages never delegate or run Git", async () => {
	for (const input of [undefined, "", " \n "]) {
		for (const name of ["git-commit-staged", "git-commit-staged-push"]) {
			const context = commandContext({ input });
			await context.run(name);
			assert.deepEqual(context.calls, []);
			assert.deepEqual(context.messages, []);
		}
	}
	const context = commandContext({ input: " message from input " });
	await context.run("git-commit-staged");
	assert.equal(context.calls[1].args.at(-1), " message from input ");
});

test("empty index and failed index checks stop before commit or push", async () => {
	for (const result of [
		{ code: 0, stdout: "", stderr: "" },
		{ code: 128, stdout: "", stderr: "not a git repository" },
		new Error("executor unavailable"),
	]) {
		const context = commandContext({ execute: () => {
			if (result instanceof Error) throw result;
			return result;
		} });
		await context.run("git-commit-staged-push", "message");
		assert.equal(context.calls.length, 1);
		assert.deepEqual(context.messages, []);
		assert.match(context.notices.at(-1).message, result.code === 0 ? /没有.*暂存/ : /not a git repository|executor unavailable/);
	}
});

test("commit failure stops push and push failure retains the successful commit status", async () => {
	for (const failedCommand of ["commit", "push"]) {
		for (const throws of [false, true]) {
			const context = commandContext({ execute: (_program, args) => {
				if (args[0] === failedCommand) {
					if (throws) throw new Error(`${failedCommand} exception`);
					return { code: 1, stderr: `${failedCommand} denied`, stdout: "" };
				}
				return { code: args[0] === "diff" ? 1 : 0, stdout: "", stderr: "" };
			} });
			await context.run("git-commit-staged-push", "message");
			assert.deepEqual(context.calls.map(({ args }) => args[0]), failedCommand === "commit" ? ["diff", "commit"] : ["diff", "commit", "push"]);
			assert.ok(context.notices.some(({ message }) => message.includes(`${failedCommand} ${throws ? "exception" : "denied"}`)));
			if (failedCommand === "push") assert.match(context.notices.at(-1).message, /已提交.*推送失败/);
		}
	}
});

test("successful staged commit-push performs one commit followed by one push", async () => {
	const context = commandContext();
	await context.run("git-commit-staged-push", "message");
	assert.deepEqual(context.calls.map(({ args }) => args[0]), ["diff", "commit", "push"]);
});

test("legacy commands retain add-all, plain message and AI batch behavior", async () => {
	for (const name of ["git-commit", "git-commit-push"]) {
		const context = commandContext();
		await context.run(name, "--staged remains a plain message");
		assert.deepEqual(context.calls[0].args, ["add", "-A"]);
		assert.deepEqual(context.calls[1].args, ["commit", "-m", "--staged remains a plain message"]);
		assert.equal(context.calls.length, name === "git-commit" ? 2 : 3);
		const empty = commandContext({ input: "" });
		await empty.run(name);
		assert.deepEqual(empty.calls, []);
		assert.equal(empty.messages.length, 1);
		assert.match(empty.messages[0], /分批提交/);
		const cancelled = commandContext();
		await cancelled.run(name);
		assert.deepEqual(cancelled.calls, []);
		assert.deepEqual(cancelled.messages, []);
	}
});

test("real Git commit preserves the index tree and all unstaged or untracked content", async (context) => {
	const cwd = fixture(context);
	const originalTree = git(cwd, "write-tree").trim();
	const originalDiff = git(cwd, "diff", "--no-ext-diff", "--no-textconv");
	const message = "--quoted 'single' \"double\" $(touch injected) `literal`\n\nsecond line  ";
	const loaded = await loadExtensions([extensionPath], cwd);
	assert.deepEqual(loaded.errors, []);
	loaded.runtime.sendUserMessage = () => assert.fail("must not delegate");
	const notices = [];
	await loaded.extensions[0].commands.get("git-commit-staged").handler(message, {
		cwd, ui: { notify: (value) => notices.push(value) },
	});
	assert.equal(git(cwd, "rev-parse", "HEAD^{tree}").trim(), originalTree);
	assert.equal(git(cwd, "diff", "--no-ext-diff", "--no-textconv"), originalDiff);
	assert.equal(git(cwd, "diff", "--cached"), "");
	assert.equal(git(cwd, "ls-files", "--others", "--exclude-standard"), "C.txt\n");
	assert.equal(readFileSync(path.join(cwd, "C.txt"), "utf8"), "untracked C\n");
	assert.equal(git(cwd, "cat-file", "commit", "HEAD").split("\n\n").slice(1).join("\n\n"), `${message}\n`);
	assert.ok(notices.some((notice) => notice.includes("完成")));
});

test("real empty index cannot create or push a commit, even with dirty files", async (context) => {
	const cwd = fixture(context);
	git(cwd, "restore", "--staged", "A.txt");
	const before = git(cwd, "rev-parse", "HEAD");
	const loaded = await loadExtensions([extensionPath], cwd);
	const notices = [];
	for (const clean of [false, true]) {
		if (clean) {
			git(cwd, "restore", "A.txt", "B.txt");
			rmSync(path.join(cwd, "C.txt"));
		}
		await loaded.extensions[0].commands.get("git-commit-staged-push").handler("message", {
			cwd, ui: { notify: (value) => notices.push(value) },
		});
		assert.equal(git(cwd, "rev-parse", "HEAD"), before);
	}
	assert.equal(notices.length, 2);
	assert.ok(notices.every((notice) => /没有.*暂存/.test(notice)));
});

test("native pre-commit hook failure leaves HEAD and index unchanged and never pushes", async (context) => {
	const cwd = fixture(context);
	const before = git(cwd, "rev-parse", "HEAD");
	const originalTree = git(cwd, "write-tree");
	const hooks = path.join(cwd, ".git", "hooks");
	mkdirSync(hooks, { recursive: true });
	writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho staged-hook-rejected >&2\nexit 1\n");
	chmodSync(path.join(hooks, "pre-commit"), 0o755);
	const loaded = await loadExtensions([extensionPath], cwd);
	const notices = [];
	await loaded.extensions[0].commands.get("git-commit-staged-push").handler("message", {
		cwd, ui: { notify: (value) => notices.push(value) },
	});
	assert.equal(git(cwd, "rev-parse", "HEAD"), before);
	assert.equal(git(cwd, "write-tree"), originalTree);
	assert.ok(notices.some((notice) => notice.includes("staged-hook-rejected")));
	assert.ok(notices.every((notice) => !notice.includes("推送")));
});
