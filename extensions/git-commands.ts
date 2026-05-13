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

function getAgent(
	ctx: { ui: { notify: (msg: string, type: string) => void } },
	agent: AgentDef | undefined,
	name: string,
): AgentDef | null {
	if (!agent) {
		ctx.ui.notify(`❌ ${name} not found (check agents/${name}.md)`, "error");
		return null;
	}
	return agent;
}

/** Parse git-agent structured output into a clean summary. */
interface GitSummary {
	status: "success" | "fail" | "unknown";
	summary: string;
	details: string[];
}

function parseGitOutput(output: string): GitSummary {
	const result: GitSummary = { status: "unknown", summary: "", details: [] };

	// Parse <status>...</status>
	const statusMatch = output.match(/<status>([^<]*)<\/status>/);
	if (statusMatch) {
		const s = statusMatch[1].trim();
		if (s.includes("✅") || s.includes("✔")) result.status = "success";
		else if (s.includes("❌") || s.includes("✖")) result.status = "fail";
	}

	// Parse <summary>...</summary>
	const summaryMatch = output.match(/<summary>([\s\S]*?)<\/summary>/);
	if (summaryMatch) result.summary = summaryMatch[1].trim();

	// Parse <details>...</details> → extract each line
	const detailsMatch = output.match(/<details>([\s\S]*?)<\/details>/);
	if (detailsMatch) {
		const lines = detailsMatch[1]
			.split("\n")
			.map((l) => l.replace(/^[-*]\s*/, "").trim())
			.filter(Boolean);
		result.details = lines;
	}

	// Fallback: if no structured format, use raw lines
	if (!statusMatch && !summaryMatch) {
		const lines = output.split("\n").filter((l) => l.trim());
		result.summary = lines[0] || "";
		result.details = lines.slice(1).map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
		// Infer status from content
		if (output.includes("✅") || output.includes("success") || output.includes("完成")) {
			result.status = "success";
		} else if (output.includes("❌") || output.includes("fail") || output.includes("失败")) {
			result.status = "fail";
		}
	}

	return result;
}

/** Enrich a detail line with relevant emoji icons. */
function iconify(line: string): string {
	const lc = line.toLowerCase();
	if (lc.startsWith("commit")) return `📝 ${line}`;
	if (lc.startsWith("push"))   return `📤 ${line}`;
	if (lc.includes("file") || lc.includes("文件")) return `📁 ${line}`;
	if (lc.startsWith("branch") || lc.includes("branch")) return `🌿 ${line}`;
	if (lc.startsWith("tag") || lc.includes("tag")) return `🏷️ ${line}`;
	return `  ${line}`; // indent others
}

async function runSubAgent(
	agent: AgentDef,
	task: string,
	ctx: {
		cwd: string;
		signal?: AbortSignal;
		ui: {
			setStatus: (key: string, status: string | undefined) => void;
			notify: (msg: string, type: string) => void;
		};
	},
): Promise<void> {
	const startTime = Date.now();
	ctx.ui.setStatus("subagent", "🤖 git-sub-agent working...");

	try {
		const result = await spawnSubagent(
			agent,
			task,
			ctx.cwd,
			ctx.signal,
			undefined, // use agent's default timeout
			(progress) => {
				ctx.ui.setStatus("subagent", progress.slice(0, 50));
			},
		);
		const dur = ((Date.now() - startTime) / 1000).toFixed(1);

		// Extract output with fallback to raw stdout
		let output = extractFinalOutput(result.output);
		if (!output && result.output.trim()) {
			const lines = result.output.split("\n").filter((l) => {
				const t = l.trim();
				return t && !t.startsWith("{") && !t.startsWith("[");
			});
			if (lines.length > 0) {
				output = lines.join("\n").trim();
			}
		}

		ctx.ui.setStatus("subagent", undefined);

		if (output) {
			const parsed = parseGitOutput(output);
			const statusIcon = parsed.status === "success" ? "✅" : parsed.status === "fail" ? "❌" : "ℹ️";
			const detailText = parsed.details.length > 0 ? ` | ${parsed.details.join(" | ")}` : "";
			const msg = `${statusIcon} ${parsed.summary || "done"} (${dur}s)${detailText}`;
			const notifyType = parsed.status === "fail" ? "error" : "success";
			ctx.ui.notify(msg, notifyType);
		} else if (result.exitCode !== 0) {
			const errMsg = result.stderr || result.output.slice(0, 300) || "未知错误";
			ctx.ui.notify(`❌ git-sub-agent 失败 (${dur}s): ${errMsg}`, "error");
		} else {
			ctx.ui.notify(`✅ git-sub-agent 完成 (${dur}s)`, "success");
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
			await runSubAgent(
				agent,
				"Push commits to remote with git push. Do NOT ask for confirmation.",
				ctx,
			);
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
