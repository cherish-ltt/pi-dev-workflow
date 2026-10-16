import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
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
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", entry));
const { createAgentSession, SessionManager, SettingsManager } = await import(entry);
const { initTheme, theme } = await import(new URL("./modes/interactive/theme/theme.js", entry));
const require = createRequire(entry);
const { visibleWidth, wrapTextWithAnsi } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
initTheme("dark", false);
const loaded = await loadExtensions([path.join(root, "extensions/dev-ask.ts")], root);
assert.deepEqual(loaded.errors, [], "dev_ask must load through Pi's extension loader");
const tool = loaded.extensions[0].tools.get("dev_ask").definition;
const clean = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const up = "\x1b[A";
const down = "\x1b[B";
const enter = "\r";
const escape = "\x1b";
const pageDown = "\x1b[6~";
const pageUp = "\x1b[5~";

async function ask(questions, dialogs, rows = 32) {
	let calls = 0;
	let renders = 0;
	const terminal = { rows, columns: 120 };
	const ctx = {
		hasUI: true,
		ui: {
			custom(factory) {
				const dialog = dialogs[calls++];
				assert.ok(dialog, "unexpected dialog");
				if (typeof dialog === "string") return Promise.resolve(dialog);
				return new Promise((resolve, reject) => {
					const component = factory({ terminal, requestRender() { renders++; } }, theme, {}, resolve);
					try {
						dialog(component, terminal);
					} catch (error) {
						reject(error);
					}
				});
			},
		},
	};
	const result = await tool.execute("test", { questions }, undefined, undefined, ctx);
	assert.equal(calls, dialogs.length);
	return { result, renders };
}

const question = {
	header: "展示方式",
	question: "如何展示当前选项的完整说明？",
	options: [
		{
			label: "方案甲",
			description: "甲的说明：" + "说明文字应自动换行，保留中文和 English 内容。".repeat(6) + "甲的说明终点",
			preview: "```text\n+-------+\n| input |\n+---+---+\n    |\n    v\n  output\n```",
		},
		{ label: "方案乙", description: "乙的独有说明", preview: "## 乙的预览\n\n**Markdown 内容**" },
	],
};

