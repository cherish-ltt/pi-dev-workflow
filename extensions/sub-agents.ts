/**
 * Sub-Agents Extension
 *
 * Provides specialized sub-agents that run in isolated pi processes.
 * Agents are defined as markdown files in ./agents/ with YAML frontmatter.
 *
 * Provides:
 *   - subagent tool (for LLM to delegate tasks to agents like git-agent, review-agent)
 *   - review-agent input interception with non-blocking async mode
 *
 * Git commands (/git-commit, /git-push, /git-commit-push) are in git-commands.ts,
 * which imports spawnSubagent from here.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { uiSelect } from "./ui-helpers";

// ── Configuration ────────────────────────────────────────────

/** Default timeout for git-type subagents (milliseconds). */
const GIT_TIMEOUT_MS = 120_000;

/** Default timeout for review-type subagents (longer = needs more time). */
const REVIEW_TIMEOUT_MS = 300_000; // 5 min

/** Fallback default. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** Report sub-agent progress every N ms. */
const PROGRESS_INTERVAL_MS = 1_500;

/** Hard limit on accumulated output per subagent (prevents OOM on runaway). */
// Keep up to 10MB of output — large enough to hold complete session event streams
// including cargo test compilation output (commonly 100-400 KB).
// We preserve the END of the buffer (last N bytes) so extractFinalOutput can
// find the final AI response even when the total output is large.
const MAX_BUFFER_BYTES = 10_000_000;

/**
 * Locations to auto-load APPEND_SYSTEM.md / append.system.md from (checked in order).
 * Defined as a getter so that osHomedir() is called lazily rather than at module init,
 * avoiding a potential crash when the module is loaded in restricted environments.
 */
function getAppendSystemPaths(): string[] {
	return [
		path.join(osHomedir(), ".pi", "agent", "append.system.md"),
		".pi/append.system.md",
		"APPEND_SYSTEM.md",
	];
}

/** Cache for append.system.md content, keyed by cwd to support multi-project isolation. */
const _appendSystemCache = new Map<string, string | null>();

function loadAppendSystem(cwd: string): string | null {
	const cached = _appendSystemCache.get(cwd);
	if (cached !== undefined) return cached;
	for (const loc of getAppendSystemPaths()) {
		const abs = path.isAbsolute(loc) ? loc : path.join(cwd, loc);
		try {
			const content = fs.readFileSync(abs, "utf-8").trim();
			if (content) {
				_appendSystemCache.set(cwd, content);
				return content;
			}
		} catch {
			// file not found or unreadable, try next
		}
	}
	_appendSystemCache.set(cwd, null);
	return null;
}

