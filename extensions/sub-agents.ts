/**
 * Sub-Agents Extension
 *
 * Provides specialized sub-agents that run in isolated pi processes.
 * Agents are defined as markdown files in ./agents/ with YAML frontmatter.
 *
 * Provides:
 *   - subagent tool (for LLM to delegate tasks to agents like git-agent, review-agent)
 *   - review-agent input interception (auto-review when user mentions "review code")
 *
 * Git commands (/git-commit, /git-push, /git-commit-push) are in git-commands.ts,
 * which imports spawnSubagent from here.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Configuration ────────────────────────────────────────────

/** Default timeout for subagent processes (milliseconds). */
const SUBAGENT_TIMEOUT_MS = 120_000;

/** Report sub-agent progress every N ms. */
const PROGRESS_INTERVAL_MS = 5_000;

/** Hard limit on accumulated output per subagent (prevents OOM on runaway). */
const MAX_BUFFER_BYTES = 200_000;

// ── Process lifecycle management ─────────────────────────────
//
// Fix #1: Prevent orphan sub-agents when pi exits or crashes.
//   - process.on("exit", …)  — fires on ALL exits (sync only)
//   - process.on("SIGTERM"|"SIGINT"|"SIGHUP"|"SIGQUIT", …)
//   - process.on("uncaughtException", …) — crash protection
//   - process.on("unhandledRejection", …)
//
// Fix #2: CPU spike / deadlock mitigation
//   - Hard buffer size limit (MAX_BUFFER_BYTES) to cap memory
//   - Simplified settle() — no listener remove/reattach race
//   - Simpler interval/progress handling

const activeChildren = new Set<import("node:child_process").ChildProcess>();

function killAllChildren(): void {
	for (const proc of activeChildren) {
		try {
			if (proc.pid !== undefined && !proc.killed) {
				proc.kill("SIGTERM");
			}
		} catch {
			// already dead
		}
	}
	activeChildren.clear();
}

// process.on("exit") — synchronous, fires on process.exit() and normal termination
process.on("exit", () => {
	killAllChildren();
});

// Signal handlers — fire once per signal
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
	process.once(sig, () => {
		killAllChildren();
	});
}

// Crash handlers — clean up children before the crash propagates
process.on("uncaughtException", (err) => {
	console.error("[sub-agents] Uncaught exception, killing sub-agents:", err.message);
	killAllChildren();
});
process.on("unhandledRejection", (reason) => {
	console.error("[sub-agents] Unhandled rejection, killing sub-agents:", reason);
	killAllChildren();
});

// ── Agent config ─────────────────────────────────────────────

export interface AgentDef {
	name: string;
	description: string;
	tools?: string[];
	systemPrompt: string;
}

