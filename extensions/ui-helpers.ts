/**
 * ui-helpers.ts — Rich TUI component builders for select/confirm/input
 *
 * Wraps ctx.ui.custom() with proper text wrapping, black-background panels,
 * and Ctrl+O expand/collapse support.
 *
 * Provides:
 *   - uiSelect()     — replaces ctx.ui.select() with wrapping
 *   - uiConfirm()    — replaces ctx.ui.confirm() with wrapping
 *   - uiInput()      — replaces ctx.ui.input() with wrapping
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
 * Show an input dialog with proper wrapping and live preview.
 *
 * Features:
 *   - 实时换行预览：输入框上方显示完整的换行预览（跟随输入实时更新）
 *   - 方向键 ←/→ 可正常移动光标编辑已有内容
 *
 * Returns the entered string, or BACK_MARKER on back, or undefined on cancel.
 * When backable=true, supports Ctrl+Shift+← for back and Ctrl+Shift+→ for submit+next.
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
//  Extension factory (no-op — ui-helpers is a helper module)
// ═══════════════════════════════════════════════════════════════

export default function (_pi: ExtensionAPI) {
    // ui-helpers is a helper module, imported by other extensions.
}