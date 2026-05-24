/**
 * APPEND_SYSTEM.md 注入扩展
 *
 * 在每次 agent 启动前，将 prompts/APPEND_SYSTEM.md 的内容追加到 system prompt 末尾。
 * 这样用户安装此包后，自动生效，无需手动配置 ~/.pi/agent/APPEND_SYSTEM.md。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// 缓存文件内容，避免每次读取磁盘
	let cachedContent: string | null = null;

	function getAppendContent(): string {
		if (cachedContent !== null) return cachedContent;
		try {
			const appendPath = join(__dirname, "..", "prompts", "APPEND_SYSTEM.md");
			cachedContent = readFileSync(appendPath, "utf-8");
		} catch {
			// 文件不存在时静默降级，不阻塞启动
			cachedContent = "";
		}
		return cachedContent;
	}

	pi.on("before_agent_start", async (event, _ctx) => {
		const content = getAppendContent();
		if (!content) return; // 无可追加内容

		return {
			systemPrompt: event.systemPrompt + "\n\n" + content,
		};
	});
}