/** Find the newest HTML review file in .pi-dev-output/pi-review/html/, pi-review/, or .pi-dev-output/pi-review/ directory. */
function findNewestReviewHtml(cwd: string): string {
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
					.sort((a, b) => b.mtime - a.mtime);
				if (files.length > 0) {
					// Return relative path from cwd
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

function osHomedir(): string {
	try {
		return require("node:os").homedir();
	} catch {
		return process.env.HOME || process.env.USERPROFILE || "/root";
	}
}

/** Parse boolean-like frontmatter values: true/yes/1, false/no/0, or undefined. */
function parseBool(val: string | undefined): boolean | undefined {
	if (val === undefined) return undefined;
	const lc = val.toLowerCase().trim();
	if (lc === "true" || lc === "yes" || lc === "1") return true;
	if (lc === "false" || lc === "no" || lc === "0") return false;
	return undefined;
}

// ── Process lifecycle management ─────────────────────────────
//
// Fix #1: Prevent orphan sub-agents when pi exits or crashes.
//   - process.on("exit", ...)  - fires on ALL exits (sync only)
//   - process.on("SIGTERM"|"SIGINT"|"SIGHUP"|"SIGQUIT", ...)
//   - process.on("uncaughtException", ...) - crash protection
//   - process.on("unhandledRejection", ...)
//
// Fix #2: CPU spike / deadlock mitigation
//   - Hard buffer size limit (MAX_BUFFER_BYTES) to cap memory
//   - Simplified settle() - no listener remove/reattach race

const activeChildren = new Set<import("node:child_process").ChildProcess>();

function killAllChildren(): void {
	// Snapshot the Set to avoid potential iteration issues if exit callbacks
	// modify activeChildren during the loop.
	const children = [...activeChildren];
	for (const proc of children) {
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

// process.on("exit") - synchronous, fires on process.exit() and normal termination
process.on("exit", () => {
	killAllChildren();
});

// Signal handlers - fire once per signal
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
	process.once(sig, () => {
		killAllChildren();
	});
}

// Crash handlers - clean up children before the crash propagates
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
	/** Custom timeout in ms for this agent type. */
	timeoutMs?: number;

	// ── Subprocess CLI args (from frontmatter) ──
	/** Thinking level: "off" | "low" | "medium" | "high" | "xhigh" */
	thinkingLevel?: string;
	/** Persist session (default: false = --no-session) */
	session?: boolean;
	/** Session directory override */
	sessionDir?: string;
	/** Skip context files AGENTS.md/CLAUDE.md (default: true = -nc) */
	noContext?: boolean;
	/** Disable extension loading (default: true = -ne) */
	noExtensions?: boolean;
	/** Output mode: "json" | "text" (default: "json") */
	mode?: string;
	/** Extra raw CLI args to append */
	extraArgs?: string[];
}

export interface SubagentResult {
	exitCode: number;
	output: string;
	stderr: string;
	/** How long the subagent ran (ms). */
	durationMs: number;
}

/**
 * Caller-provided overrides for subprocess CLI args.
 * Each field, when set, takes precedence over the AgentDef (frontmatter) value.
 */
export interface SubagentArgs {
	/** Override thinking level */
	thinkingLevel?: string;
	/** Override session persistence */
	session?: boolean;
	/** Override session directory */
	sessionDir?: string;
	/** Override -nc (no context files) */
	noContext?: boolean;
	/** Override -ne (no extensions) */
	noExtensions?: boolean;
	/** Override --mode */
	mode?: string;
	/** Override --tools whitelist */
	tools?: string[];
	/** Extra --append-system-prompt (appended after agent's own) */
	appendSystemPrompt?: string;
	/** Extra raw CLI args (appended last, highest priority) */
	extraArgs?: string[];
	/** Workflow UUID to include in session name for cross-workflow traceability */
	workflowId?: string;
}

function inferTimeout(name: string): number {
	const lc = name.toLowerCase();
	if (lc.includes("review") || lc.includes("审查")) return REVIEW_TIMEOUT_MS;
	if (lc.includes("git")) return GIT_TIMEOUT_MS;
	if (lc.includes("prd")) return REVIEW_TIMEOUT_MS;
	return DEFAULT_TIMEOUT_MS;
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
			const m = line.match(/^([\w-]+):\s*(.*)$/);
			if (m) fields[m[1]] = m[2];
		}

		if (!fields.name || !fields.description) return null;

		const tools = fields.tools?.split(",").map((t) => t.trim()).filter(Boolean);
		return {
			name: fields.name,
			description: fields.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			systemPrompt: body,
			timeoutMs: inferTimeout(fields.name),
			// ── Subprocess args from frontmatter ──
			thinkingLevel: fields.thinking || undefined,
			session: parseBool(fields.session),
			sessionDir: fields["session-dir"] || undefined,
			noContext: parseBool(fields["no-context"]),
			noExtensions: parseBool(fields["no-extensions"]),
			mode: fields.mode || undefined,
			extraArgs: fields["extra-args"] ? fields["extra-args"].split(/\s+/).filter(Boolean) : undefined,
		};
	} catch {
		return null;
	}
}

let _discoveredAgents: AgentDef[] | null = null;

