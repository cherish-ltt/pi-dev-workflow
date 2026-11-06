import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
	const globalModules = process.env.PI_GLOBAL_MODULES
		?? execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	entry = pathToFileURL(path.join(globalModules, "@earendil-works/pi-coding-agent/dist/index.js")).href;
}
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", entry));
const { initTheme, theme } = await import(new URL("./modes/interactive/theme/theme.js", entry));
initTheme("dark", false);
const questions = [
	{ id: 1, question: "保存哪些数据？", options: ["旧答案", "完整方案"] },
	{ id: 2, question: "执行条件？", options: ["明确发送"] },
];
const plan = "原方案：保留 Markdown `code`。\n\n不应覆盖本段。";
const enter = "\r";
const down = "\x1b[B";
const escape = "\x1b";

function press(...keys) {
	return (component) => {
		for (const key of keys) component.handleInput(key);
	};
}

async function grill(dialogs, options = {}) {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-grill-completion-"));
	const originalNow = Date.now;
	try {
		const loaded = await loadExtensions([path.join(root, "extensions/grill-me-agent.ts")], cwd);
		assert.deepEqual(loaded.errors, []);
		const messages = [];
		const notifications = [];
		const archiveDir = path.join(cwd, ".pi-dev-output", "pi-grill", "answers");
		const archives = () => existsSync(archiveDir) && readdirSync(archiveDir).map((name) => ({
			path: path.join(archiveDir, name),
			content: readFileSync(path.join(archiveDir, name), "utf8"),
		}));
		let generationCount = 0;
		let executionCount = 0;
		loaded.runtime.sendUserMessage = (content, delivery) => {
			const outputPath = content.match(/Write to this exact path: (.+)/)?.[1];
			if (outputPath) {
				generationCount++;
				if (options.retry && generationCount === 1) {
					let calls = 0;
					const now = originalNow();
					Date.now = () => {
						if (++calls === 1) return now;
						Date.now = originalNow;
						return now + 300_001;
					};
					return;
				}
				writeFileSync(outputPath, JSON.stringify({ questions }));
				if (options.saveFailure) writeFileSync(archiveDir, "blocks answers directory");
				return;
			}
			executionCount++;
			assert.equal(archives().length, 1, "archive must exist before sending");
			assert.equal(content, archives()[0].content);
			assert.deepEqual(delivery, { deliverAs: "followUp" });
			if (options.sendFailure) throw new Error("controlled send failure");
			messages.push(content);
		};
		let dialogCount = 0;
		const rendered = [];
		const ctx = {
			cwd, hasUI: true,
			ui: {
				notify(message, level) { notifications.push({ message, level }); },
				custom(factory) {
					assert.ok(dialogCount < dialogs.length, "unexpected dialog");
					const dialog = dialogs[dialogCount++];
					return new Promise((resolve, reject) => {
						const component = factory({ requestRender() {} }, theme, {}, resolve);
						const text = component.render(120).join("\n");
						rendered.push(text);
						if (text.includes("保存并发送")) {
							assert.equal(archives().length, 1, "archive must exist before completion menu");
							assert.ok(text.includes(path.basename(archives()[0].path)));
						}
						try { dialog(component); } catch (error) { reject(error); }
					});
				},
			},
		};
		await loaded.extensions[0].commands.get("grill").handler(options.emptyPlan ? "" : plan, ctx);
		assert.equal(dialogCount, dialogs.length);
		return { messages, notifications, rendered, generationCount, executionCount,
			archives: options.saveFailure ? [] : archives() || [] };
	} finally {
		Date.now = originalNow;
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("completion defaults to save-only and Escape preserves the same full archive", async () => {
	for (const completion of [press(enter), press(escape)]) {
		const outcome = await grill([press(enter), press(down, enter), press(enter), completion]);
		assert.equal(outcome.generationCount, 1);
		assert.equal(outcome.executionCount, 0);
		assert.equal(outcome.archives.length, 1);
		assert.ok(outcome.archives[0].content.startsWith(plan));
		assert.ok(outcome.archives[0].content.includes("回答: 完整方案"));
		assert.ok(outcome.archives[0].content.includes("回答: 明确发送"));
		assert.ok(outcome.notifications.some(({ message }) => message.includes(path.basename(outcome.archives[0].path))));
	}
});

test("explicit send sends the archived bytes exactly once, including edited and custom answers", async () => {
	const outcome = await grill([
		press(enter), press(enter), press(down, down, enter),
		press(down, enter), press(down, enter),
		press("自定义 `决定`", enter), press(down, enter),
	]);
	assert.equal(outcome.executionCount, 1);
	assert.equal(outcome.messages[0], outcome.archives[0].content);
	assert.ok(outcome.messages[0].includes("回答: 完整方案"));
	assert.ok(!outcome.messages[0].includes("旧答案"));
	assert.ok(outcome.messages[0].includes("回答: 自定义 `决定`"));
});

test("retry success uses the same questionnaire, archive and save/send choices", async () => {
	for (const completion of [press(enter), press(down, enter)]) {
		const outcome = await grill([press(enter), press(enter), press(enter), press(enter), completion], { retry: true });
		assert.equal(outcome.generationCount, 2);
		assert.equal(outcome.archives.length, 1);
		assert.ok(outcome.archives[0].content.includes("## 方案追问记录"));
		assert.ok(outcome.rendered.at(-1).includes("仅保存"));
		assert.ok(outcome.rendered.at(-1).includes("保存并发送"));
	}
});

test("declining, empty input and incomplete cancellation never save or send a completed plan", async () => {
	for (const dialogs of [[press(escape)], [press(down, enter)], [press(enter), press(enter), press(escape)]]) {
		const outcome = await grill(dialogs);
		assert.equal(outcome.executionCount, 0);
		assert.equal(outcome.archives.length, 0);
	}
	const empty = await grill([press(escape)], { emptyPlan: true });
	assert.equal(empty.generationCount, 0);
});

test("custom input Escape returns to the question and empty answers remain explicit", async () => {
	const outcome = await grill([
		press(enter), press(down, down, enter), press(escape),
		press(down, down, enter), press(enter), press(enter), press(enter),
	]);
	assert.ok(outcome.archives[0].content.includes("回答: (空)"));
	assert.equal(outcome.executionCount, 0);
});

test("archive failure reports the real error and never offers sending", async () => {
	const outcome = await grill([press(enter), press(enter), press(enter)], { saveFailure: true });
	assert.equal(outcome.executionCount, 0);
	assert.ok(outcome.notifications.some(({ message, level }) => level === "error" && message.includes("EEXIST")));
	assert.ok(!outcome.rendered.some((text) => text.includes("保存并发送")));
});

test("send failure reports the retained archive without a success claim or retry", async () => {
	const outcome = await grill([press(enter), press(enter), press(enter), press(down, enter)], { sendFailure: true });
	assert.equal(outcome.executionCount, 1);
	assert.equal(outcome.archives.length, 1);
	assert.ok(outcome.notifications.some(({ message, level }) => level === "error"
		&& message.includes("controlled send failure") && message.includes("归档已保留")));
	assert.ok(!outcome.notifications.some(({ message }) => message.includes("已请求向当前代理")));
});
