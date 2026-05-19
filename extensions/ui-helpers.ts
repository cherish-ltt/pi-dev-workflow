/**
 * ui-helpers.ts — Rich TUI component builders for select/confirm/input/notify
 *
 * Wraps ctx.ui.custom() with proper text wrapping, black-background panels,
 * and Ctrl+O expand/collapse support.
 *
 * Provides:
 *   - uiSelect()     — replaces ctx.ui.select() with wrapping
 *   - uiConfirm()    — replaces ctx.ui.confirm() with wrapping
 *   - uiInput()      — replaces ctx.ui.input() with wrapping
 *   - updateWorkflowWidget — persistent progress panel (widget)
 *   - sendWorkflowResult() — persistent session completion message
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	SelectList,
	Text,
	Spacer,
	Input,
	type Component,
	type SelectItem,
	visibleWidth,
	wrapTextWithAnsi,
	truncateToWidth,
} from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────────────────

type Theme = ExtensionCommandContext["ui"]["theme"];
type TUI = Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[0];

const WIDGET_KEY = "dev-workflow";

// ── Helpers ──────────────────────────────────────────────────

/** Draw a bordered box around content lines. */
function boxify(lines: string[], theme: Theme, width: number): string[] {
	if (width < 4) return lines;
	const innerW = width - 2;
	const result: string[] = [];
	const top = `╭${"─".repeat(innerW)}╮`;
	const bot = `╰${"─".repeat(innerW)}╯`;
	result.push(theme.fg("accent", top));
	for (const line of lines) {
		const wrapped = wrapTextWithAnsi(line, innerW);
		for (const w of wrapped) {
			const t = truncateToWidth(w, innerW, "");
			const pad = " ".repeat(Math.max(0, innerW - visibleWidth(t)));
			result.push(theme.fg("accent", `│${t}${pad}│`));
		}
	}
	result.push(theme.fg("accent", bot));
	return result;
}

/** Theme-aware bold. */
function bold(theme: Theme, text: string): string {
	return ((theme as { bold?: (s: string) => string }).bold?.(text)) ?? text;
}

/** Theme-aware dim. */
function dim(theme: Theme, text: string): string {
	return theme.fg("dim", text);
}

// ── Select (replaces ctx.ui.select) ──────────────────────────

/**
 * Show a select list with proper text wrapping.
 * Returns the selected item value, or undefined on cancel (Esc).
 */