export function discoverAgents(): AgentDef[] {
	if (_discoveredAgents) return _discoveredAgents;

	// Walk up from __dirname to find the package root with agents/
	let dir = __dirname;
	let agentsDir: string | null = null;
	for (let i = 0; i < 10; i++) {
		const candidate = path.join(dir, "agents");
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
			agentsDir = candidate;
			break;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (!agentsDir) return (_discoveredAgents = []);

	const agents: AgentDef[] = [];

	/** Recursively walk directory to collect all .md agent definitions. */
	function scanAgentsDir(dir: string): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue; // skip hidden files/dirs
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				scanAgentsDir(fullPath);
			} else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) {
				const agent = loadAgent(fullPath);
				if (agent) agents.push(agent);
			}
		}
	}

	scanAgentsDir(agentsDir);
	return (_discoveredAgents = agents);
}

// ── Spawn subagent process ───────────────────────────────────
// Fix #2: Simplified settle logic - no listener manipulation races.
//   Buffer is capped at MAX_BUFFER_BYTES to prevent OOM on runaway output.
// Fix #3: onProgress callback streams sub-agent output in real-time.
// Fix #4: Subprocess CLI args are resolved from caller > AgentDef frontmatter > defaults.
//   Defaults: -nc, -ne, --no-session, --mode json, --thinking off.
//   Auto-load append.system.md for project-level instructions.

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
	timeoutMs?: number,
	onProgress?: (msg: string) => void,
	argsOverride?: SubagentArgs,
): Promise<SubagentResult> {
	const effectiveTimeout = timeoutMs ?? agent.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const systemPrompt = agent.systemPrompt.trim();

	// ── Resolve arg overrides (caller > AgentDef frontmatter > hardcoded default) ──
	const override = (argsOverride as SubagentArgs) ?? {};

	const finalThinking      = override.thinkingLevel ?? agent.thinkingLevel ?? "off";
	const finalSession       = override.session       ?? agent.session       ?? false;
	const finalSessionDir    = override.sessionDir    ?? agent.sessionDir;
	const finalNoContext     = override.noContext     ?? agent.noContext     ?? true;
	const finalNoExtensions  = override.noExtensions  ?? agent.noExtensions  ?? true;
	const finalMode          = override.mode          ?? agent.mode          ?? "json";
	const finalTools         = override.tools         ?? agent.tools;
	const finalExtraArgs     = override.extraArgs     ?? agent.extraArgs;

	// Build pi arguments for the subagent
	const args: string[] = ["-p"]; // non-interactive

	if (!finalSession) {
		args.push("--no-session");
	} else {
		// Session enabled — auto-name with timestamp + agent name
		// Use full file path with .jsonl extension (pi --session <path> creates/opens file)
		const sessionDir = finalSessionDir || ".pi-dev-output/pi-subagent-sessions";
		const safeAgentName = agent.name.replace(/[^a-zA-Z0-9_-]/g, "_");
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const wfSuffix = override.workflowId ? `_${override.workflowId}` : "";
		const sessionName = `${ts}_${safeAgentName}${wfSuffix}`;
		// Ensure session directory exists before spawning subagent
		try {
			fs.mkdirSync(sessionDir, { recursive: true });
		} catch { /* ignore if already exists */ }
		const sessionPath = path.join(sessionDir, `${sessionName}.jsonl`);
		args.push("--session", sessionPath);
	}

	if (finalNoContext)    args.push("-nc");
	if (finalNoExtensions) args.push("-ne");

	args.push("--mode", finalMode);
	args.push("--thinking", finalThinking);

	// Only grant the tools the agent needs
	if (finalTools && finalTools.length > 0) {
		args.push("--tools", finalTools.join(","));
	}

	// Append agent system prompt (from AgentDef markdown body)
	if (systemPrompt) {
		args.push("--append-system-prompt", systemPrompt);
	}

	// Caller override system prompt (appended after agent's own)
	if (override.appendSystemPrompt) {
		args.push("--append-system-prompt", override.appendSystemPrompt);
	}

	// Auto-load append.system.md (global or project-level)
	// Fix #3: Sub-agents now follow append.system.md instructions
	try {
		const appendContent = loadAppendSystem(cwd);
		if (appendContent) {
			args.push("--append-system-prompt", appendContent);
		}
	} catch {
		// fail silently
	}

	// Extra raw args appended last (highest priority)
	if (finalExtraArgs && finalExtraArgs.length > 0) {
		args.push(...finalExtraArgs);
	}

	// The task itself
	args.push(task);

	const startTime = Date.now();

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

		// ── Real-time progress reporting ───────────────────────
		// Fix #3: More frequent updates (every 1.5s) + on every data chunk
		const progressTimer = setInterval(() => {
			if (settled || !onProgress) return;
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			const lines = stdout.split("\n").filter((l) => l.trim());
			if (lines.length > 0) {
				const recent = lines.slice(-3).join("\n");
				onProgress(`[${agent.name}] (${elapsed}s) ${recent.slice(0, 200)}`);
			} else {
				onProgress(`[${agent.name}] (${elapsed}s) ⏳ 处理中...`);
			}
		}, PROGRESS_INTERVAL_MS);
		progressTimer.unref();

		const settle = (result: SubagentResult) => {
			if (settled) return;
			settled = true;
			clearInterval(progressTimer);
			result.durationMs = Date.now() - startTime;
			resolve(result);
		};

		// ── Stream stdout data + immediate progress callback ──
		// Fix #3: Flush progress on every data chunk
		// Fix #4: Preserve the END of the buffer (last N bytes) instead of the beginning,
		// because extractFinalOutput needs the final AI response which is at the end.
		proc.stdout.on("data", (data: Buffer) => {
			const chunk = data.toString();
			stdout += chunk;
			if (stdout.length > MAX_BUFFER_BYTES) {
				// Keep only the last MAX_BUFFER_BYTES bytes
				stdout = stdout.slice(stdout.length - MAX_BUFFER_BYTES);
			}
			// Immediate progress on new data
			if (!settled && onProgress) {
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				const lines = chunk.split("\n").filter((l) => l.trim());
				if (lines.length > 0) {
					onProgress(`[${agent.name}] (${elapsed}s) ${lines.slice(-1)[0].slice(0, 150)}`);
				}
			}
		});

		proc.stderr.on("data", (data: Buffer) => {
			const chunk = data.toString();
			stderr += chunk;
			if (stderr.length > MAX_BUFFER_BYTES) {
				stderr = stderr.slice(stderr.length - MAX_BUFFER_BYTES);
			}
		});

		proc.on("close", (code) => {
			settle({ exitCode: code ?? 0, output: stdout, stderr, durationMs: 0 });
		});
		proc.on("error", () => {
			settle({ exitCode: 1, output: "", stderr: "Failed to spawn subagent process", durationMs: 0 });
		});

		// ── Timeout protection ──────────────────────────────
		const timer = setTimeout(() => {
			if (settled) return;
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			try { proc.kill("SIGTERM"); } catch { /* already dead */ }
			// Give it a moment to terminate gracefully, then force kill
			setTimeout(() => {
				try { proc.kill("SIGKILL"); } catch { /* already dead */ }
			}, 2000);
			settle({
				exitCode: -1,
				output: stdout,
				stderr: stderr + `\n[ERROR] Subagent timed out after ${(effectiveTimeout / 1000).toFixed(0)}s (${elapsed}s elapsed)`,
				durationMs: 0,
			});
		}, effectiveTimeout);
		timer.unref();

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
	// Parse JSON lines from --mode json output
	// Try multiple event formats to find the final assistant response
	let result = "";
	let textEndSeen = false;

	for (const line of jsonOutput.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);

			// Format 1: pi's --mode json message_update with text_delta (streaming)
			//   {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"..."}}
			// Once text_end has been seen, skip subsequent text_delta events to
			// avoid appending stale deltas that arrive out of order.
			if (!textEndSeen && event.type === "message_update" &&
			    event.assistantMessageEvent?.type === "text_delta") {
				result += event.assistantMessageEvent.delta || "";
			}

			// Format 1b: text_end has the complete accumulated text
			//   {"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"..."}}
			if (event.type === "message_update" &&
			    event.assistantMessageEvent?.type === "text_end" &&
			    event.assistantMessageEvent.content) {
				result = event.assistantMessageEvent.content;
				textEndSeen = true;
			}

			// Format 2: pi agent event — message_end / message_stop / message_complete
			// Only process assistant messages; toolResult and user messages contain
			// raw tool output (e.g. ls -la) that would pollute the extracted summary.
			if ((event.type === "message_stop" || event.type === "message_end" ||
			     event.type === "message_complete") &&
			    event.message?.content &&
			    event.message?.role === "assistant") {
				const parts = Array.isArray(event.message.content)
					? event.message.content
					: [event.message.content];
				for (const part of parts) {
					if (typeof part === "string") result = part;
					else if (part?.type === "text") result = part.text;
				}
			}

			// Format 3: content_block_delta with text deltas (fallback format)
			if (event.type === "content_block_delta" &&
			    event.delta?.type === "text_delta") {
				result += event.delta.text;
			}
			if (event.type === "content_block_delta" &&
			    event.delta?.text) {
				result += event.delta.text;
			}

			// Format 4: generic assistant response
			if (event.type === "assistant_message" && event.content) {
				result = typeof event.content === "string"
					? event.content
					: (event.content.text || event.content.join?.(""));
			}

			// Format 5: text key at top level
			if (event.type === "complete" && event.text) {
				result = event.text;
			}

			// Format 5b: turn_end — extract text from the turn's assistant message.
			// This provides an additional extraction point when message_end is lost
			// due to buffer truncation (large tool results like cargo test output
			// can push the final assistant message beyond the buffer limit).
			if (event.type === "turn_end" &&
			    event.message?.content &&
			    event.message?.role === "assistant") {
				const parts = Array.isArray(event.message.content)
					? event.message.content
					: [event.message.content];
				for (const part of parts) {
					if (typeof part === "string") result = part;
					else if (part?.type === "text") result = part.text;
				}
			}

			// Format 6: agent_end — iterate messages backwards to find the last
			// assistant message with text content. This catches edge cases where
			// the final assistant response has no type:text block (e.g. only
			// thinking/toolCall), which left result polluted by a prior tool result.
			if (event.type === "agent_end" && Array.isArray(event.messages)) {
				for (let i = event.messages.length - 1; i >= 0; i--) {
					const msg = event.messages[i];
					if (msg?.role === "assistant" && Array.isArray(msg.content)) {
						for (let j = msg.content.length - 1; j >= 0; j--) {
							const block = msg.content[j];
							if (typeof block === "string") {
								result = block;
								break;
							}
							if (block?.type === "text" && block.text) {
								result = block.text;
								break;
							}
						}
						if (result) break;
					}
				}
			}
		} catch {
			// If a line isn't JSON, it might be raw text output - collect it
			if (!result) {
				const trimmed = line.trim();
				if (trimmed && !trimmed.startsWith("{") && trimmed.length > 20) {
					result = (result + "\n" + trimmed).trim();
				}
			}
		}
	}

	// Fallback: if nothing parsed, return the raw stdout (truncated to reasonable size)
	if (!result && jsonOutput.trim()) {
		const cleaned = jsonOutput
			.split("\n")
			.filter((l) => {
				const t = l.trim();
				// Skip JSON lines and empty lines
				if (!t || t.startsWith("{")) return false;
				// Skip thinking blocks
				if (t.includes("thinking") && t.length < 30) return false;
				return true;
			})
			.join("\n")
			.trim();
		if (cleaned) result = cleaned;
	}

	return result;
}

