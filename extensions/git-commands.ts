/**
 * Git Commands Extension
 *
 * Registers three commands:
 *   /git-commit [message]       - Commit changes
 *   /git-push                   - Push commits to remote
 *   /git-commit-push [message]  - Commit and push in one go
 *
 * 传入消息时快速执行：暂存全部 → 提交/推送。
 * 不传消息时把任务交给当前代理：由其查看 diff、识别变更并按
 * Conventional Commits 规范分批提交（提交信息用中文）。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { uiInput } from "./ui-helpers";

// ── 委托给当前代理的任务描述 ─────────────────────────────────

const COMMIT_BATCH_TASK = [
	"请帮我完成这次 git 提交：",
	"1. 执行 git status 与 git diff 查看当前变更，识别变更内容，必要时先用 git add 暂存相关文件。",
	"2. 按 Conventional Commits 规范分批提交：把逻辑相关的改动拆成独立 commit，避免无关改动混入同一 commit；提交信息描述使用中文。",
	"3. 直接执行提交，不需要向我确认。",
	"4. 严谨修改任何代码，只做 git commit 工作。",
	"5. 你的任务：识别 diff -> 分批提交;请迅速完成，不要进行额外的无关任务思考。"
].join("\n");

const COMMIT_PUSH_TASK = COMMIT_BATCH_TASK + "\n6. 全部提交完成后执行 git push 推送。";

// ── Helpers ──────────────────────────────────────────────────

/** Run a git command through pi's executor and report the outcome. */
async function runGitCommand(
	pi: ExtensionAPI,
	ctx: {
		cwd: string;
		ui: { notify: (msg: string, type: string) => void };
	},
	args: string[],
	action: string,
): Promise<boolean> {
	try {
		const result = await pi.exec("git", args, { cwd: ctx.cwd, timeout: 120_000 });
		if (result.code !== 0) {
			const detail = result.stderr?.trim() || result.stdout?.trim() || "未知错误";
			ctx.ui.notify(`❌ ${action} 失败 (exit ${result.code}): ${detail}`, "error");
			return false;
		}
		ctx.ui.notify(`✅ ${action} 完成`, "success");
		return true;
	} catch (err) {
		ctx.ui.notify(`❌ ${action} 异常: ${err instanceof Error ? err.message : String(err)}`, "error");
		return false;
	}
}

// ── Extension ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── /git-commit ────────────────────────────────────────────
	pi.registerCommand("git-commit", {
		description: "Commit changes (leave message empty to let the agent review the diff and commit in batches)",
		handler: async (args, ctx) => {
			let message = args.trim();
			if (!message) {
				const input = await uiInput(ctx, "Commit message", "直接回车将交由主代理识别变更并分批提交，或输入消息直接提交...");
				if (input === undefined) return;
				message = input.trim();
			}

			if (message) {
				const addOk = await runGitCommand(pi, ctx, ["add", "-A"], "暂存所有变更");
				if (!addOk) return;
				await runGitCommand(pi, ctx, ["commit", "-m", message], `提交 (${message})`);
				return;
			}

			ctx.ui.notify("🔄 已交由当前代理识别变更并分批提交...", "info");
			pi.sendUserMessage(COMMIT_BATCH_TASK, { deliverAs: "followUp" });
		},
	});

	// ── /git-push ─────────────────────────────────────────────
	pi.registerCommand("git-push", {
		description: "Push commits to the remote repository",
		handler: async (_args, ctx) => {
			await runGitCommand(pi, ctx, ["push"], "推送到远程");
		},
	});

	// ── /git-commit-push ──────────────────────────────────────
	pi.registerCommand("git-commit-push", {
		description: "Commit and push in one go (leave message empty to let the agent review the diff and commit in batches)",
		handler: async (args, ctx) => {
			let message = args.trim();
			if (!message) {
				const input = await uiInput(ctx, "Commit message", "直接回车将交由主代理识别变更、分批提交并推送，或输入消息直接提交并推送...");
				if (input === undefined) return;
				message = input.trim();
			}

			if (message) {
				const addOk = await runGitCommand(pi, ctx, ["add", "-A"], "暂存所有变更");
				if (!addOk) return;
				const commitOk = await runGitCommand(pi, ctx, ["commit", "-m", message], `提交 (${message})`);
				if (!commitOk) return;
				await runGitCommand(pi, ctx, ["push"], "推送到远程");
				return;
			}

			ctx.ui.notify("🔄 已交由当前代理识别变更、分批提交并推送...", "info");
			pi.sendUserMessage(COMMIT_PUSH_TASK, { deliverAs: "followUp" });
		},
	});
}