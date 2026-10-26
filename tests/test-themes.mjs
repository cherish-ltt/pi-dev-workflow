import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

let entry;
try {
	entry = import.meta.resolve("@earendil-works/pi-coding-agent");
} catch (error) {
	if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
	const globalModules = process.env.PI_GLOBAL_MODULES
		?? execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	entry = pathToFileURL(path.join(globalModules, "@earendil-works/pi-coding-agent/dist/index.js")).href;
}
const { loadThemeFromPath, setThemeJsonValidator } = await import(new URL("./modes/interactive/theme/theme.js", entry));
const { validateThemeJson } = await import(new URL("./modes/interactive/theme/theme-schema.js", entry));
setThemeJsonValidator(validateThemeJson);

const themesDir = fileURLToPath(new URL("../themes/", import.meta.url));
for (const file of readdirSync(themesDir).filter((file) => file.endsWith(".json"))) {
	test(`${file} loads through official Pi's strict theme validator`, () => {
		const themePath = path.join(themesDir, file);
		const json = JSON.parse(readFileSync(themePath, "utf8"));
		const theme = loadThemeFromPath(themePath, "truecolor");
		assert.equal(theme.name, json.name);
		assert.equal(theme.sourcePath, themePath);
	});
}

test("titanium uses the official schema and preserves its identity and palette", () => {
	const themePath = path.join(themesDir, "oh-my-pi-titanium.json");
	const json = JSON.parse(readFileSync(themePath, "utf8"));
	assert.equal(json.$schema, "https://pi.dev/schemas/theme.schema.json");
	const theme = loadThemeFromPath(themePath, "truecolor");
	assert.equal(theme.name, "titanium");
	assert.equal(theme.appearance, "dark");
	assert.equal(theme.fg("accent", "accent"), "\x1b[38;2;0;180;255maccent\x1b[39m");
	assert.equal(theme.bg("userMessageBg", "background"), "\x1b[48;2;15;18;22mbackground\x1b[49m");
	assert.equal(theme.fg("syntaxString", "string"), "\x1b[38;2;212;192;144mstring\x1b[39m");
	assert.equal(json.vars[json.export.pageBg], "#151820");
	assert.equal(json.vars[json.export.cardBg], "#0f1216");
	assert.equal(json.vars[json.export.infoBg], "#2a3038");
});
