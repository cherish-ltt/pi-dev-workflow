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