export interface SubagentResult {
	exitCode: number;
	output: string;
	stderr: string;
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

let _agentsDir: string | null = null;

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

let _discoveredAgents: AgentDef[] | null = null;

export function discoverAgents(): AgentDef[] {
	if (_discoveredAgents) return _discoveredAgents;

	const agentsDir = findPackageAgentsDir();
	_agentsDir = agentsDir;
	if (!agentsDir) return (_discoveredAgents = []);

	const agents: AgentDef[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	} catch {
		return (_discoveredAgents = agents);
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(agentsDir, entry.name);
		const agent = loadAgent(filePath);
		if (agent) agents.push(agent);
	}
	return (_discoveredAgents = agents);
}

// ── Spawn subagent process ───────────────────────────────────
// Fix #2: Simplified settle logic — no listener manipulation races.
//   Buffer is capped at MAX_BUFFER_BYTES to prevent OOM on runaway output.
// Fix #3: onProgress callback streams sub-agent output periodically.

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

export async function spawnSubagent(
	agent: AgentDef,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	timeoutMs: number = SUBAGENT_TIMEOUT_MS,
	onProgress?: (msg: string) => void,
): Promise<SubagentResult> {
	const systemPrompt = agent.systemPrompt.trim();

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
	args.push(task);

	return new Promise((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		activeChildren.add(proc);
		proc.on("exit", () => {
			activeChildren.delete(proc);
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		// ── Periodic progress reporting ────────────────────────
		// Fix #3: Show recent sub-agent output to the user
		const progressTimer = setInterval(() => {
			if (settled || !onProgress) return;
			const lines = stdout.split("\n").filter((l) => l.trim());
			if (lines.length > 0) {
				const recent = lines.slice(-3).join("\n");
				onProgress(`[${agent.name}] ${recent.slice(0, 200)}`);
			}
		}, PROGRESS_INTERVAL_MS);
		if (typeof progressTimer === "object" && "unref" in progressTimer) {
			progressTimer.unref();
		}

		const settle = (result: SubagentResult) => {
			if (settled) return;
			settled = true;
			clearInterval(progressTimer);
			resolve(result);
		};

		proc.stdout.on("data", (data: Buffer) => {
			const chunk = data.toString();
			if (stdout.length < MAX_BUFFER_BYTES) {
				stdout += chunk;
				if (stdout.length > MAX_BUFFER_BYTES) {
					stdout = stdout.slice(0, MAX_BUFFER_BYTES);
				}
			}
		});

		proc.stderr.on("data", (data: Buffer) => {
			const chunk = data.toString();
			if (stderr.length < MAX_BUFFER_BYTES) {
				stderr += chunk;
				if (stderr.length > MAX_BUFFER_BYTES) {
					stderr = stderr.slice(0, MAX_BUFFER_BYTES);
				}
			}
		});

		proc.on("close", (code) => {
			settle({ exitCode: code ?? 0, output: stdout, stderr });
		});
		proc.on("error", () => {
			settle({ exitCode: 1, output: "", stderr: "Failed to spawn subagent process" });
		});

		// ── Timeout protection ──────────────────────────────
		const timer = setTimeout(() => {
			if (settled) return;
			try { proc.kill("SIGTERM"); } catch { /* already dead */ }
			// Give it a moment to terminate gracefully, then force kill
			setTimeout(() => {
				try { proc.kill("SIGKILL"); } catch { /* already dead */ }
			}, 2000);
			settle({
				exitCode: -1,
				output: stdout,
				stderr: stderr + "\n[ERROR] Subagent timed out after " + (timeoutMs / 1000) + "s",
			});
		}, timeoutMs);
		if (typeof timer === "object" && "unref" in timer) timer.unref();

		// ── Abort signal wiring ─────────────────────────────
		if (signal) {
			if (signal.aborted) {
				try { proc.kill("SIGTERM"); } catch { /* already dead */ }
			} else {
				const abortHandler = () => {
					try { proc.kill("SIGTERM"); } catch { /* already dead */ }
				};
				signal.addEventListener("abort", abortHandler, { once: true });
			}
		}
	});
}

export function extractFinalOutput(jsonOutput: string): string {
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
			"For quick git operations (commit/push), prefer the /git-commit, /git-push, /git-commit-push commands.",
		].join(" "),
		parameters: Type.Object({
			agent: Type.String({ description: "Name of the agent to invoke" }),
			task: Type.String({ description: "Task description to delegate" }),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
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
			// Use signal directly from agent loop (3rd param), fallback to ctx.signal
			const abortSignal = signal ?? ctx.signal;

			// Fix #3: Report progress via onUpdate
			onUpdate?.({ state: "running", message: `🤖 正在委派 ${agent.name} 处理...` });

			const result = await spawnSubagent(
				agent,
				params.task,
				ctx.cwd,
				abortSignal,
				SUBAGENT_TIMEOUT_MS,
				(progress) => {
					onUpdate?.({ state: "running", message: progress });
				},
			);
			const output = extractFinalOutput(result.output);
			const isError = result.exitCode !== 0 && !output;
			return {
				content: [{ type: "text", text: output || result.stderr || "(no output)" }],
				details: { agent: agent.name, exitCode: result.exitCode },
				isError,
			};
		},
	});

	// ── Review sub-agent (input interception) ─────────────────
	// Note: In input events ctx.signal may be undefined; timeout in spawnSubagent
	// prevents runaway processes. Progress is shown via ui.notify.

	pi.on("input", async (event, ctx) => {
		if (!reviewAgent) return { action: "continue" };

		const text = event.text.trim().toLowerCase();

		// Detect review-html skill invocation or explicit review request.
		// Only match when both "review" intent AND "code/diff/commit" target are present
		// to avoid false positives on casual uses of the word "review".
		const isReviewSkill = text.startsWith("/skill:review-html");
		const hasReviewIntent = text.includes("review") ||
			text.includes("审查") || text.includes("审阅") || text.includes("review-html");
		const hasCodeTarget = text.includes("code") || text.includes("代码") ||
			text.includes("diff") || text.includes("commit") ||
			text.includes("html") || text.includes("report") || text.includes("报告") ||
			text.includes("本次改动") || text.includes("这次改动");
		const isReviewRequest = !isReviewSkill && hasReviewIntent && hasCodeTarget;

		if (!isReviewSkill && !isReviewRequest) return { action: "continue" };

		ctx.ui.setStatus("subagent", "🔍 review-sub-agent reviewing...");
		ctx.ui.notify("🤖 review-sub-agent 正在审查代码，请稍候...", "info");

		const task = `Review the code changes. ${event.text}`;

		// Fix #3: Stream sub-agent progress to user via ui.notify
		const result = await spawnSubagent(
			reviewAgent,
			task,
			ctx.cwd,
			ctx.signal,
			SUBAGENT_TIMEOUT_MS,
			(progress) => {
				ctx.ui.notify(progress, "info");
			},
		);
		const output = extractFinalOutput(result.output);

		if (output) {
			pi.sendUserMessage(`## Review-sub-agent 审查报告\n\n${output}`);
		} else if (result.exitCode !== 0) {
			ctx.ui.notify(`❌ review-sub-agent failed:\n${result.stderr}`, "error");
		} else {
			ctx.ui.notify("✅ review-sub-agent completed (no output)", "success");
		}
		ctx.ui.setStatus("subagent", undefined);

		// Return handled so the main agent doesn't also process it
		return { action: "handled" };
	});
}
