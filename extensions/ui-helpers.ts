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
import { Key, matchesKey } from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────────────────

type Theme = ExtensionCommandContext["ui"]["theme"];
type TUI = Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[0];

const WIDGET_KEY = "dev-workflow";

// ── Constants ─────────────────────────────────────────────────

/** Marker returned by uiInput/uiSelect when user triggers "back". */
export const BACK_MARKER = "__BACK__";

/** The display text for the back option. */
export const BACK_OPTION_TEXT = "← 返回上一步";

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
    return (theme as { bold?: (s: string) => string }).bold?.(text) ?? text;
}

/** Theme-aware dim. */
function dim(theme: Theme, text: string): string {
    return theme.fg("dim", text);
}

// ── Select (replaces ctx.ui.select) ──────────────────────────

/**
 * Show a select list with proper text wrapping.
 * Returns the selected item value, or undefined on cancel (Esc).
 * When backable=true, prepends "← 返回上一步" as the first item;
 * caller should check for it via choice === BACK_OPTION_TEXT.
 */
export function uiSelect(
    ctx: ExtensionCommandContext,
    title: string,
    items: string[],
    backable = false,
): Promise<string | undefined> {
    const selectItems: SelectItem[] = [];
    if (backable) {
        selectItems.push({ value: BACK_OPTION_TEXT, label: BACK_OPTION_TEXT });
    }
    for (const item of items) {
        selectItems.push({ value: item, label: item });
    }

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
        container.addChild(new Text(theme.fg("dim", "  ↑↓ 导航 • Enter 选择 • Esc 取消"), 0, 0));

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
 * Returns true for Yes, false for No, "back" for back, undefined on cancel.
 */
export function uiConfirm(
    ctx: ExtensionCommandContext,
    title: string,
    message?: string,
    backable = false,
): Promise<boolean | "back" | undefined> {
    const items: SelectItem[] = [
        { value: "yes", label: "✅ 是" },
        { value: "no", label: "❌ 否" },
    ];
    if (backable) {
        items.push({ value: "back", label: BACK_OPTION_TEXT });
    }

    return ctx.ui.custom<boolean | "back" | undefined>((tui, theme, _kb, done) => {
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
        const visibleCount = backable ? 3 : 2;
        const selectList = new SelectList(items, visibleCount, {
            selectedPrefix: (s) => theme.fg("accent", s),
            selectedText: (s) => theme.fg("accent", s),
        });
        selectList.onSelect = (item) => {
            if (item.value === "back") done("back" as const);
            else done(item.value === "yes");
        };
        selectList.onCancel = () => done(undefined);
        container.addChild(selectList);

        container.addChild(new Spacer(1));
        const hint = backable
            ? "  ↑↓ 导航 • Enter 选择 • Esc 取消"
            : "  ↑↓ 导航 • Enter 选择 • Esc 取消";
        container.addChild(new Text(theme.fg("dim", hint), 0, 0));

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
 * Returns the entered string, or BACK_MARKER on back, or undefined on cancel.
 * When backable=true, supports ← for back, Ctrl+Shift+← for back, and Ctrl+Shift+→ for submit+next.
 */
export function uiInput(
    ctx: ExtensionCommandContext,
    label: string,
    placeholder?: string,
    required = false,
    backable = false,
    initialValue = "",
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

        // 实时换行预览区域（在输入框上方）
        const previewText = new Text("", 0, 0);
        container.addChild(previewText);
        container.addChild(new Spacer(1));

        const input = new Input(placeholder ?? "", width - 2);
        if (initialValue) {
            input.setValue(initialValue);
        }
        input.onSubmit = (val) => {
            if (required && !val.trim()) return;
            done(val || "");
        };
        input.onEscape = () => done(undefined);

        container.addChild(input);
        container.addChild(new Spacer(1));

        if (backable) {
            container.addChild(new Text(
                theme.fg("dim", "  Enter 确认 • Ctrl+Shift+← 上一步 • Ctrl+Shift+→ 跳过 • Esc 取消"),
                0, 0,
            ));
        } else {
            container.addChild(new Text(theme.fg("dim", "  Enter 确认 • Esc 取消"), 0, 0));
        }

        return {
            render: (w) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data) => {
                // 左方向键 → 返回（优先于 Input 的光标左移）
                if (backable && matchesKey(data, Key.left)) {
                    done(BACK_MARKER);
                    return;
                }

                // Intercept back/next keys before passing to Input
                if (backable) {
                    // Ctrl+Shift+← → go back to previous question
                    if (matchesKey(data, Key.ctrlShift("left"))) {
                        done(BACK_MARKER);
                        return;
                    }
                    // Ctrl+Shift+→ → submit current value and go next
                    if (matchesKey(data, Key.ctrlShift("right"))) {
                        done(input.getValue() || "");
                        return;
                    }
                }
                input.handleInput(data);

                // 读取更新后的 value，更新预览
                const val = input.getValue();
                if (val.length > 0) {
                    const wrapped = wrapTextWithAnsi(val, width - 4);
                    const previewContent = wrapped
                        .map(l => theme.fg("dim", `  ${l}`))
                        .join("\n");
                    previewText.setText(previewContent);
                } else {
                    previewText.setText("");
                }

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
    /** When this sub-step started (for live timing) */
    startedAt?: number;
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
    /** When this step started executing (for live timing) */
    startedAt?: number;
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
    /** Human-readable task summary shown in widget header, e.g. "[feat - 在 auth 中实现登录]" */
    taskSummary?: string;
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

export function formatTimeout(ms: number): string {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return s > 0 ? `${m}m${s}s` : `${m}m`;
}

/**
 * Build the widget component lines for the given state.
 * New UI design — black background, |__ tree connectors, gold footer.
 *
 * Running state example:
 * ⠋ 工作流 · 值守模式 · 6m16s
 *        ✓ 📋生成实施计划 (1m59s/超时时间15m)
 *          |__ planner ·
 *             |__ output:.pi-dev-output/pi-plans/20260520-1628-export-kcp-public2-api.md
 *     ▶ ⠋ 🔧实施代码 → 审查 · 第 1 次循环  (1s/超时时间15m)
 *         |__ worker ·
 *             |   edit:代码xxx.rs
 *             |   edit:代码xxx.rs
 *             |__ new:代码xxx.ts
 *         |__ reviewer ·
 *             |   output:.pi-dev-output/pi-review/md/review-20260520-180001.md
 *             |__ output:.pi-dev-output/pi-review/md/review-20260520-180002.md
 *       ◦ ✂️ 精简代码 → 审查 · 第 0 次循环
 *         |__ trimmer ·
 *             |__ 正在排队
 *         |__ reviewer ·
 *             |__ 正在排队
 *       ◦ 📝 更新文档
 *         |__ docWriter ·
 *             |__ 正在排队
 *     Ctrl+O 展开详情(金色) | Escape 取消(金色)
 */
function buildWidgetLines(state: WorkflowWidgetState, theme: Theme, expanded: boolean, width: number): string[] {
    const lines: string[] = [];
    const elapsed = Date.now() - state.startedAt;

    // ── Task summary (shown above the main header) ──
    if (state.taskSummary) {
        lines.push(` ${dim(theme, state.taskSummary)}`);
    }

    // ── Header ──
    const modeLabel =
        state.mode === "full-auto" ? "全自动模式" : state.mode === "full-attended" ? "完全值守模式" : "值守模式";
    const glyph =
        state.status === "running"
            ? theme.fg("accent", spinnerFrame())
            : state.status === "done"
              ? theme.fg("success", "✓")
              : state.status === "failed"
                ? theme.fg("error", "✗")
                : theme.fg("warning", "■");
    lines.push(`${glyph} 工作流 · ${dim(theme, modeLabel)} · ${dim(theme, formatDurationFull(elapsed))}`);

    // ── Step list ──
    for (let i = 0; i < state.steps.length; i++) {
        const s = state.steps[i]!;
        const isCurrent = i === state.currentStepIndex && state.status === "running";
        const isDone = s.status === "done";
        const isFailed = s.status === "failed";
        const isRunning = s.status === "running" || isCurrent;
        const isPending = s.status === "pending" && !isRunning;
        const isSkipped = s.status === "skipped";

        // ── Icon ──
        // ✓ green for done, ▶ ⠋ orange for current, ◦ dim for pending
        let icon: string;
        if (isDone) {
            icon = theme.fg("success", "✓");
        } else if (isRunning) {
            icon = `▶ ${theme.fg("warning", spinnerFrame())}`;
        } else if (isFailed) {
            icon = theme.fg("error", "✗");
        } else if (isSkipped) {
            icon = theme.fg("warning", "⏭");
        } else {
            icon = dim(theme, "◦");
        }

        // ── Duration ──
        let displayDurMs: number | undefined = s.durationMs;
        if (isRunning && s.startedAt) {
            displayDurMs = Date.now() - s.startedAt;
        }
        const durStr =
            displayDurMs != null
                ? dim(theme, ` (${formatDurationFull(displayDurMs)}`)
                : isRunning
                  ? dim(theme, ` (0s`)
                  : "";
        const timeout = s.timeoutMs ? dim(theme, `/超时时间${formatTimeout(s.timeoutMs)}`) : "";
        const durClose = displayDurMs != null || isRunning ? dim(theme, ")") : "";

        // ── Loop count (第 N 次循环) for loop-group steps ──
        let loopStr = "";
        if (s.loopCount != null && s.loopCount > 0) {
            loopStr = dim(theme, ` · 第 ${s.loopCount} 次循环`);
        } else if (s.maxLoops != null) {
            if (isRunning) {
                // 当 loop-group 开始运行时，即使 loopCount 尚未通过 updateWidgetStep 设置，
                // 也显示"第 1 次循环"（第 0 次循环仅用于 pending 状态）
                loopStr = dim(theme, ` · 第 1 次循环`);
            } else if (isPending) {
                loopStr = dim(theme, ` · 第 0 次循环`);
            }
        }

        // ── Label color ──
        const labelStyle = isRunning
            ? theme.fg("warning", s.label)
            : isDone
              ? theme.fg("success", s.label)
              : isFailed
                ? theme.fg("error", s.label)
                : dim(theme, s.label);

        // ── Step indentation ──
        // Done:    "       ✓ ..."
        // Running: "    ▶ ⠋ ..."
        // Other:   "      ◦ ..."
        let stepIndent: string;
        if (isDone) {
            stepIndent = "       ";
        } else if (isRunning) {
            stepIndent = "    ";
        } else {
            stepIndent = "      ";
        }

        // ── Step line ──
        lines.push(`${stepIndent}${icon} ${labelStyle}${loopStr}${durStr}${timeout}${durClose}`);

        // ── Sub-steps (agents with |__ tree) ──
        if (s.subSteps && s.subSteps.length > 0) {
            // Agent indent: 9 for done, 8 for running/pending
            const agentIndent = isDone ? "         " : "        ";
            // Child indent: always 12
            const childIndent = "            ";
            const lastSubIdx = s.subSteps.length - 1;

            for (let si = 0; si < s.subSteps.length; si++) {
                const sub = s.subSteps[si]!;
                const isSubDone = sub.status === "done" || sub.status === "failed";
                const isSubRunning = sub.status === "running";
                const isSubPending = sub.status === "pending";
                const isLastSub = si === lastSubIdx;

                // Sub-step icon
                const subIcon = isSubDone
                    ? theme.fg("success", "✓")
                    : isSubRunning
                      ? theme.fg("accent", spinnerFrame())
                      : dim(theme, "◦");

                // Agent line: "        |__ ✓ worker · (52.6s/超时时间60m)"
                // Build inline duration and timeout info for sub-step
                let subDurStr = "";
                let subTimeoutStr = "";
                let subDurClose = "";
                let elapsedMs: number | undefined;
                if (sub.startedAt) {
                    elapsedMs = Date.now() - sub.startedAt;
                } else if (sub.durationMs != null) {
                    elapsedMs = sub.durationMs;
                }
                if (elapsedMs != null) {
                    subDurStr = dim(theme, ` (${formatDurationFull(elapsedMs)}`);
                } else if (isSubRunning) {
                    subDurStr = dim(theme, ` (0s`);
                }
                // Extract timeout info from sub.detail (e.g. "超时时间60m")
                // detail is set in runAgentWithProgress as `超时时间${formatTimeout(timeoutMs)}`
                if (sub.detail && sub.detail.includes("超时时间")) {
                    subTimeoutStr = dim(theme, `/${sub.detail}`);
                }
                if (subDurStr) {
                    subDurClose = dim(theme, ")");
                }
                const agentConnector = dim(theme, "|__");
                lines.push(`${agentIndent}${agentConnector} ${subIcon} ${sub.agent} ·${subDurStr}${subTimeoutStr}${subDurClose}`);

                // ── Children (tools, outputs, or "正在排队") ──
                const childItems: string[] = [];

                if (isSubPending) {
                    childItems.push(dim(theme, "正在排队"));
                } else if (isSubRunning || isSubDone) {
                    if (sub.tools && sub.tools.length > 0) {
                        for (const t of sub.tools) {
                            childItems.push(t);
                        }
                    }
                    if (sub.outputs && sub.outputs.length > 0) {
                        for (const o of sub.outputs) {
                            childItems.push(`output:${o}`);
                        }
                    }
                    if (childItems.length === 0 && sub.detail && !sub.detail.includes("超时时间")) {
                        childItems.push(sub.detail);
                    }
                }

                // Render children with tree branching
                // Non-last child: |   (pipe + 3 spaces)
                // Last child: |__ (pipe + 2 underscores + space) — closes the branch
                const lastChildIdx = childItems.length - 1;
                for (let ci = 0; ci < childItems.length; ci++) {
                    const isLastChild = ci === lastChildIdx;
                    const childConnector = isLastChild ? dim(theme, "|__") : dim(theme, "|  ");
                    lines.push(`${childIndent}${childConnector} ${childItems[ci]!}`);
                }
            }
        } else if (isPending) {
            // Pending step with no sub-steps yet
            const agentIndent = "        ";
            lines.push(`${agentIndent}${dim(theme, "|__")} ${dim(theme, "◦")} 正在排队`);
        }

        // Error detail for failed steps
        if (isFailed && s.error) {
            for (const errLine of s.error.split("\n")) {
                lines.push(`       ${theme.fg("error", errLine)}`);
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

    // ── Footer hints (金色) ──
    // if (state.status === "running") {
    //     const gold = (text: string) => theme.fg("warning", text);
    //     lines.push(` ${gold("Ctrl+O 展开详情")} ${dim(theme, "|")} ${gold("Escape 取消")}`);
    // }
    if (state.status === "running") {
        const gold = (text: string) => theme.fg("warning", text);
        if (!expanded) {
            lines.push(` ${gold("Ctrl+O 展开详情")} ${dim(theme, "|")} ${gold("Escape 取消")}`);
        } else {
            lines.push(` ${dim(theme, "Ctrl+O 折叠详情")} ${dim(theme, "|")} ${gold("Escape 取消")}`);
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
export function updateWorkflowWidget(ctx: ExtensionCommandContext, state: WorkflowWidgetState | null): void {
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

            _lastWidgetCtx.ui.setWidget(WIDGET_KEY, buildWidgetFactory(_widgetState, _widgetExpanded));
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
 * Helper: extract all file changes from step states for the completion report.
 * Returns { edits, news, deletes } and a directory-tree formatted string.
 *
 * Checks:
 *   1. sub.tools for edit:/new:/delete: patterns
 *   2. sub.outputs for output file paths (plans, reviews, etc.)
 *   3. Falls back to known output patterns if nothing found
 */
function extractFileChanges(steps: WorkflowStepWidgetState[]): {
    edits: number;
    news: number;
    deletes: number;
    treeText: string;
} {
    const editFiles: string[] = [];
    const newFiles: string[] = [];
    const delFiles: string[] = [];

    // Collect output paths that should be tracked as files
    const outputFiles: string[] = [];

    for (const s of steps) {
        if (!s.subSteps) continue;
        for (const sub of s.subSteps) {
            // Check tools for file change patterns.
            // Supports both old format ("edit: path", "new: path", "delete: path")
            // and new git-format ("M   path", "A   path", "D   path") from updateToolsFromGit.
            if (sub.tools) {
                for (const tool of sub.tools) {
                    // Old format: "edit: path", "new: path", "delete: path"
                    const oldEdit = tool.match(/^edit:\s*(.+)/i);
                    const oldNew = tool.match(/^new:\s*(.+)/i);
                    const oldDel = tool.match(/^delete:\s*(.+)/i);
                    // New git-format: "M   path", "A   path", "D   path"
                    const gitFormat = tool.match(/^([MAD])\s{2,}(.+)$/);

                    if (oldEdit) {
                        const fp = oldEdit[1]!.trim();
                        if (!editFiles.includes(fp)) editFiles.push(fp);
                    } else if (oldNew) {
                        const fp = oldNew[1]!.trim();
                        if (!newFiles.includes(fp)) newFiles.push(fp);
                    } else if (oldDel) {
                        const fp = oldDel[1]!.trim();
                        if (!delFiles.includes(fp)) delFiles.push(fp);
                    } else if (gitFormat) {
                        const status = gitFormat[1]!;
                        const fp = gitFormat[2]!.trim();
                        if (status === "M" && !editFiles.includes(fp)) {
                            editFiles.push(fp);
                        } else if (status === "A" && !newFiles.includes(fp)) {
                            newFiles.push(fp);
                        } else if (status === "D" && !delFiles.includes(fp)) {
                            delFiles.push(fp);
                        }
                    }
                }
            }
            // Check outputs for generated file paths (plans, review reports, etc.)
            if (sub.outputs) {
                for (const o of sub.outputs) {
                    // Only track output files that look like actual generated docs
                    if (
                        o.includes(".pi-dev-output") ||
                        o.includes(".md") ||
                        o.includes("review-") ||
                        o.includes("pi-plans") ||
                        o.includes("pi-review")
                    ) {
                        if (!outputFiles.includes(o)) {
                            outputFiles.push(o);
                        }
                    }
                }
            }
        }
    }

    // ── Merge all file paths, deduplicate ─────────────────────
    const allPaths = new Map<string, "edit" | "new" | "delete" | "output">();
    for (const fp of editFiles) allPaths.set(fp, "edit");
    for (const fp of newFiles) allPaths.set(fp, "new");
    for (const fp of delFiles) allPaths.set(fp, "delete");
    for (const fp of outputFiles) {
        if (!allPaths.has(fp)) allPaths.set(fp, "output");
    }

    // ── Build multi-level tree ────────────────────────────────
    interface TreeNode {
        name: string;
        children: Map<string, TreeNode>;
        isFile: boolean;
    }

    function buildTree(paths: Iterable<string>): TreeNode {
        const root: TreeNode = { name: "", children: new Map(), isFile: false };
        for (const filePath of paths) {
            const parts = filePath.split("/");
            let current = root;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i]!;
                const isLast = i === parts.length - 1;
                let child = current.children.get(part);
                if (!child) {
                    child = { name: part, children: new Map(), isFile: false };
                    current.children.set(part, child);
                }
                current = child;
                if (isLast) current.isFile = true;
            }
        }
        return root;
    }

    function renderTreeNode(node: TreeNode, prefix: string, isLast: boolean, lines: string[]): void {
        const connector = isLast ? "└── " : "├── ";
        lines.push(`${prefix}${connector}${node.name}`);
        renderChildren(node, prefix + (isLast ? "    " : "│   "), lines);
    }

    function renderChildren(node: TreeNode, prefix: string, lines: string[]): void {
        const entries = [...node.children.entries()].sort((a, b) => {
            // Directories before files, then alphabetical
            if (a[1].isFile !== b[1].isFile) return a[1].isFile ? 1 : -1;
            return a[0].localeCompare(b[0]);
        });
        for (let i = 0; i < entries.length; i++) {
            const [, child] = entries[i]!;
            const isLastChild = i === entries.length - 1;
            if (child.children.size > 0 && !child.isFile) {
                // Directory node (has children, not marked as file)
                renderTreeNode(child, prefix, isLastChild, lines);
            } else {
                // Leaf node (file or empty directory)
                const connector = isLastChild ? "└── " : "├── ";
                lines.push(`${prefix}${connector}${child.name}`);
            }
        }
    }

    const tree = buildTree(allPaths.keys());
    const treeLines: string[] = [];
    if (tree.children.size > 0) {
        renderChildren(tree, "", treeLines);
    } else {
        treeLines.push("(无文件变更)");
    }

    // ── Count by type ─────────────────────────────────────────
    let edits = 0,
        news = 0,
        deletes = 0;
    for (const [fp, type] of allPaths) {
        if (type === "edit") edits++;
        else if (type === "new" || type === "output") news++;
        else if (type === "delete") deletes++;
    }

    return {
        edits,
        news,
        deletes,
        treeText: treeLines.join("\n"),
    };
}

/**
 * Helper: build a human-readable task summary from the prompt.
 * Extracts the first line/type tag from the prompt and produces a clean summary.
 *
 * Examples:
 *   Input:  "[feat] 在 auth 模块中实现用户登录"
 *   Output: "feat - 在 auth 模块中实现用户登录"
 *
 *   Input:  "[fix] 修复 login.ts 中的 401 错误"
 *   Output: "fix - 修复 login.ts 中的 401 错误"
 */
function extractTaskSummary(prompt: string): string {
    const firstLine = prompt.split("\n").find((l) => l.trim()) ?? "";
    // Match [feat] xxx or [fix] xxx or similar
    const tagMatch = firstLine.match(/^\[([^\]]+)\]\s*(.+)/);
    if (tagMatch) {
        const tag = tagMatch[1]!.trim();
        const rest = tagMatch[2]!.trim();
        // If the rest looks like placeholder dots, try to find a better summary
        if (rest.replace(/\.\.\./g, "").trim() === "" || rest === "...") {
            // Try the second line or use the tag as fallback
            const lines = prompt.split("\n").filter((l) => l.trim());
            if (lines.length > 1) {
                const secondLine = lines[1]!.replace(/^[*\s#]+/, "").trim();
                if (secondLine && !secondLine.startsWith("**")) {
                    return `${tag} - ${secondLine.substring(0, 60)}`;
                }
            }
            // Try to find any meaningful content in the prompt
            for (const line of lines.slice(1, 5)) {
                const cleaned = line.replace(/^[*\s#]+/, "").trim();
                if (cleaned && cleaned.length > 5 && !cleaned.startsWith("**") && !cleaned.startsWith("`")) {
                    const summary = cleaned.length > 50 ? cleaned.substring(0, 47) + "..." : cleaned;
                    return `${tag} - ${summary}`;
                }
            }
            return `${tag} - 工作流任务`;
        }
        return `${tag} - ${rest}`;
    }
    // Fallback: first meaningful line (up to 60 chars)
    const cleaned = firstLine.replace(/^[*\s#]+/, "").trim();
    return cleaned.length > 60 ? cleaned.substring(0, 57) + "..." : cleaned || "工作流任务";
}

/**
 * Send a workflow completion message to the session for persistence.
 * Design: 严格要求的完成后的新ui:
 *
 * [dev-workflow-result]
 * [feat - 添加xxx功能]
 *
 * 🎉 工作流全部完成 (6m8s)
 *
 * ✅ 📋 生成实施计划 (1m33s)
 * ✅ 🔧 实施代码 → 审查 (3m20s)
 *
 * 变动文件：
 * ├── extensions
 * │   ├── xxxx1.ts
 * │   ├── xxxx2.ts
 * ├── .pi-dev-output
 * │   ├── pi-plans
 * │   │   └── 20260519-2155-workflow-ui-async-refactor.md
 * ├── tests
 * │   ├── test-workflow-engine.mjs
 *
 * 完成 2/2 步子代理任务，修改 2 个文件，新增 8 个文件
 */
export function sendWorkflowResult(
    pi: ExtensionAPI,
    state: WorkflowWidgetState,
    prompt: string,
    workflowType?: string,
): void {
    const totalDur = formatDurationFull(Date.now() - state.startedAt);
    const doneCount = state.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    const failedCount = state.steps.filter((s) => s.status === "failed").length;
    const total = state.steps.length;

    const resultIcon = state.status === "done" ? "🎉" : state.status === "failed" ? "❌" : "⏹️";
    const statusText = state.status === "done" ? "全部完成" : state.status === "failed" ? "部分失败" : "已取消";

    // Count sub-agent runs (total sub-step executions)
    let subAgentRuns = 0;
    for (const s of state.steps) {
        if (s.subSteps) subAgentRuns += s.subSteps.length;
    }

    // Extract file changes from step states
    const fileChanges = extractFileChanges(state.steps);

    // Build task summary from prompt
    const taskSummary = extractTaskSummary(prompt);

    // Build step summary lines
    const stepSummaryParts: string[] = [];
    for (const s of state.steps) {
        const icon = s.status === "done" ? "✅" : s.status === "failed" ? "❌" : s.status === "skipped" ? "⏭️" : "⬜";
        const durSuffix = s.durationMs != null ? ` (${formatDurationFull(s.durationMs)})` : "";
        const errSuffix = s.status === "failed" && s.error ? ` — ${s.error}` : "";
        stepSummaryParts.push(`${icon} **${s.label}**${durSuffix}${errSuffix}`);
    }

    const body = [
        `[${taskSummary}]`,
        "",
        `${resultIcon} **工作流${statusText}** (${totalDur})`,
        "",
        stepSummaryParts.join("\n"),
        "",
        "变动文件：",
        "```",
        fileChanges.treeText,
        "```",
        "",
        `完成 ${doneCount}/${total} 步子代理任务，修改 ${fileChanges.edits} 个文件，新增 ${fileChanges.news} 个文件` +
            (fileChanges.deletes > 0 ? `，删除 ${fileChanges.deletes} 个文件` : "") +
            (failedCount > 0 ? `，${failedCount} 步失败` : ""),
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
                taskSummary,
                fileChanges: { edits: fileChanges.edits, news: fileChanges.news, deletes: fileChanges.deletes },
                subAgentRuns,
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
    taskSummary?: string,
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
        taskSummary,
    };
}

// ═══════════════════════════════════════════════════════════════
//  Extension factory (no-op — ui-helpers is a helper module)
// ═══════════════════════════════════════════════════════════════

export default function (_pi: ExtensionAPI) {
    // ui-helpers is a helper module, imported by other extensions.
}
