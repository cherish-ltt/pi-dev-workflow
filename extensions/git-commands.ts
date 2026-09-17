/**
 * Git Commands Extension
 *
 * Registers three commands that run git directly through pi's built-in executor:
 *   /git-commit [message]       - Stage all changes and commit
 *   /git-push                   - Push commits to remote
 *   /git-commit-push [message]  - Stage, commit, and push in one go
 *
 * No sub-process is spawned, so results appear in the current session context.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { uiInput } from "./ui-helpers";
import { getLastAssistantTextAfter, waitForIdleWithTimeout } from "./session-utils";

const COMMIT_PREFIX_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?[!]?: /;

// ── Helpers ──────────────────────────────────────────────────

/** Ask the current agent to generate a Conventional Commits message from the diff. */
async function generateCommitMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string> {
	let diffSummary = "";
	try {
		const diffResult = await pi.exec("git", ["diff", "--stat"], { cwd: ctx.cwd, timeout: 30_000, timeoutKill: 5_000 });
		diffSummary = diffResult.stdout?.trim() || diffResult.stderr?.trim() || "";
	} catch {
		// No repo, no changes, or executor unavailable
	}

	if (!diffSummary) {
		return "chore: 自动提交变更";
	}

	const task = [
		"请根据以下 git diff 摘要，生成一条 Conventional Commits 格式的中文提交消息。",
		"只输出一行消息，不要加任何解释、引号或前缀。",
		"",
		diffSummary,
	].join("\n");

	const sentAt = Date.now();
	pi.sendUserMessage(task, { deliverAs: "followUp" });
	try {
		await waitForIdleWithTimeout(ctx, 60_000);
	} catch {
		// Agent may have failed; fall back to a generic message
	}

	const firstLine = getLastAssistantTextAfter(ctx, sentAt).trim().split("\n")[0].slice(0, 120);
	if (!COMMIT_PREFIX_RE.test(firstLine)) {
		return "chore: 自动提交变更";
	}
	return firstLine;
}

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
		const result = await pi.exec("git", args, { cwd: ctx.cwd, timeout: 120_000, timeoutKill: 10_000 });
		if (result.exitCode !== 0) {
			const detail = result.stderr?.trim() || result.stdout?.trim() || "未知错误";
			ctx.ui.notify(`❌ ${action} 失败 (exit ${result.exitCode}): ${detail}`, "error");
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
		description: "Stage all changes and create a commit (leave message empty for an AI-generated Conventional Commits message)",
		handler: async (args, ctx) => {
			let message = args.trim();
			if (!message) {
				const input = await uiInput(ctx, "Commit message", "直接回车让 AI 自动生成，或输入信息后提交...");
				if (input === undefined) return;
				message = input.trim();
			}

			const addOk = await runGitCommand(pi, ctx, ["add", "-A"], "暂存所有变更");
			if (!addOk) return;

			const commitMessage = message ? message : await generateCommitMessage(pi, ctx);
			await runGitCommand(pi, ctx, ["commit", "-m", commitMessage], `提交 (${commitMessage})`);
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
		description: "Stage, commit, and push in one go (leave message empty for an AI-generated Conventional Commits message)",
		handler: async (args, ctx) => {
			let message = args.trim();
			if (!message) {
				const input = await uiInput(ctx, "Commit message", "直接回车让 AI 自动生成，或输入信息后提交并推送...");
				if (input === undefined) return;
				message = input.trim();
			}

			const addOk = await runGitCommand(pi, ctx, ["add", "-A"], "暂存所有变更");
			if (!addOk) return;

			const commitMessage = message ? message : await generateCommitMessage(pi, ctx);
			const commitOk = await runGitCommand(pi, ctx, ["commit", "-m", commitMessage], `提交 (${commitMessage})`);
			if (!commitOk) return;

			await runGitCommand(pi, ctx, ["push"], "推送到远程");
		},
	});
}
