/**
 * Sub-Agents Extension
 *
 * Provides specialized sub-agents that run in isolated pi processes:
 *   git-sub-agent   - Handles /git-commit, /git-push, /git-commit-push
 *   review-sub-agent - Handles review-html skill invocations
 *
 * Agents are defined as markdown files in ./agents/ with YAML frontmatter.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Agent config ─────────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools?: string[];
	systemPrompt: string;
}

function loadAgent(filePath: string): AgentDef | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		// Simple frontmatter parser (no external deps needed)
		const frontMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!frontMatch) return null;
		const frontRaw = frontMatch[1];
		const body = frontMatch[2].trim();

		const fields: Record<string, string> = {};
		for (const line of frontRaw.split("\n")) {
			const m = line.match(/^(\w+):\s*(.*)$/);
			if (m) fields[m[1]] = m[2];
		}

		if (!fields.name || !fields.description) return null;

		const tools = fields.tools?.split(",").map((t) => t.trim()).filter(Boolean);
		return {
			name: fields.name,
			description: fields.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			systemPrompt: body,
		};
	} catch {
		return null;
	}
}

function findPackageAgentsDir(): string | null {
	// Walk up from __dirname to find the package root with agents/
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		const candidate = path.join(dir, "agents");
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
			return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function discoverAgents(): AgentDef[] {
	const agentsDir = findPackageAgentsDir();
	if (!agentsDir) return [];

	const agents: AgentDef[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(agentsDir, entry.name);
		const agent = loadAgent(filePath);
		if (agent) agents.push(agent);
	}
	return agents;
}

// ── Spawn subagent process ───────────────────────────────────

interface SubagentResult {
	exitCode: number;
	output: string;
	error: string;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGeneric = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGeneric) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

async function spawnSubagent(
	agent: AgentDef,
	task: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<SubagentResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (agent.systemPrompt.trim()) args.push("--append-system-prompt", agent.systemPrompt);
	args.push(task);

	return new Promise((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({ exitCode: code ?? 0, output: stdout, stderr });
		});
		proc.on("error", () => {
			resolve({ exitCode: 1, output: "", stderr: "Failed to spawn subagent process" });
		});

		if (signal) {
			if (signal.aborted) proc.kill("SIGTERM");
			else signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
		}
	});
}

function extractFinalOutput(jsonOutput: string): string {
	// Parse JSON lines from --mode json output, find last assistant message
	let lastAssistantText = "";
	for (const line of jsonOutput.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type === "message_end" && event.message?.role === "assistant") {
				for (const part of event.message.content || []) {
					if (part.type === "text") lastAssistantText = part.text;
				}
			}
		} catch {
			// skip malformed lines
		}
	}
	return lastAssistantText;
}

// ── Extension ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const agents = discoverAgents();
	const gitAgent = agents.find((a) => a.name === "git-agent");
	const reviewAgent = agents.find((a) => a.name === "review-agent");

	if (agents.length === 0) {
		console.warn("[sub-agents] No agent markdown files found in package's agents/ directory");
	}

	// ── Register subagent tool (for LLM to use directly) ──────
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a task to a specialized sub-agent with an isolated context window.",
			"The sub-agent runs in a separate pi process.",
			`Available agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
		].join(" "),
		parameters: Type.Object({
			agent: Type.String({ description: "Name of the agent to invoke" }),
			task: Type.String({ description: "Task description to delegate" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = agents.find((a) => a.name === params.agent);
			if (!agent) {
				return {
					content: [{
						type: "text",
						text: `Unknown agent "${params.agent}". Available: ${agents.map((a) => a.name).join(", ")}`,
					}],
					details: {},
				};
			}
			const result = await spawnSubagent(agent, params.task, ctx.cwd, ctx.signal);
			const output = extractFinalOutput(result.output);
			const isError = result.exitCode !== 0 && !output;
			return {
				content: [{ type: "text", text: output || result.stderr || "(no output)" }],
				details: { agent: agent.name, exitCode: result.exitCode },
				isError,
			};
		},
	});

	// ── Git sub-agent commands ─────────────────────────────────
	// Replace existing git commands with sub-agent delegation

	function delegateToGitAgent(task: string, ctx: any) {
		if (!gitAgent) {
			ctx.ui.notify("git-agent not found in agents/ directory", "error");
			return;
		}
		ctx.ui.setStatus("subagent", "🤖 Delegate to git-sub-agent...");
		pi.sendUserMessage(`Use the subagent tool with agent "git-agent" to: ${task}`);
	}

	// Override git-commit
	const existingGitCommands = pi.getCommands().filter((c) => c.name.startsWith("git-") && c.source === "extension");
	// We'll simply re-register - pi handles conflicts by assigning numeric suffixes
	// But to keep it clean, we let these new commands take precedence

	pi.registerCommand("git-commit", {
		description: "(sub-agent) Stage all changes and create a commit via git-sub-agent",
		handler: async (args, ctx) => {
			if (!gitAgent) {
				ctx.ui.notify("❌ git-agent not found", "error");
				return;
			}

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

			ctx.ui.setStatus("subagent", "🤖 git-sub-agent working...");
			ctx.ui.notify("🤖 正在委派 git-sub-agent 处理...", "info");

			const task = message
				? `Stage all changes with git add -A, then commit with message: "${message}". Do NOT ask for confirmation.`
				: `Stage all changes with git add -A, check the diff, write a Conventional Commits message, and commit. Do NOT ask for confirmation.`;

			const result = await spawnSubagent(gitAgent, task, ctx.cwd, ctx.signal);
			const output = extractFinalOutput(result.output);

			if (output) {
				ctx.ui.notify(`✅ git-sub-agent done\n${output}`, "success");
			} else if (result.exitCode !== 0) {
				ctx.ui.notify(`❌ git-sub-agent failed:\n${result.stderr}`, "error");
			} else {
				ctx.ui.notify("✅ git-sub-agent completed (no output)", "success");
			}
			ctx.ui.setStatus("subagent", undefined);
		},
	});

	pi.registerCommand("git-push", {
		description: "(sub-agent) Push commits to remote via git-sub-agent",
		handler: async (_args, ctx) => {
			if (!gitAgent) {
				ctx.ui.notify("❌ git-agent not found", "error");
				return;
			}

			ctx.ui.setStatus("subagent", "🤖 git-sub-agent pushing...");
			ctx.ui.notify("🤖 正在委派 git-sub-agent 处理...", "info");

			const result = await spawnSubagent(gitAgent, "Push commits to remote with git push. Do NOT ask for confirmation.", ctx.cwd, ctx.signal);
			const output = extractFinalOutput(result.output);

			if (output) {
				ctx.ui.notify(`✅ git-sub-agent done\n${output}`, "success");
			} else if (result.exitCode !== 0) {
				ctx.ui.notify(`❌ git-sub-agent failed:\n${result.stderr}`, "error");
			} else {
				ctx.ui.notify("✅ git-sub-agent completed (no output)", "success");
			}
			ctx.ui.setStatus("subagent", undefined);
		},
	});

	pi.registerCommand("git-commit-push", {
		description: "(sub-agent) Stage, commit, and push via git-sub-agent",
		handler: async (args, ctx) => {
			if (!gitAgent) {
				ctx.ui.notify("❌ git-agent not found", "error");
				return;
			}

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

			ctx.ui.setStatus("subagent", "🤖 git-sub-agent working...");
			ctx.ui.notify("🤖 正在委派 git-sub-agent 处理...", "info");

			const task = message
				? `Stage all changes with git add -A, commit with message: "${message}", then push. Do NOT ask for confirmation.`
				: `Stage all changes with git add -A, check the diff, write a Conventional Commits message, commit, then push. Do NOT ask for confirmation.`;

			const result = await spawnSubagent(gitAgent, task, ctx.cwd, ctx.signal);
			const output = extractFinalOutput(result.output);

			if (output) {
				ctx.ui.notify(`✅ git-sub-agent done\n${output}`, "success");
			} else if (result.exitCode !== 0) {
				ctx.ui.notify(`❌ git-sub-agent failed:\n${result.stderr}`, "error");
			} else {
				ctx.ui.notify("✅ git-sub-agent completed (no output)", "success");
			}
			ctx.ui.setStatus("subagent", undefined);
		},
	});

	// ── Review sub-agent ──────────────────────────────────────
	// Intercept input that looks like a review request

	pi.on("input", async (event, ctx) => {
		if (!reviewAgent) return { action: "continue" };

		const text = event.text.trim().toLowerCase();

		// Detect review-html skill invocation or review request
		const isReviewSkill = text.startsWith("/skill:review-html");
		const isReviewRequest =
			!isReviewSkill &&
			(text.includes("review") || text.includes("审查") || text.includes("审阅") || text.includes("review-html")) &&
			(text.includes("code") || text.includes("代码") || text.includes("diff") || text.includes("commit") || text.includes("html") || text.includes("report") || text.includes("报告"));

		if (!isReviewSkill && !isReviewRequest) return { action: "continue" };

		// Handle it via review-sub-agent
		ctx.ui.notify("🤖 正在委派 review-sub-agent 审查代码...", "info");

		const task = `Review the code changes. ${event.text}`;

		// Run review agent asynchronously
		spawnSubagent(reviewAgent, task, ctx.cwd, ctx.signal).then((result) => {
			const output = extractFinalOutput(result.output);
			if (output) {
				ctx.ui.notify(`📋 Review report generated`, "info");
				// Send result back to user
				pi.sendUserMessage(`## Review-sub-agent 审查报告\n\n${output}`);
			} else if (result.exitCode !== 0) {
				ctx.ui.notify(`❌ review-sub-agent failed:\n${result.stderr}`, "error");
			}
		});

		// Return handled so the main agent doesn't also process it
		return { action: "handled" };
	});
}
