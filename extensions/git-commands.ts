/**
 * Git Commands Extension
 *
 * Registers three commands that delegate to git-sub-agent:
 *   /git-commit [message]       - Stage all changes and commit
 *   /git-push                   - Push commits to remote
 *   /git-commit-push [message]  - Stage, commit, and push in one go
 *
 * Associated extension: sub-agents.ts (provides spawnSubagent infrastructure)
 *
 * Place in .pi/extensions/ or ~/.pi/agent/extensions/ for auto-discovery.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, spawnSubagent, extractFinalOutput, type AgentDef } from "./sub-agents";

// ── Helpers ──────────────────────────────────────────────────

function getAgent(ctx: { ui: { notify: (msg: string, type: string) => void } }, agent: AgentDef | undefined, name: string): AgentDef | null {
	if (!agent) {
		ctx.ui.notify(`❌ ${name} not found (check agents/${name}.md)`, "error");
		return null;
	}
	return agent;
}

async function runSubAgent(
	agent: AgentDef,
	task: string,
	ctx: { cwd: string; signal?: AbortSignal; ui: { setStatus: (key: string, status: string | undefined) => void; notify: (msg: string, type: string) => void } },
): Promise<void> {
	ctx.ui.setStatus("subagent", "🤖 git-sub-agent working...");

	try {
		const result = await spawnSubagent(agent, task, ctx.cwd, ctx.signal);
		const output = extractFinalOutput(result.output);

		if (output) {
			ctx.ui.notify(`✅ git-sub-agent done\n${output}`, "success");
		} else if (result.exitCode !== 0) {
			ctx.ui.notify(`❌ git-sub-agent failed:\n${result.stderr}`, "error");
		} else {
			ctx.ui.notify("✅ git-sub-agent completed (no output)", "success");
		}
	} finally {
		ctx.ui.setStatus("subagent", undefined);
	}
}

// ── Extension ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const agents = discoverAgents();
	const gitAgent = agents.find((a) => a.name === "git-agent");

	// ── /git-commit ────────────────────────────────────────────
	pi.registerCommand("git-commit", {
		description: "(sub-agent) Stage all changes and create a commit via git-sub-agent",
		handler: async (args, ctx) => {
			const agent = getAgent(ctx, gitAgent, "git-agent");
			if (!agent) return;

			let message = args.trim();
			if (!message) {
				const input = await ctx.ui.input("Commit message", {
					placeholder: "直接回车让 AI 自动生成，或输入信息后提交...",
					required: false,
				});
				if (input === undefined) {
					ctx.ui.notify("Commit cancelled", "warning");
					return;
				}
				message = input.trim();
			}

			ctx.ui.notify("🤖 正在委派 git-sub-agent 处理...", "info");

			const task = message
				? `Stage all changes with git add -A, then commit with message: "${message}". Do NOT ask for confirmation.`
				: `Stage all changes with git add -A, check the diff, write a Conventional Commits message, and commit. Do NOT ask for confirmation.`;

			await runSubAgent(agent, task, ctx);
		},
	});

	// ── /git-push ─────────────────────────────────────────────
	pi.registerCommand("git-push", {
		description: "(sub-agent) Push commits to remote via git-sub-agent",
		handler: async (_args, ctx) => {
			const agent = getAgent(ctx, gitAgent, "git-agent");
			if (!agent) return;

			ctx.ui.notify("🤖 正在委派 git-sub-agent 处理...", "info");
			await runSubAgent(agent, "Push commits to remote with git push. Do NOT ask for confirmation.", ctx);
		},
	});

	// ── /git-commit-push ──────────────────────────────────────
	pi.registerCommand("git-commit-push", {
		description: "(sub-agent) Stage, commit, and push via git-sub-agent",
		handler: async (args, ctx) => {
			const agent = getAgent(ctx, gitAgent, "git-agent");
			if (!agent) return;

			let message = args.trim();
			if (!message) {
				const input = await ctx.ui.input("Commit message", {
					placeholder: "直接回车让 AI 自动生成，或输入信息后提交并推送...",
					required: false,
				});
				if (input === undefined) {
					ctx.ui.notify("Commit & push cancelled", "warning");
					return;
				}
				message = input.trim();
			}

			ctx.ui.notify("🤖 正在委派 git-sub-agent 处理...", "info");

			const task = message
				? `Stage all changes with git add -A, commit with message: "${message}", then push. Do NOT ask for confirmation.`
				: `Stage all changes with git add -A, check the diff, write a Conventional Commits message, commit, then push. Do NOT ask for confirmation.`;

			await runSubAgent(agent, task, ctx);
		},
	});
}