export function uiSelect(
	ctx: ExtensionCommandContext,
	title: string,
	items: string[],
): Promise<string | undefined> {
	const selectItems: SelectItem[] = items.map((item, i) => ({
		value: item,
		label: item,
	}));

	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const container = new Container();

		const titleWrapped = wrapTextWithAnsi(title, Math.max(20, process.stdout.columns - 6));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", bold(theme, `  ${titleWrapped[0] ?? title}`)), 0, 0));
		for (const line of titleWrapped.slice(1)) {
			container.addChild(new Text(theme.fg("accent", `  ${line}`), 0, 0));
		}
		container.addChild(new Spacer(1));

		const visibleCount = Math.min(selectItems.length + 1, 12);
		const selectList = new SelectList(selectItems, visibleCount, {
			selectedPrefix: (s) => theme.fg("accent", s),
			selectedText: (s) => theme.fg("accent", s),
			description: (s) => theme.fg("muted", s),
			scrollInfo: (s) => theme.fg("dim", s),
			noMatch: (s) => theme.fg("warning", s),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		container.addChild(selectList);

		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("dim", "  ↑↓ 导航 • Enter 选择 • Esc 取消"), 0, 0),
		);

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

// ── Confirm (replaces ctx.ui.confirm) ────────────────────────

/**
 * Show a confirm dialog with proper wrapping.
 * Returns true for Yes, false for No, undefined on cancel.
 */
export function uiConfirm(
	ctx: ExtensionCommandContext,
	title: string,
	message?: string,
): Promise<boolean | undefined> {
	const items: SelectItem[] = [
		{ value: "yes", label: "✅ 是" },
		{ value: "no", label: "❌ 否" },
	];

	return ctx.ui.custom<boolean | undefined>((tui, theme, _kb, done) => {
		const container = new Container();

		container.addChild(new Spacer(1));
		const titleWrapped = wrapTextWithAnsi(title, Math.max(20, process.stdout.columns - 6));
		container.addChild(new Text(theme.fg("accent", bold(theme, `  ${titleWrapped[0] ?? title}`)), 0, 0));
		for (const line of titleWrapped.slice(1)) {
			container.addChild(new Text(theme.fg("accent", `  ${line}`), 0, 0));
		}

		if (message) {
			container.addChild(new Spacer(1));
			const msgWrapped = wrapTextWithAnsi(message, Math.max(20, process.stdout.columns - 6));
			for (const line of msgWrapped) {
				container.addChild(new Text(theme.fg("text", `  ${line}`), 0, 0));
			}
		}

		container.addChild(new Spacer(1));
		const selectList = new SelectList(items, 2, {
			selectedPrefix: (s) => theme.fg("accent", s),
			selectedText: (s) => theme.fg("accent", s),
		});
		selectList.onSelect = (item) => done(item.value === "yes");
		selectList.onCancel = () => done(undefined);
		container.addChild(selectList);

		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("dim", "  ↑↓ 导航 • Enter 选择 • Esc 取消"), 0, 0),
		);

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

// ── Input (replaces ctx.ui.input) ────────────────────────────

/**
 * Show an input dialog with proper wrapping.
 * Returns the entered string, or undefined on cancel.
 */
export function uiInput(
	ctx: ExtensionCommandContext,
	label: string,
	placeholder?: string,
	required = false,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const container = new Container();
		const width = Math.max(20, process.stdout.columns - 6);

		container.addChild(new Spacer(1));
		const labelWrapped = wrapTextWithAnsi(label, width);
		container.addChild(new Text(theme.fg("accent", bold(theme, `  ${labelWrapped[0] ?? label}`)), 0, 0));
		for (const line of labelWrapped.slice(1)) {
			container.addChild(new Text(theme.fg("accent", `  ${line}`), 0, 0));
		}
		container.addChild(new Spacer(1));

		const input = new Input(placeholder ?? "", width - 2);
		input.onSubmit = (val) => {
			if (required && !val.trim()) return;
			done(val || "");
		};
		input.onCancel = () => done(undefined);

		container.addChild(input);
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("dim", "  Enter 确认 • Esc 取消"), 0, 0),
		);

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				input.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

// ═══════════════════════════════════════════════════════════════
//  Workflow Progress Widget
// ═══════════════════════════════════════════════════════════════

/**
 * A single sub-step within a workflow step (e.g. planner, worker, reviewer).
 */
export interface WorkflowSubStepWidgetState {
	agent: string;
	status: "pending" | "running" | "done" | "failed";
	/** Recent tool activity (e.g. "edit:src/main.rs", "read:config.json") */
	tools?: string[];
	/** Output file paths */
	outputs?: string[];
	/** Free-form detail text (e.g. "3 files changed") */
	detail?: string;
	/** Elapsed time for this sub-step */
	durationMs?: number;
	/** Token usage */
	tokenCount?: number;
	/** Tool usage count */
	toolCount?: number;
}

/**
 * Workflow step state for the widget.
 */
export interface WorkflowStepWidgetState {
	label: string;
	status: "pending" | "running" | "done" | "failed" | "skipped";
	/** Timeout in ms for this step */
	timeoutMs?: number;
	durationMs?: number;
	loopCount?: number;
	maxLoops?: number;
	error?: string;
	/** Sub-steps within this step */
	subSteps?: WorkflowSubStepWidgetState[];
}

/**
 * Workflow widget state shared between the workflow engine and the widget.
 */
export interface WorkflowWidgetState {
	mode: string;
	steps: WorkflowStepWidgetState[];
	currentStepIndex: number;
	startedAt: number;
	status: "running" | "done" | "failed" | "cancelled";
	toolCount?: number;
	tokenCount?: number;
	updatedAt: string;
}

// ── Widget component builder ─────────────────────────────────

let _widgetState: WorkflowWidgetState | null = null;
let _widgetAnimationTimer: ReturnType<typeof setInterval> | null = null;
let _lastWidgetCtx: ExtensionCommandContext | null = null;

/** Tracks pi's tools panel expanded state (Ctrl+O toggles it, widget mirrors it) */
let _widgetExpanded = false;

/** Callback invoked when user presses Esc to cancel */
let _onCancelWorkflow: (() => void) | null = null;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANIMATION_MS = 80;

function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / ANIMATION_MS) % SPINNER.length]!;
}

