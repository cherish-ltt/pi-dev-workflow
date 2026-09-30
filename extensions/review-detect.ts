/**
 * Review Detection Extension
 *
 * 拦截带审查意图的输入，交给 review-html skill 在当前代理中执行：
 *   - 直接输入 `/skill:review-html` → 立即审查
 *   - 输入同时命中「审查意图」与「代码对象」关键词 → 弹选单让用户确认
 *
 * 审查报告由 review-html skill 写入 .pi-dev-output/pi-review/html/，
 * 这里以报告文件出现作为完成标志（不使用 waitForIdle：它可能在 followUp
 * 触发的新 turn 开始前就返回，导致误报完成）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uiSelect } from "./ui-helpers";

/** Find the newest HTML review file generated after `afterMs`（忽略先前遗留的旧报告）。 */
function findNewestReviewHtml(cwd: string, afterMs: number): string {
	const candidates = [
		path.join(cwd, ".pi-dev-output", "pi-review", "html"),
		path.join(cwd, "pi-review"),
		path.join(cwd, ".pi-dev-output", "pi-review"),
	];

	for (const reviewDir of candidates) {
		try {
			if (fs.existsSync(reviewDir)) {
				const files = fs.readdirSync(reviewDir)
					.filter(f => f.endsWith(".html"))
					.map(f => ({
						name: f,
						mtime: fs.statSync(path.join(reviewDir, f)).mtimeMs,
					}))
					.filter(f => f.mtime > afterMs)
					.sort((a, b) => b.mtime - a.mtime);
				if (files.length > 0) {
					const rel = path.relative(cwd, reviewDir);
					return rel + "/" + files[0].name;
				}
			}
		} catch {
			// ignore fs errors
		}
	}

	return "";
}

/** Run a code review in the current agent and report the result. */
async function runReview(task: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<string | undefined> {
	const startTime = Date.now();
	ctx.ui.notify("🤖 正在运行代码审查，请稍候...", "info");

	pi.sendUserMessage(`/skill:review-html\n\n${task}`, {
		deliverAs: "followUp",
		expandPromptTemplates: true,
	});

	// 以“报告文件生成为完成标志”进行轮询；不使用 waitForIdle，
	// 避免其在 sendUserMessage 触发的新 turn 开始前立即返回，导致误报“已完成”。
	const deadline = Date.now() + 10 * 60_000;
	let filePath = "";
	while (Date.now() < deadline) {
		filePath = findNewestReviewHtml(ctx.cwd, startTime);
		if (filePath) break;
		await new Promise((r) => setTimeout(r, 2_000));
	}

	const dur = ((Date.now() - startTime) / 1000).toFixed(1);
	if (filePath) {
		ctx.ui.notify(`📄 审查报告已生成: ${filePath} (${dur}s)`, "info");
	} else {
		ctx.ui.notify(`⚠️ 审查未生成报告 (${dur}s)，请查看当前代理的回复或稍后重试`, "warning");
	}
	return filePath;
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		if (!ctx.hasUI) return { action: "continue" };
		// 扩展注入的消息（sendUserMessage，source 为 "extension"）不重入本处理器，避免无限递归
		if (event.source === "extension") return { action: "continue" };

		const text = event.text.trim().toLowerCase();

		// Detect review-html skill invocation or explicit review request.
		const isReviewSkill = text.startsWith("/skill:review-html");
		const hasReviewIntent = text.includes("review") ||
			text.includes("审查") || text.includes("审阅") || text.includes("review-html");
		const hasCodeTarget = text.includes("code") || text.includes("代码") ||
			text.includes("diff") || text.includes("commit") ||
			text.includes("html") || text.includes("report") || text.includes("报告") ||
			text.includes("本次改动") || text.includes("这次改动");
		const isReviewRequest = !isReviewSkill && hasReviewIntent && hasCodeTarget;

		if (!isReviewSkill && !isReviewRequest) return { action: "continue" };

		// ── Skill invocation: run review directly ─────────────────
		if (isReviewSkill) {
			await runReview(event.text, ctx, pi);
			return { action: "handled" };
		}

		// ── Review intent: let the user choose ────────────────────
		const mode = await uiSelect(
			ctx,
			"🔍 检测到审查意图",
			[
				"1. 开始审查（阻塞，等待结果）",
				"2. 不是审查（放行给主代理）",
			],
		);

		if (!mode || mode.startsWith("2")) {
			return { action: "continue" };
		}

		await runReview(event.text, ctx, pi);

		return { action: "handled" };
	});
}
