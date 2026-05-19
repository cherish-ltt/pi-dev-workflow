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
 *   - uiNotify()     — persistent notification in session via sendMessage
 *   - WorkflowWidget — persistent progress panel (widget)
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

		// Title
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
			if (required && !val.trim()) return; // keep waiting
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

// ── Notify in session (replaces ctx.ui.notify for persistence) ──

/**
 * Send a persistent notification into the conversation session.
 * Uses pi.sendMessage() with a custom type for proper rendering.
 */
export function notifyInSession(
	pi: ExtensionAPI,
	title: string,
	body: string,
	type: "info" | "success" | "warning" | "error" = "info",
): void {
	const icon = type === "success" ? "✅" : type === "warning" ? "⚠️" : type === "error" ? "❌" : "ℹ️";
	try {
		pi.sendMessage({
			customType: "dev-workflow-notify",
			content: `${icon} **${title}**\n\n${body}`,
			display: true,
			details: { type, title, body },
		});
	} catch {
		// Fallback if sendMessage fails
		console.log(`[workflow] ${icon} ${title}: ${body}`);
	}
}

// ── Workflow Progress Widget ─────────────────────────────────

/**
 * Workflow step state for the widget.
 */
export interface WorkflowStepWidgetState {
	label: string;
	status: "pending" | "running" | "done" | "failed" | "skipped";
	durationMs?: number;
	loopCount?: number;
	error?: string;
	/** Sub-steps within this step (for loop-group or parallel details) */
	subSteps?: Array<{
		agent: string;
		status: "pending" | "running" | "done" | "failed";
		detail?: string;
	}>;
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
	/** ISO timestamp of last update */
	updatedAt: string;
}

// ── Widget component builder ─────────────────────────────────

let _widgetState: WorkflowWidgetState | null = null;
let _widgetAnimationTimer: ReturnType<typeof setInterval> | null = null;
let _lastWidgetCtx: ExtensionCommandContext | null = null;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANIMATION_MS = 80;

function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / ANIMATION_MS) % SPINNER.length]!;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	return `${m}m${s}s`;
}

/**
 * Build the widget component lines for the given state.
 */
function buildWidgetLines(state: WorkflowWidgetState, theme: Theme, expanded: boolean, width: number): string[] {
	const lines: string[] = [];
	const elapsed = Date.now() - state.startedAt;

	// Header
	const modeLabel = state.mode === "full-auto" ? "全自动" : state.mode === "full-attended" ? "完全值守" : "值守";
	const glyph = state.status === "running"
		? theme.fg("accent", spinnerFrame())
		: state.status === "done"
			? theme.fg("success", "✓")
			: state.status === "failed"
				? theme.fg("error", "✗")
				: theme.fg("warning", "■");
	lines.push(`${glyph} ${bold(theme, "工作流")} ${theme.fg("dim", `· ${modeLabel} · ${formatDuration(elapsed)}`)}`);

	// Step list
	for (let i = 0; i < state.steps.length; i++) {
		const s = state.steps[i]!;
		const isCurrent = i === state.currentStepIndex && state.status === "running";

		const icon =
			s.status === "done" ? theme.fg("success", "✓") :
			s.status === "running" ? theme.fg("accent", spinnerFrame()) :
			s.status === "failed" ? theme.fg("error", "✗") :
			s.status === "skipped" ? theme.fg("warning", "⏭") :
			theme.fg("dim", "◦");

		const dur = s.durationMs != null ? ` ${theme.fg("dim", `(${formatDuration(s.durationMs)})`)}` : "";
		const loop = s.loopCount && s.loopCount > 1 ? ` ${theme.fg("dim", `x${s.loopCount}`)}` : "";
		const marker = isCurrent ? `${theme.fg("accent", "▶")}` : " ";
		const label = truncateToWidth(s.label, Math.max(10, width - 10));
		lines.push(` ${marker} ${icon} ${label}${dur}${loop}`);

		// Error detail if failed
		if (s.status === "failed" && s.error && expanded) {
			const errWrapped = wrapTextWithAnsi(`  ${theme.fg("error", `⎿  ${s.error}`)}`, width - 2);
			for (const el of errWrapped) {
				lines.push(`  ${el}`);
			}
		}

		// Sub-steps (parallel agents, loop iterations)
		if (s.subSteps && (expanded || isCurrent)) {
			for (const sub of s.subSteps) {
				const subIcon =
					sub.status === "done" ? theme.fg("success", "✓") :
					sub.status === "running" ? theme.fg("accent", spinnerFrame()) :
					sub.status === "failed" ? theme.fg("error", "✗") :
					theme.fg("dim", "◦");
				const subLabel = truncateToWidth(sub.agent, Math.max(8, width - 16));
				const detail = sub.detail ? ` ${theme.fg("dim", sub.detail)}` : "";
				lines.push(`   ${subIcon} ${subLabel}${detail}`);
			}
		}

		// Running step detail (expanded only)
		if (isCurrent && expanded && s.subSteps) {
			for (const sub of s.subSteps) {
				if (sub.status === "running" && sub.detail) {
					const actWrapped = wrapTextWithAnsi(`     ${theme.fg("dim", `⎿  ${sub.detail}`)}`, width - 4);
					for (const el of actWrapped) {
						lines.push(`  ${el}`);
					}
				}
			}
		}
	}

	// Stats
	const stats: string[] = [];
	if (state.toolCount) stats.push(`${state.toolCount} tools`);
	if (state.tokenCount) stats.push(`${state.tokenCount} tokens`);
	if (stats.length > 0) {
		lines.push(` ${theme.fg("dim", stats.join(" · "))}`);
	}

	// Ctrl+O hint
	if (!expanded && state.status === "running") {
		lines.push(` ${theme.fg("accent", "Ctrl+O 展开详情")}`);
	}

	return lines;
}