function formatDurationFull(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	return `${m}m${s}s`;
}

function formatTimeout(ms: number): string {
	const m = Math.floor(ms / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	return s > 0 ? `${m}m${s}s` : `${m}m`;
}

/**
 * Build the widget component lines for the given state.
 */
function buildWidgetLines(state: WorkflowWidgetState, theme: Theme, expanded: boolean, width: number): string[] {
	const lines: string[] = [];
	const elapsed = Date.now() - state.startedAt;

	// ── Header ──
	const modeLabel = state.mode === "full-auto" ? "全自动模式"
		: state.mode === "full-attended" ? "完全值守模式"
		: "值守模式";
	const glyph = state.status === "running"
		? theme.fg("accent", spinnerFrame())
		: state.status === "done"
			? theme.fg("success", "✓")
			: state.status === "failed"
				? theme.fg("error", "✗")
				: theme.fg("warning", "■");
	lines.push(`${glyph} ${bold(theme, "工作流")} · ${dim(theme, modeLabel)} · ${dim(theme, formatDurationFull(elapsed))}`);

	// ── Step list ──
	for (let i = 0; i < state.steps.length; i++) {
		const s = state.steps[i]!;
		const isCurrent = i === state.currentStepIndex && state.status === "running";
		const isDone = s.status === "done";
		const isFailed = s.status === "failed";
		const isRunning = s.status === "running" || isCurrent;

		const icon =
			isDone ? theme.fg("success", "✓") :
			isRunning ? theme.fg("accent", spinnerFrame()) :
			isFailed ? theme.fg("error", "✗") :
			s.status === "skipped" ? theme.fg("warning", "⏭") :
			dim(theme, "◦");

		const dur = s.durationMs != null ? dim(theme, ` (${formatDurationFull(s.durationMs)}`) : "";
		const timeout = s.timeoutMs ? dim(theme, `/超时时间${formatTimeout(s.timeoutMs)}`) : "";
		const durClose = s.durationMs != null ? dim(theme, ")") : "";
		const loop = s.loopCount && s.loopCount > 0
			? dim(theme, ` · 第 ${s.loopCount} 次循环`)
			: "";
		const marker = isCurrent ? theme.fg("accent", "▶") : " ";

		const labelColor = isRunning ? theme.fg("accent", s.label) : isDone ? theme.fg("success", s.label) : isFailed ? theme.fg("error", s.label) : s.label;
		lines.push(` ${marker} ${icon} ${labelColor}${dur}${timeout}${durClose}${loop}`);

			// ── Sub-steps (agents) ──
		// Sub-steps always show for the currently running step (no Ctrl+O needed)
		if (s.subSteps && isRunning) {
			for (const sub of s.subSteps) {
				const subIcon =
					sub.status === "done" ? theme.fg("success", "✓") :
					sub.status === "running" ? theme.fg("accent", spinnerFrame()) :
					sub.status === "failed" ? theme.fg("error", "✗") :
					dim(theme, "◦");

				const subDur = sub.durationMs != null ? dim(theme, ` ${formatDurationFull(sub.durationMs)}`) : "";
				const subToken = sub.tokenCount ? dim(theme, ` · ${sub.tokenCount} tokens`) : "";
				const subToolCount = sub.toolCount ? dim(theme, ` · ${sub.toolCount} tools`) : "";

				lines.push(`   ${subIcon} ${dim(theme, "|__")} ${sub.agent}${subDur}${subToken}${subToolCount}`);

				// Tool details: shown when tools are expanded (Ctrl+O toggles this)
				if (expanded && sub.tools && sub.tools.length > 0) {
					for (const tool of sub.tools) {
						lines.push(`      ${dim(theme, `|   ${tool}`)}`);
					}
				}

				// Output paths: always shown
				if (sub.outputs && sub.outputs.length > 0) {
					const outIcon = sub.status === "done" ? theme.fg("success", "|__") : dim(theme, "|__");
					for (const out of sub.outputs) {
						lines.push(`      ${dim(theme, `${outIcon} output: ${out}`)}`);
					}
				}

				// Free-form detail (shown when expanded)
				if (expanded && sub.detail) {
					for (const detailLine of sub.detail.split("\n")) {
						lines.push(`        ${dim(theme, detailLine)}`);
					}
				}
			}
		}

		// Error detail (always shown for failed steps)
		if (isFailed && s.error) {
			for (const errLine of s.error.split("\n")) {
				lines.push(`    ${theme.fg("error", errLine)}`);
			}
		}
	}

	// ── Stats line ──
	const stats: string[] = [];
	if (state.toolCount) stats.push(`${state.toolCount} tools`);
	if (state.tokenCount) stats.push(`${state.tokenCount} tokens`);
	if (stats.length > 0) {
		lines.push(` ${dim(theme, stats.join(" · "))}`);
	}

	// ── Footer hints ──
	if (state.status === "running") {
		if (!expanded) {
			lines.push(` ${theme.fg("accent", "Ctrl+O 展开详情")} ${dim(theme, "|")} ${theme.fg("warning", "Esc/Ctrl+C 取消")}`);
		} else {
			lines.push(` ${dim(theme, "Ctrl+O 折叠详情")} ${dim(theme, "|")} ${theme.fg("warning", "Esc/Ctrl+C 取消")}`);
		}
	}

	return lines;
}

/**
 * Build the widget component factory for the current state.
 * Returns a factory function (tui, theme) => Component.
 * Ctrl+O toggling is handled by the animation loop, which detects
 * changes in getToolsExpanded() and toggles _widgetExpanded independently.
 */
function buildWidgetFactory(state: WorkflowWidgetState, expanded: boolean): (_tui: unknown, theme: Theme) => Component {
	return (_tui, theme) => {
		const width = process.stdout.columns || 120;
		const lines = buildWidgetLines(state, theme, expanded, width);

		const container = new Container();
		const box = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		const inner = new Container();
		for (const line of lines) {
			inner.addChild(new Text(` ${line}`, 1, 0));
		}
		box.addChild(inner);
		container.addChild(box);
		return container;
	};
}

/**
 * Initialize or update the workflow widget.
 * If state is provided, creates/updates the widget.
 * If state is null, removes the widget.
 */
export function updateWorkflowWidget(
	ctx: ExtensionCommandContext,
	state: WorkflowWidgetState | null,
): void {
	if (!ctx.hasUI) return;

	if (!state) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		stopWidgetAnimation();
		_widgetState = null;
		_lastWidgetCtx = null;
		return;
	}

	_widgetState = state;
	_lastWidgetCtx = ctx;

	// Initialize expanded state from tools panel state
	_widgetExpanded = ctx.ui.getToolsExpanded?.() ?? false;
	ctx.ui.setWidget(WIDGET_KEY, buildWidgetFactory(state, _widgetExpanded));

	if (state.status === "running") {
		startWidgetAnimation();
	} else {
		stopWidgetAnimation();
	}
}