// ── Extension ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const agents = discoverAgents();
	const gitAgent = agents.find((a) => a.name === "git-agent");
	const reviewAgent = agents.find((a) => a.name === "review-agent");

	if (agents.length === 0) {
		console.warn("[sub-agents] No agent markdown files found in package's agents/ directory");
	}

	// ── /subagent-stop - 主动终止所有正在运行的 sub-agent ──────
	pi.registerCommand("subagent-stop", {
		description: "Terminate all running sub-agents immediately. Also cancels any active workflow.",
		handler: async (_args, ctx) => {
			const childCount = activeChildren.size;

			// Also try to cancel any active workflow
			let workflowCancelled = false;
			try {
				const { cancelActiveWorkflow, isWorkflowRunning } = await import("./workflow-engine");
				if (isWorkflowRunning()) {
					cancelActiveWorkflow();
					workflowCancelled = true;
				}
			} catch { /* workflow-engine not available, ignore */ }

			if (childCount === 0 && !workflowCancelled) {
				ctx.ui.notify("i️ 当前没有运行中的 sub-agent 或工作流", "info");
				return;
			}

			if (childCount > 0) {
				killAllChildren();
				ctx.ui.notify(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, "info");
				ctx.ui.notify(`🛑 已终止 ${childCount} 个 sub-agent 进程`, "warning");
				ctx.ui.notify(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, "info");
			}

			if (workflowCancelled) {
				ctx.ui.notify(`🛑 已取消运行中的工作流`, "warning");
			}
		},
	});

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
			// Optional overrides (pass-through to SubagentArgs)
			thinkingLevel: Type.Optional(Type.String({ description: "Override thinking level: off | low | medium | high | xhigh" })),
			session: Type.Optional(Type.Boolean({ description: "Override session persistence" })),
			noContext: Type.Optional(Type.Boolean({ description: "Override -nc (skip AGENTS.md/CLAUDE.md)" })),
			noExtensions: Type.Optional(Type.Boolean({ description: "Override -ne (disable extensions)" })),
			mode: Type.Optional(Type.String({ description: "Override output mode: json | text" })),
			tools: Type.Optional(Type.String({ description: "Override tool whitelist (comma-separated)" })),
			extraArgs: Type.Optional(Type.String({ description: "Extra raw CLI args (space-separated)" })),
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
			const abortSignal = signal ?? ctx.signal;

			// Fix #3: Report progress via onUpdate
			onUpdate?.({ state: "running", message: `🤖 正在委派 ${agent.name} 处理...` });

			// Build SubagentArgs from optional tool params
			const toolArgs: SubagentArgs = {};
			if (params.thinkingLevel !== undefined) toolArgs.thinkingLevel = params.thinkingLevel as string;
			if (params.session !== undefined) toolArgs.session = params.session as boolean;
			if (params.noContext !== undefined) toolArgs.noContext = params.noContext as boolean;
			if (params.noExtensions !== undefined) toolArgs.noExtensions = params.noExtensions as boolean;
			if (params.mode !== undefined) toolArgs.mode = params.mode as string;
			if (params.tools !== undefined) toolArgs.tools = (params.tools as string).split(",").map(t => t.trim()).filter(Boolean);
			if (params.extraArgs !== undefined) toolArgs.extraArgs = (params.extraArgs as string).split(/\s+/).filter(Boolean);

			const result = await spawnSubagent(
				agent,
				params.task,
				ctx.cwd,
				abortSignal,
				undefined, // use agent's default timeout
				(progress) => {
					onUpdate?.({ state: "running", message: progress });
				},
				Object.keys(toolArgs).length > 0 ? toolArgs : undefined,
			);
			const output = extractFinalOutput(result.output);
			const dur = (result.durationMs / 1000).toFixed(1);
			const isError = result.exitCode !== 0 && !output;
			return {
				content: [{ type: "text", text: output || result.stderr || "(no output)" }],
				details: { agent: agent.name, exitCode: result.exitCode, durationMs: result.durationMs },
				isError,
			};
		},
	});

	// ── Review sub-agent (input interception) ─────────────────
	// NON-BLOCKING MODE: 用户可选择"后台审查",不阻塞主对话,
	// 审查完成后通过 sendMessage 自动将结果注入会话。
	// 同时保留原有的阻塞模式供需要同步等待的场景使用。

	pi.on("input", async (event, ctx) => {
		if (!reviewAgent) return { action: "continue" };

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

		// 自动触发 /skill:review-html 不询问,直接以"仅审查"模式运行(阻塞,不发送原消息)
		if (isReviewSkill) {
			ctx.ui.setStatus("subagent", "🔍 review-sub-agent reviewing...");
			ctx.ui.notify("🤖 review-sub-agent 正在审查代码(最长 5 分钟),请稍候...", "info");

			const startTime = Date.now();
			const result = await spawnSubagent(
				reviewAgent,
				event.text,
				ctx.cwd,
				ctx.signal,
				undefined,
				(progress) => {
					ctx.ui.setStatus("subagent", progress.slice(0, 50));
				},
			);
			const dur = ((Date.now() - startTime) / 1000).toFixed(1);
			ctx.ui.setStatus("subagent", undefined);

			const filePath = findNewestReviewHtml(ctx.cwd);

			if (filePath) {
				ctx.ui.notify(`📄 ${filePath} (${dur}s)`, "success");
			} else {
				ctx.ui.notify(`✅ review-sub-agent 完成 (${dur}s)`, "info");
			}
			return { action: "handled" };
		}

		// 对于普通关键词触发的审查请求,询问用户选择模式
		// ctx.ui.select 接受 string[],返回选中的字符串
		const mode = await uiSelect(
			ctx,
			"🔍 检测到审查意图",
			[
				"1. 后台审查(非阻塞,异步通知)",
				"2. 仅审查(阻塞,等待结果)",
				"3. 不是审查(放行给主代理)",
			],
		);

		if (!mode || mode.startsWith("3")) {
			// 用户取消(Esc)或选择"不是审查",直接放行给主代理
			return { action: "continue" };
		}

		const isAsync = mode.startsWith("1");

		if (!isAsync) {
			// 阻塞模式:拦截原消息,同步等待审查完成
			ctx.ui.setStatus("subagent", "🔍 review-sub-agent reviewing...");
			ctx.ui.notify("🤖 review-sub-agent 正在审查代码(最长 5 分钟),请稍候...", "info");

			const startTime = Date.now();
			const result = await spawnSubagent(
				reviewAgent,
				event.text,
				ctx.cwd,
				ctx.signal,
				undefined,
				(progress) => {
					ctx.ui.setStatus("subagent", progress.slice(0, 50));
				},
			);
			const dur = ((Date.now() - startTime) / 1000).toFixed(1);
			ctx.ui.setStatus("subagent", undefined);

			const filePath = findNewestReviewHtml(ctx.cwd);

			if (filePath) {
				ctx.ui.notify(`📄 ${filePath} (${dur}s)`, "success");
			} else {
				ctx.ui.notify(`✅ review-sub-agent 完成 (${dur}s)`, "info");
			}
			return { action: "handled" };
		}

		// 非阻塞异步模式:后台运行审查,不阻塞主对话,也不将原消息发给主代理
		ctx.ui.notify("🔍 已在后台启动代码审查,完成后会在此对话中通知您。", "info");

		// 注意:不能在 async 回调中直接使用 ctx,因为 ctx 可能已失效,
		// 但我们可以使用闭包捕获的 pi 和必要参数。
		const userTask = event.text;
		const cwd = ctx.cwd;
		const abortSignal = ctx.signal;

		// 启动后台任务(不等待),完成后通过 sendMessage 注入结果
		(async () => {
			try {
				const startTime = Date.now();
				const result = await spawnSubagent(
					reviewAgent,
					userTask,
					cwd,
					abortSignal,
					undefined,
				);
				const dur = ((Date.now() - startTime) / 1000).toFixed(1);

				const filePath = findNewestReviewHtml(cwd);

				if (filePath) {
					pi.sendMessage({
						customType: "review-result",
						content: `🔍 **代码审查完成** (耗时 ${dur}s)\n\n报告已生成:\n\`${filePath}\`\n\n您可以打开该文件查看详细审查意见。`,
						display: true,
						details: { filePath, durationMs: result.durationMs },
					});
				} else {
					const output = extractFinalOutput(result.output) || result.stderr || "无输出";
					pi.sendMessage({
						customType: "review-result",
						content: `🔍 **代码审查完成** (耗时 ${dur}s)\n\n\`\`\`\n${output.slice(0, 2000)}${output.length > 2000 ? "\n...(内容已截断)" : ""}\n\`\`\``,
						display: true,
						details: { durationMs: result.durationMs },
					});
				}
			} catch (err) {
				console.error("[sub-agents] Background review failed:", err);
				pi.sendMessage({
					customType: "review-result",
					content: `❌ 后台代码审查失败:${err instanceof Error ? err.message : String(err)}`,
					display: true,
				});
			}
		})();

		// 异步审查也不放行原消息给主代理
		return { action: "handled" };
	});
}