function render(component, width) {
	const lines = component.render(width);
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${clean(line)}`);
	return lines.map(clean).join("\n");
}

test("schema exposes an optional Markdown preview and retains single-choice question limits", () => {
	const questions = tool.parameters.properties.questions;
	const options = questions.items.properties.options;
	assert.equal(options.minItems, 2);
	assert.equal(options.maxItems, 4);
	assert.equal(questions.maxItems, undefined);
	assert.equal(options.items.properties.preview.type, "string");
	assert.ok(!options.items.required.includes("preview"));
	assert.equal(tool.defaultActive, true);
	assert.equal(tool.exposure, "model-only");
});

test("default sessions and reload declare dev_ask with general-purpose and grilling guidance", async () => {
	let extensions = await loadExtensions([path.join(root, "extensions/dev-ask.ts")], root);
	const resourceLoader = {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources() {},
		async reload() {
			extensions = await loadExtensions([path.join(root, "extensions/dev-ask.ts")], root);
			assert.deepEqual(extensions.errors, []);
		},
	};
	const { session } = await createAgentSession({
		cwd: root,
		resourceLoader,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory(),
	});
	try {
		assert.ok(session.getActiveToolNames().includes("dev_ask"));
		assert.ok(session.systemPrompt.includes("dev_ask"));
		assert.ok(session.systemPrompt.includes("grilling"));
		assert.ok(tool.description.includes("需求澄清"));
		assert.ok(tool.parameters.properties.questions.description.includes("前置"));
		await session.reload();
		assert.ok(session.getActiveToolNames().includes("dev_ask"));
		assert.ok(session.systemPrompt.includes("grilling"));
	} finally {
		session.dispose();
	}
});

test("pre-check acceptance, cancellation and errors never manage the active tool list", async () => {
	for (const decision of ["是 — 意图正确，开始执行", undefined, new Error("dialog failed")]) {
		const extensions = await loadExtensions([path.join(root, "extensions/pre-check.ts")], root);
		assert.deepEqual(extensions.errors, []);
		const command = extensions.extensions[0].commands.get("dev-pre-check");
		const messages = [];
		const entries = [];
		extensions.runtime.getActiveTools = () => assert.fail("pre-check must not inspect active tools");
		extensions.runtime.setActiveTools = () => assert.fail("pre-check must not change active tools");
		extensions.runtime.sendUserMessage = (content) => {
			messages.push(content);
			entries.push({ type: "message", timestamp: new Date(Date.now() + 1).toISOString(),
				message: { role: "assistant", content: [{ type: "text", text: "已复述的意图" }] } });
		};
		const ctx = {
			hasUI: true,
			isIdle: () => true,
			sessionManager: { getEntries: () => entries },
			ui: { notify() {}, custom: () => decision instanceof Error ? Promise.reject(decision) : Promise.resolve(decision) },
		};
		if (decision instanceof Error) {
			await assert.rejects(command.handler("测试任务", ctx), /dialog failed/);
		} else {
			await command.handler("测试任务", ctx);
			assert.equal(messages.length, decision ? 2 : 1);
			if (decision) assert.ok(messages[1].includes("已复述的意图"));
		}
	}
});

test("initial and navigated details only contain the highlighted option; ASCII alignment survives", async () => {
	const { result, renders } = await ask([question], [(component) => {
		const initial = render(component, 120);
		assert.ok(initial.includes("甲的说明终点"));
		assert.ok(initial.includes("| input |"));
		assert.ok(initial.includes("    |"));
		assert.ok(initial.includes("  output"));
		assert.ok(!initial.includes("乙的独有说明"));
		component.handleInput(down);
		const second = render(component, 120);
		assert.ok(second.includes("乙的独有说明"));
		assert.ok(second.includes("Markdown 内容"));
		assert.ok(!second.includes("甲的说明"));
		assert.ok(!second.includes("| input |"));
		component.handleInput(down);
		const custom = render(component, 120);
		assert.ok(custom.includes("输入自己的答案"));
		assert.ok(!custom.includes("乙的独有说明"));
		component.handleInput(up);
		component.handleInput(enter);
	}]);
	assert.equal(result.details.answers[0].answer, "方案乙");
	assert.equal(result.details.cancelled, false);
	assert.ok(renders > 0);
});

test("description-only questions switch details too", async () => {
	const plain = { ...question, options: question.options.map(({ label, description }) => ({ label, description })) };
	await ask([plain], [(component) => {
		assert.ok(!render(component, 100).includes("乙的独有说明"));
		component.handleInput(down);
		const text = render(component, 100);
		assert.ok(text.includes("乙的独有说明"));
		assert.ok(!text.includes("甲的说明"));
		component.handleInput(enter);
	}]);
});

test("narrow layout wraps without loss; resize and invalidation preserve selected details", async () => {
	await ask([question], [(component) => {
		for (const width of [10, 20, 40, 79, 80, 100, 160]) {
			const text = render(component, width);
			assert.ok(text.replace(/\s|[│╭╮╰╯─]/g, "").includes("甲的说明终点"), `description lost at ${width}`);
		}
		const narrow = render(component, 40);
		assert.ok(narrow.indexOf("自己输入") < narrow.indexOf("甲的说明"));
		component.handleInput(down);
		component.invalidate();
		assert.ok(render(component, 80).includes("乙的独有说明"));
		assert.ok(!render(component, 30).includes("甲的说明"));
		component.handleInput(enter);
	}], 240);
});

test("long details are fully reachable by paging and reset on option changes", async () => {
	const long = { ...question, options: [
		{ label: "长说明", description: Array.from({ length: 70 }, (_, i) => `第${i}行说明`).join("\n"), preview: "```text\n预览末尾\n```" },
		question.options[1],
	] };
	await ask([long], [(component, terminal) => {
		let text = render(component, 100);
		assert.ok(text.includes("第0行说明"));
		assert.ok(!text.includes("预览末尾"));
		assert.ok(text.includes("详情 1-"));
		for (let i = 0; i < 20; i++) {
			component.handleInput(pageDown);
			text = render(component, 100);
			assert.ok(text.split("\n").length <= terminal.rows);
		}
		assert.ok(text.includes("预览末尾"));
		component.handleInput(pageUp);
		assert.ok(!render(component, 100).includes("预览末尾"));
		component.handleInput(down);
		assert.ok(render(component, 100).includes("乙的独有说明"));
		component.handleInput(up);
		assert.ok(render(component, 100).includes("第0行说明"));
		component.handleInput(enter);
	}], 20);
});

test("narrow, short terminals can page through details without changing the answer", async () => {
	await ask([question], [(component, terminal) => {
		const seen = [];
		for (let i = 0; i < 30; i++) {
			const text = render(component, 40);
			assert.ok(text.split("\n").length <= terminal.rows);
			seen.push(text);
			component.handleInput(pageDown);
		}
		for (const line of wrapTextWithAnsi(question.options[0].description, 36)) {
			assert.ok(seen.some((page) => page.includes(line)), `description line not reachable: ${line}`);
		}
		assert.ok(seen.join("\n").includes("output"));
		component.handleInput(enter);
	}], 24);
});

test("moving from a preview option to a plain option leaves no stale preview", async () => {
	const mixed = { ...question, options: [question.options[0], { label: "无预览", description: "只展示普通说明" }] };
	await ask([mixed], [(component) => {
		assert.ok(render(component, 100).includes("| input |"));
		component.handleInput(down);
		const text = render(component, 100);
		assert.ok(text.includes("只展示普通说明"));
		assert.ok(!text.includes("| input |"));
		component.handleInput(enter);
	}]);
});

test("back navigation, custom answers and cancellation retain questionnaire semantics", async () => {
	const { result } = await ask([question, { ...question, header: "第二题" }], [
		(component) => { render(component, 100); component.handleInput(enter); },
		(component) => {
			const text = render(component, 100);
			assert.ok(text.includes("返回上一题并重新作答"));
			assert.ok(!text.includes("甲的说明"));
			component.handleInput(enter);
		},
		(component) => { component.handleInput(down); component.handleInput(enter); },
		(component) => { component.handleInput(up); component.handleInput(enter); },
		"  自定义答案  ",
	]);
	assert.deepEqual(result.details.answers.map(({ answer }) => answer), ["方案乙", "自定义答案"]);
	assert.equal(result.details.cancelled, false);
	const cancelled = await ask([question, question], [
		(component) => component.handleInput(enter),
		(component) => component.handleInput(escape),
	]);
	assert.equal(cancelled.result.details.cancelled, true);
	assert.deepEqual(cancelled.result.details.answers.map(({ answer }) => answer), ["方案甲", null]);
	assert.ok(cancelled.result.content[0].text.includes("不代表用户同意推荐项"));
});

test("non-interactive sessions still report that no question was shown", async () => {
	const result = await tool.execute("test", { questions: [question] }, undefined, undefined, { hasUI: false });
	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.answers, []);
	assert.ok(result.content[0].text.includes("没有交互界面"));
});
