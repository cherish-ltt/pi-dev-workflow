import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mock, test } from "node:test";

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
	{ id: 1, question: "第一项决定？", options: ["原始选择", "修改选择"] },
	{ id: 2, question: "第二项决定？", options: ["等待确认"] },
	{ id: 3, question: "第三项决定？", options: ["归档再选择"] },
];
const plan = "原始方案 `code`\n\n必须保留原文。";
const enter = "\r";
const down = "\x1b[B";
const escape = "\x1b";
const press = (...keys) => (component) => keys.forEach((key) => component.handleInput(key));
const pause = press(down, down, down, enter);
const back = press(down, down, enter);

async function project(run) {
	const cwd = fs.mkdtempSync(path.join(tmpdir(), "pi-grill-resume-"));
	const draftPath = path.join(cwd, ".pi-dev-output/pi-grill/draft.json");
	const archiveDir = path.join(cwd, ".pi-dev-output/pi-grill/answers");
	const draft = () => fs.existsSync(draftPath) ? fs.readFileSync(draftPath, "utf8") : undefined;
	const save = (value) => {
		fs.mkdirSync(path.dirname(draftPath), { recursive: true });
		fs.writeFileSync(draftPath, typeof value === "string" ? value : JSON.stringify(value));
	};
	const savedDraft = () => ({
		version: 1, projectPath: fs.realpathSync(cwd), savedAt: "2026-11-06T00:00:00.000Z", plan,
		questions: structuredClone(questions), pairs: [{ question: questions[0].question, answer: "原始选择" }], currentIndex: 1,
	});
	const archives = () => fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).map((name) => ({
		path: path.join(archiveDir, name), content: fs.readFileSync(path.join(archiveDir, name), "utf8"),
	})) : [];
	async function command(name, dialogs, options = {}) {
		const loaded = await loadExtensions([path.join(root, "extensions/grill-me-agent.ts")], cwd);
		assert.deepEqual(loaded.errors, []);
		const messages = [], notifications = [], rendered = [];
		let generationCount = 0;
		const originalNow = Date.now;
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
				fs.writeFileSync(outputPath, JSON.stringify({ questions: options.questions ?? questions }));
			} else {
				assert.equal(content, archives().at(-1).content, "only archived content may be sent");
				assert.deepEqual(delivery, { deliverAs: "followUp" });
				messages.push(content);
			}
		};
		let dialogIndex = 0;
		const ctx = {
			cwd, hasUI: options.hasUI ?? true,
			ui: {
				notify(message, level) { notifications.push({ message, level }); },
				custom(factory) {
					assert.ok(dialogIndex < dialogs.length, "unexpected dialog");
					const dialog = dialogs[dialogIndex++];
					return new Promise((resolve, reject) => {
						const component = factory({ requestRender() {} }, theme, {}, resolve);
						const text = component.render(120).join("\n");
						rendered.push(text);
						if (text.includes("保存并发送")) assert.ok(archives().length, "archive before completion menu");
						try { dialog(component, text); } catch (error) { reject(error); }
					});
				},
			},
		};
		try {
			await loaded.extensions[0].commands.get(name).handler(name === "grill" ? plan : "", ctx);
			assert.equal(dialogIndex, dialogs.length);
			return { generationCount, messages, notifications, rendered };
		} finally {
			Date.now = originalNow;
		}
	}
	try {
		await run({ cwd, draftPath, archiveDir, draft, save, savedDraft, archives, command });
	} finally {
		fs.chmodSync(cwd, 0o700);
		const draftDir = path.dirname(draftPath);
		if (fs.existsSync(draftDir)) fs.chmodSync(draftDir, 0o700);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

test("pause and fresh loader resume preserve original questions, custom answers and actual backtracked position", async () => {
	await project(async ({ draft, command, archives }) => {
		const paused = await command("grill", [
			press(enter), press(down, down, enter), press("custom `answer`", enter),
			press(down, enter), press(enter), back, back, pause,
		]);
		assert.equal(paused.generationCount, 1);
		assert.deepEqual(paused.messages, []);
		assert.deepEqual(archives(), []);
		const saved = JSON.parse(draft());
		assert.equal(saved.plan, plan);
		assert.deepEqual(saved.questions, questions);
		assert.equal(saved.currentIndex, 0);
		assert.deepEqual(saved.pairs, [
			{ question: questions[0].question, answer: "custom `answer`" },
			{ question: questions[1].question, answer: "(空)" },
		]);
		const resumed = await command("grill-resume", [
			(component, text) => {
				assert.ok(text.includes("原始方案"));
				assert.ok(text.includes(saved.savedAt));
				assert.ok(text.includes("当前第 1/3 题；已答 2/3 题"));
				press(enter)(component);
			},
			(component, text) => {
				assert.ok(text.includes("自定义输入 - 上次选择"));
				press(down, enter)(component);
			},
			press(down, enter), press(enter), press(enter), press(escape),
		]);
		assert.equal(resumed.generationCount, 0);
		assert.deepEqual(resumed.messages, []);
		assert.equal(draft(), undefined);
		assert.ok(archives()[0].content.startsWith(plan));
		assert.ok(archives()[0].content.includes("回答: 修改选择"));
		assert.ok(archives()[0].content.includes("回答: (空)"));
		assert.ok(!archives()[0].content.includes("custom `answer`"));
	});
});

test("initial question and retry questionnaire both allow pause without completed answers", async () => {
	for (const retry of [false, true]) {
		await project(async ({ draft, command }) => {
			const outcome = await command("grill", [press(enter), ...(retry ? [press(enter)] : []), pause], { retry });
			assert.equal(outcome.generationCount, retry ? 2 : 1);
			assert.deepEqual(JSON.parse(draft()).pairs, []);
			assert.equal(JSON.parse(draft()).currentIndex, 0);
			assert.deepEqual(outcome.messages, []);
		});
	}
});

test("valid duplicate question ids preserve distinct questions and answers across pause and resume", async () => {
	await project(async ({ draft, command, archives }) => {
		const duplicateQuestions = questions.map((question) => ({ ...question, id: 1 }));
		await command("grill", [press(enter), press(enter), pause], { questions: duplicateQuestions });
		const saved = JSON.parse(draft());
		assert.deepEqual(saved.questions, duplicateQuestions);
		assert.equal(saved.currentIndex, 1);
		assert.deepEqual(saved.pairs, [{ question: questions[0].question, answer: questions[0].options[0] }]);
		const resumed = await command("grill-resume", [press(enter), press(enter), press(enter), press(enter)]);
		assert.equal(resumed.generationCount, 0);
		assert.deepEqual(resumed.messages, []);
		assert.equal(draft(), undefined);
		for (const question of duplicateQuestions) {
			assert.ok(archives()[0].content.includes(`问题: ${question.question}\n回答: ${question.options[0]}`));
		}
	});
});

test("resume refusal and later cancellation keep the exact previously saved version", async () => {
	await project(async ({ save, savedDraft, draft, command }) => {
		save(savedDraft());
		const original = draft();
		await command("grill-resume", [press(escape)]);
		assert.equal(draft(), original);
		const cancelled = await command("grill-resume", [press(enter), press(enter), press(escape)]);
		assert.equal(draft(), original);
		assert.equal(cancelled.generationCount, 0);
		assert.ok(cancelled.notifications.some(({ message }) => message.includes("本轮新增进度未保存")));
		assert.deepEqual(cancelled.messages, []);
	});
});

test("existing draft must be explicitly replaced, while custom-input Escape still returns to the same question", async () => {
	await project(async ({ save, savedDraft, draft, command }) => {
		save(savedDraft());
		const original = draft();
		await command("grill", [press(enter), pause, press(enter),
			press(down, down, enter), press(escape), pause, press(escape), press(escape)]);
		assert.equal(draft(), original);
		await command("grill", [press(enter), pause, press(down, enter)]);
		assert.notEqual(draft(), original);
		assert.equal(JSON.parse(draft()).currentIndex, 0);
		assert.deepEqual(JSON.parse(draft()).pairs, []);
	});
});

test("write failure after a replacement choice preserves old bytes and stays on the same question", async () => {
	await project(async ({ save, savedDraft, draft, command, draftPath }) => {
		save(savedDraft());
		const original = draft();
		const directory = path.dirname(draftPath);
		const outcome = await command("grill", [press(enter), press(enter), pause,
			(component) => { fs.chmodSync(directory, 0o500); press(down, enter)(component); },
			(component, text) => {
				fs.chmodSync(directory, 0o700);
				assert.equal(draft(), original);
				assert.ok(text.includes("问题 2/3"));
				press(escape)(component);
			},
		]);
		assert.equal(draft(), original);
		assert.ok(outcome.notifications.some(({ message, level }) => level === "error"
			&& message.includes("EACCES") && message.includes("仍停留当前题")));
		assert.deepEqual(fs.readdirSync(directory), ["draft.json", "questions"]);
	});
});

test("atomic rename failure preserves the old draft and cleans the temporary file", async () => {
	await project(async ({ draftPath, draft, command, save, savedDraft }) => {
		save(savedDraft());
		const original = draft();
		const rename = mock.method(fs.default, "renameSync", () => {
			throw new Error("controlled rename failure");
		});
		syncBuiltinESMExports();
		try {
			const outcome = await command("grill-resume", [press(enter), pause,
				(component, text) => {
					assert.ok(text.includes("问题 2/3"));
					assert.equal(draft(), original);
					assert.equal(fs.readdirSync(path.dirname(draftPath)).filter((name) => name.endsWith(".tmp")).length, 0);
					press(escape)(component);
				},
			]);
			assert.ok(outcome.notifications.some(({ message, level }) => level === "error" && message.includes("controlled rename failure")));
			assert.equal(rename.mock.callCount(), 1);
		} finally {
			rename.mock.restore();
			syncBuiltinESMExports();
		}
	});
});

test("resuming and pausing again saves edited progress without treating its own draft as a conflict", async () => {
	await project(async ({ draft, command, save, savedDraft }) => {
		save(savedDraft());
		const original = draft();
		const outcome = await command("grill-resume", [press(enter), press(down, enter),
			press("submitted custom answer", enter), pause]);
		assert.notEqual(draft(), original);
		assert.equal(JSON.parse(draft()).currentIndex, 2);
		assert.equal(JSON.parse(draft()).pairs[1].answer, "submitted custom answer");
		assert.equal(outcome.generationCount, 0);
		assert.deepEqual(outcome.messages, []);
	});
});

test("resume explicitly rejects damaged, unsupported, foreign and inconsistent drafts without modification or generation", async () => {
	await project(async ({ save, savedDraft, draft, command }) => {
		const cases = [
			"broken JSON", "null", [], { ...savedDraft(), version: 2 },
			{ ...savedDraft(), projectPath: "/another/project" },
			{ ...savedDraft(), extra: true }, { ...savedDraft(), savedAt: "not a date" },
			{ ...savedDraft(), currentIndex: -1 }, { ...savedDraft(), currentIndex: 1.5 },
			{ ...savedDraft(), currentIndex: 2 }, { ...savedDraft(), questions: [] },
			{ ...savedDraft(), pairs: [{ question: "another question", answer: "answer" }] },
			{ ...savedDraft(), pairs: [{ question: questions[0].question, answer: "" }] },
			{ ...savedDraft(), questions: [{ ...questions[0], options: [42] }, ...questions.slice(1)] },
			{ ...savedDraft(), questions: [{ ...questions[0], id: "1" }, ...questions.slice(1)] },
		];
		for (const value of cases) {
			save(value);
			const original = draft();
			const outcome = await command("grill-resume", []);
			assert.equal(draft(), original);
			assert.equal(outcome.generationCount, 0);
			assert.deepEqual(outcome.messages, []);
			assert.ok(outcome.notifications.some(({ message, level }) => level === "error" && message.includes("无法恢复草稿")));
		}
	});
});

test("an all-answered draft still requires a fresh completion choice before sending", async () => {
	for (const [completion, sends] of [[press(enter), 0], [press(escape), 0], [press(down, enter), 1]]) {
		await project(async ({ save, savedDraft, draft, command, archives }) => {
			save({ ...savedDraft(), currentIndex: questions.length,
				pairs: questions.map((question) => ({ question: question.question, answer: question.options[0] })) });
			const outcome = await command("grill-resume", [press(enter), completion]);
			assert.equal(outcome.generationCount, 0);
			assert.equal(outcome.messages.length, sends);
			assert.equal(draft(), undefined);
			assert.equal(archives().length, 1);
		});
	}
});

test("archive failure keeps the resumable draft; unrelated or subsequently changed drafts survive other completions", async () => {
	await project(async ({ save, savedDraft, draft, command, archiveDir }) => {
		save(savedDraft());
		const original = draft();
		fs.writeFileSync(archiveDir, "blocks archive directory");
		const outcome = await command("grill-resume", [press(enter), press(enter), press(enter)]);
		assert.equal(draft(), original);
		assert.equal(outcome.generationCount, 0);
		assert.ok(outcome.notifications.some(({ message, level }) => level === "error" && message.includes("EEXIST")));
		assert.deepEqual(outcome.messages, []);
	});
	await project(async ({ save, savedDraft, draft, command }) => {
		save(savedDraft());
		const original = draft();
		await command("grill", [press(enter), press(enter), press(enter), press(enter), press(enter)]);
		assert.equal(draft(), original);
		const replacement = { ...savedDraft(), plan: "independent replacement" };
		const outcome = await command("grill-resume", [press(enter), press(enter),
			(component) => { save(replacement); press(enter)(component); }, press(enter)]);
		assert.deepEqual(JSON.parse(draft()), replacement);
		assert.ok(outcome.notifications.some(({ message }) => message.includes("草稿已变化")));
	});
});

test("draft cleanup failure is explicit while the completed archive and old draft are retained", async () => {
	await project(async ({ save, savedDraft, draft, draftPath, archiveDir, archives, command }) => {
		save(savedDraft());
		const original = draft();
		fs.mkdirSync(archiveDir);
		const directory = path.dirname(draftPath);
		const outcome = await command("grill-resume", [press(enter), press(enter),
			(component) => { fs.chmodSync(directory, 0o500); press(enter)(component); },
			(component) => { fs.chmodSync(directory, 0o700); press(escape)(component); },
		]);
		assert.equal(draft(), original);
		assert.equal(archives().length, 1);
		assert.deepEqual(outcome.messages, []);
		assert.ok(outcome.notifications.some(({ message, level }) => level === "error"
			&& message.includes("草稿清理失败") && message.includes("EACCES")));
	});
});

test("missing draft and non-interactive resume exit with a clear message", async () => {
	await project(async ({ command }) => {
		const missing = await command("grill-resume", []);
		assert.ok(missing.notifications.some(({ message }) => message.includes("没有已保存")));
		const noUI = await command("grill-resume", [], { hasUI: false });
		assert.ok(noUI.notifications.some(({ message, level }) => level === "error" && message.includes("需要交互式界面")));
	});
});