function startWidgetAnimation(): void {
	if (_widgetAnimationTimer) return;
	_widgetAnimationTimer = setInterval(() => {
		if (!_widgetState || !_lastWidgetCtx?.hasUI) {
			stopWidgetAnimation();
			return;
		}
		try {
			// Sync widget's expanded state from pi's tools panel state (Ctrl+O toggles this)
			// No fighting — let pi handle the toggle normally
			const toolsExpanded = _lastWidgetCtx.ui.getToolsExpanded?.() ?? false;
			_widgetExpanded = toolsExpanded;

			_lastWidgetCtx.ui.setWidget(
				WIDGET_KEY,
				buildWidgetFactory(_widgetState, _widgetExpanded),
			);
			_lastWidgetCtx.ui.requestRender?.();
		} catch {
			stopWidgetAnimation();
		}
	}, ANIMATION_MS);
	_widgetAnimationTimer.unref?.();
}

function stopWidgetAnimation(): void {
	if (_widgetAnimationTimer) {
		clearInterval(_widgetAnimationTimer);
		_widgetAnimationTimer = null;
	}
}

/** Register a cancel callback triggered by Esc in the widget */
export function setWorkflowCancelCallback(fn: (() => void) | null): void {
	_onCancelWorkflow = fn;
}

/** Trigger workflow cancellation */
export function cancelWorkflow(): void {
	_onCancelWorkflow?.();
}