/**
 * Build the widget component factory for the current state.
 * Returns a factory function (tui, theme) => Component, as required by ctx.ui.setWidget().
 */
function buildWidgetFactory(state: WorkflowWidgetState): (_tui: unknown, theme: Theme) => Component {
	return (_tui, theme) => {
		const width = process.stdout.columns || 120;
		const lines = buildWidgetLines(state, theme, false, width);

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
		// Remove widget
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		stopWidgetAnimation();
		_widgetState = null;
		_lastWidgetCtx = null;
		return;
	}

	_widgetState = state;
	_lastWidgetCtx = ctx;

	const expanded = ctx.ui.getToolsExpanded?.() ?? false;
	ctx.ui.setWidget(WIDGET_KEY, buildWidgetFactory(state));

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
			const expanded = _lastWidgetCtx.ui.getToolsExpanded?.() ?? false;
			_lastWidgetCtx.ui.setWidget(
				WIDGET_KEY,
				buildWidgetFactory(_widgetState),
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

/**
 * Send a workflow completion message to the session for persistence.
 */
export function sendWorkflowResult(
	pi: ExtensionAPI,
	state: WorkflowWidgetState,
	prompt: string,
): void {
	const totalDur = formatDuration(Date.now() - state.startedAt);
	const doneCount = state.steps.filter(s => s.status === "done" || s.status === "skipped").length;
	const failedCount = state.steps.filter(s => s.status === "failed").length;

	const resultIcon = state.status === "done" ? "🎉" : state.status === "failed" ? "❌" : "⏹️";
	const statusText = state.status === "done" ? "全部完成" : state.status === "failed" ? "部分失败" : "已取消";

	const stepSummary = state.steps.map((s, i) => {
		const icon = s.status === "done" ? "✅" : s.status === "failed" ? "❌" : s.status === "skipped" ? "⏭️" : "⬜";
		return `${icon} **${s.label}**${s.status === "failed" && s.error ? ` — ${s.error}` : ""}`;
	}).join("\n");

	const body = [
		`${resultIcon} **工作流${statusText}** (${totalDur})`,
		"",
		stepSummary,
		"",
		`完成 ${doneCount}/${state.steps.length} 步${failedCount > 0 ? `，${failedCount} 步失败` : ""}`,
		state.toolCount ? `\n工具调用: ${state.toolCount} 次` : "",
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
				prompt,
			},
		});
	} catch {
		console.log(`[workflow] ${body}`);
	}
}

// ── Dynamic progress update ──────────────────────────────────

/**
 * Helper to build WorkflowWidgetState from WorkflowStepDef array + runtime states.
 */
export function buildWidgetState(
	mode: string,
	steps: Array<{
		label: string;
		status: "pending" | "running" | "done" | "failed" | "skipped";
		durationMs?: number;
		loopCount?: number;
		error?: string;
	}>,
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
//  Extension factory (no-op — ui-helpers is a helper module, not a standalone extension)
// ═══════════════════════════════════════════════════════════════

export default function (_pi: ExtensionAPI) {
	// ui-helpers is a helper module, imported by other extensions.
}