// ── Send workflow result to session ──────────────────────────

/**
 * Send a workflow completion message to the session for persistence.
 */
export function sendWorkflowResult(
	pi: ExtensionAPI,
	state: WorkflowWidgetState,
	prompt: string,
	workflowType?: string,
): void {
	const totalDur = formatDurationFull(Date.now() - state.startedAt);
	const doneCount = state.steps.filter(s => s.status === "done" || s.status === "skipped").length;
	const failedCount = state.steps.filter(s => s.status === "failed").length;
	const total = state.steps.length;

	const resultIcon = state.status === "done" ? "🎉" : state.status === "failed" ? "❌" : "⏹️";
	const statusText = state.status === "done" ? "全部完成" : state.status === "failed" ? "部分失败" : "已取消";

	// Build step summary with sub-step details
	const stepSummaryParts: string[] = [];
	for (const s of state.steps) {
		const icon = s.status === "done" ? "✅" :
			s.status === "failed" ? "❌" :
			s.status === "skipped" ? "⏭️" : "⬜";
		const durSuffix = s.durationMs != null ? ` (${formatDurationFull(s.durationMs)})` : "";
		const loopSuffix = s.loopCount && s.loopCount > 1 ? ` x${s.loopCount}` : "";
		const errSuffix = s.status === "failed" && s.error ? ` — ${s.error}` : "";

		stepSummaryParts.push(`${icon} **${s.label}**${durSuffix}${loopSuffix}${errSuffix}`);

		// Sub-step details
		if (s.subSteps && s.subSteps.length > 0) {
			for (const sub of s.subSteps) {
				const subIcon = sub.status === "done" ? "  ✓" : sub.status === "failed" ? "  ✗" : "  ◦";
				const subDetail = sub.detail ? ` — ${sub.detail}` : "";
				stepSummaryParts.push(`   ${subIcon} ${sub.agent}${subDetail}`);
				if (sub.outputs && sub.outputs.length > 0) {
					for (const out of sub.outputs) {
						stepSummaryParts.push(`     ⎿  output: \`${out}\``);
					}
				}
			}
		}
	}

	// Summary title
	const modeLabel = state.mode === "full-auto" ? "全自动" : state.mode === "full-attended" ? "完全值守" : "值守";
	const typeLabel = workflowType ? ` - ${workflowType}` : "";

	const body = [
		`[dev-workflow-result${typeLabel}]`,
		"",
		`${resultIcon} **工作流${statusText}** (${totalDur})`,
		"",
		stepSummaryParts.join("\n"),
		"",
		`完成 ${doneCount}/${total} 步${failedCount > 0 ? `，${failedCount} 步失败` : ""}`,
		state.toolCount ? `\n工具调用: ${state.toolCount} 次` : "",
		state.tokenCount ? `\nToken: ${state.tokenCount}` : "",
	].join("\n");

	try {
		pi.sendMessage({
			customType: "dev-workflow-result",
			content: body,
			display: true,
			details: {
				status: state.status,
				steps: state.steps,
				durationMs: Date.now() - state.startedAt,
				workflowType,
				prompt,
			},
		});
	} catch {
		console.log(`[workflow] ${body}`);
	}
}

// ── Dynamic progress update ──────────────────────────────────

/**
 * Helper to build WorkflowWidgetState from step states.
 */
export function buildWidgetState(
	mode: string,
	steps: WorkflowStepWidgetState[],
	currentStepIndex: number,
	startedAt: number,
	status: WorkflowWidgetState["status"],
	extra?: { toolCount?: number; tokenCount?: number },
): WorkflowWidgetState {
	return {
		mode,
		steps,
		currentStepIndex,
		startedAt,
		status,
		updatedAt: new Date().toISOString(),
		toolCount: extra?.toolCount,
		tokenCount: extra?.tokenCount,
	};
}

// ═══════════════════════════════════════════════════════════════
//  Extension factory (no-op — ui-helpers is a helper module)
// ═══════════════════════════════════════════════════════════════

export default function (_pi: ExtensionAPI) {
	// ui-helpers is a helper module, imported by other extensions.
}
