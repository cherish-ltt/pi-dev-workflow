# Grill 左方向键冲突与选项描述显示修复 — 实施计划

## 概述

修复 `dc0d3fa9` 提交引入的两个回归问题：

1. **左方向键破坏 Input 光标左移**：`uiInput` 中将裸 `←` 拦截为"返回"，导致所有 `backable=true` 的输入场景中，左方向键的"光标左移"功能完全失效。
2. **Grill 选项截断+description 显示混乱**：选项 label 被截断后，完整文本放入 `description` 字段，但 SelectList 的 description 列不换行，导致用户看到"左边简短被截断 + 右边灰色不换行"的混乱显示。

**用户明确要求**：grill 提问环节的向左返回统一改为 `Ctrl+Shift+←`（与输入式一致），输入式的左方向键恢复为光标左移。

## 根因分析

### Bug 1：左方向键冲突

**问题位置**：`extensions/ui-helpers.ts` 第 263-266 行

`dc0d3fa9` 提交在 `uiInput.handleInput` 中添加了：

```typescript
// 左方向键 → 返回（优先于 Input 的光标左移）
if (backable && matchesKey(data, Key.left)) {
    done(BACK_MARKER);
    return;
}
```

这段拦截在 `input.handleInput(data)` 之前执行，Input 组件永远不会收到左方向键事件，导致：
- Input 内部的 `tui.editor.cursorLeft` 绑定（左方向键）永远不会被触发
- 用户无法在输入框中左移光标
- 影响范围：所有 `backable=true` 的 uiInput 调用（grill 自定义输入、dev-* wizard 输入等）

同时，`extensions/grill-me-agent.ts` 第 671-674 行的 `showQuestionTUI.handleInput` 也拦截了左方向键：

```typescript
// 左方向键 → 返回上一题
if (backable && currentIndex > 1 && matchesKey(data, Key.left)) {
    done("__BACK__");
    return;
}
```

两处拦截叠加，用户按 `←` 时：
- 在 SelectList 中 → 返回上一题（正确，因为 SelectList 不处理 left 键）
- 在 Input 中 → 返回上一题（错误，期望光标左移）

### Bug 2：选项截断+description 显示混乱

**问题位置**：`extensions/grill-me-agent.ts` 第 602-618 行

```typescript
const MAX_OPTION_LABEL = 50;
const truncated = truncateToWidth(label, MAX_OPTION_LABEL, "...");
return {
    value: `opt-${i}`,
    label: truncated,
    description: truncated !== label ? opt : undefined,
};
```

SelectList 的渲染流程：
1. `renderItem` 对 `label` 使用 `truncateToWidth` 到主列宽度（截断为 50 字符 + "..."）
2. 如果 `description` 存在，使用两列布局，description 列也被 `truncateToWidth` 到剩余宽度

当终端宽度不足以显示完整的 description 文本时，description 列也会被截断且**不换行**，产生用户看到的"左边截断 + 右边灰色不换行"效果。

## 修复方案

### 方案（根据用户建议）

**核心思路**：统一使用 `Ctrl+Shift+←` 作为返回键，恢复裸 `←` 的光标左移功能。

**详细改动**：

| 位置 | 当前行为（`dc0d3fa9`） | 修复后行为 |
|------|----------------------|-----------|
| `grill-me-agent.ts` handleInput | 裸 `←` 拦截为返回 | `Ctrl+Shift+←` 拦截为返回 |
| `ui-helpers.ts` uiInput handleInput | 裸 `←` 拦截为返回（破坏光标左移） | 移除裸 `←` 拦截 |
| `ui-helpers.ts` uiInput handleInput | `Ctrl+Shift+←` 返回（保留） | 保留 `Ctrl+Shift+←` |
| 选项列表（SelectList） | 用户按 `←` → 返回上一题 | 用户按 `Ctrl+Shift+←` → 返回上一题 |
| 输入框（Input） | 用户按 `←` → 返回上一题 ❌ | 用户按 `←` → 光标左移 ✅ |
| 输入框（Input） | 用户按 `Ctrl+Shift+←` → 返回上一题 | 保留 |

**Bug 2 修复**：直接移除截断+description 方案，恢复完整 label 显示。

## 文件清单

### 修改文件

| 文件路径 | 改动描述 | 风险等级 |
|---------|---------|---------|
| `extensions/ui-helpers.ts` | `uiInput.handleInput` 中移除裸 `←` 拦截（第 263-266 行）；更新 JSDoc 注释 | 低 |
| `extensions/grill-me-agent.ts` | 1. `showQuestionTUI.handleInput` 中 `Key.left` → `Key.ctrlShift("left")` 2. 更新 hint 文案 3. 移除选项截断+description 方案，恢复完整 label | 低 |

### 无新增/删除文件

## 实施步骤

### 步骤 1：修复 `ui-helpers.ts` — 移除 uiInput 中的裸 ← 拦截

- **前置条件**：无
- **改动文件**：`extensions/ui-helpers.ts`
- **改动内容**：

**a) 删除裸 ← 拦截（约第 263-266 行）**

删除以下代码块：

```typescript
// 左方向键 → 返回（优先于 Input 的光标左移）
if (backable && matchesKey(data, Key.left)) {
    done(BACK_MARKER);
    return;
}
```

保留 `Ctrl+Shift+←` 和 `Ctrl+Shift+→` 拦截不受影响。

**b) 更新 JSDoc 注释（约第 220 行）**

将：

```
 * When backable=true, supports ← for back, Ctrl+Shift+← for back, and Ctrl+Shift+→ for submit+next.
```

改为：

```
 * When backable=true, supports Ctrl+Shift+← for back and Ctrl+Shift+→ for submit+next.
```

- **验证方式**：
  - 运行 `/dev-feat` → 进入"核心功能描述"输入框 → 按 `←` → 确认光标左移
  - 按 `Ctrl+Shift+←` → 确认返回上一题
  - 按 `Ctrl+Shift+→` → 确认跳过并继续

### 步骤 2：修复 `grill-me-agent.ts` — 选项列表 ← 改为 Ctrl+Shift+←

- **前置条件**：步骤 1 完成
- **改动文件**：`extensions/grill-me-agent.ts`
- **改动内容**：

**a) 修改 handleInput 中的左方向键拦截（约第 671-674 行）**

当前：

```typescript
// 左方向键 → 返回上一题（SelectList 不处理 left 键，需自行拦截）
if (backable && currentIndex > 1 && matchesKey(data, Key.left)) {
    done("__BACK__");
    return;
}
```

改为：

```typescript
// Ctrl+Shift+← → 返回上一题（SelectList 不处理该键，需自行拦截）
if (backable && currentIndex > 1 && matchesKey(data, Key.ctrlShift("left"))) {
    done("__BACK__");
    return;
}
```

**b) 修改 hint 提示文字（约第 660 行）**

当前：

```typescript
const hint = backable && currentIndex > 1
    ? "  ↑↓ 导航 • Enter 选择 • ← 返回上一题 • Esc 取消全部评审"
    : "  ↑↓ 导航 • Enter 选择 • Esc 取消全部评审";
```

改为：

```typescript
const hint = backable && currentIndex > 1
    ? "  ↑↓ 导航 • Enter 选择 • Ctrl+Shift+← 返回上一题 • Esc 取消全部评审"
    : "  ↑↓ 导航 • Enter 选择 • Esc 取消全部评审";
```

- **验证方式**：
  - 运行 `/dev-fix` → 进入 grill 评审
  - 在第二个问题按 `←` → 确认**无反应**（正确，SelectList 不处理 left 键）
  - 按 `Ctrl+Shift+←` → 确认返回到第一个问题
  - 确认第一个问题选择的答案被保留

### 步骤 3：修复 `grill-me-agent.ts` — 移除选项截断+description 方案

- **前置条件**：步骤 2 完成
- **改动文件**：`extensions/grill-me-agent.ts`
- **改动内容**：

**a) 修改选项构建逻辑（约第 602-618 行）**

当前代码（`dc0d3fa9` 引入）：

```typescript
const MAX_OPTION_LABEL = 50;
const selectItems: SelectItem[] = q.options.map((opt, i) => {
    const prefix = `(${String.fromCharCode(97 + i)}) `;
    const label = opt === previousAnswer
        ? `${prefix}${opt} - 上次选择`
        : `${prefix}${opt}`;
    const truncated = truncateToWidth(label, MAX_OPTION_LABEL, "...");
    return {
        value: `opt-${i}`,
        label: truncated,
        description: truncated !== label ? opt : undefined,
    };
});
```

恢复为（还原到 `dc0d3fa9` 之前的状态）：

```typescript
const selectItems: SelectItem[] = q.options.map((opt, i) => ({
    value: `opt-${i}`,
    label: opt === previousAnswer
        ? `(${String.fromCharCode(97 + i)}) ${opt} - 上次选择`
        : `(${String.fromCharCode(97 + i)}) ${opt}`,
}));
```

**b) 清理不再需要的 import（文件顶部约第 21-27 行）**

如果 `truncateToWidth` 在文件其他地方没有使用（经 grep 检查仅在步骤 3a 处使用），则删除 import 中的 `truncateToWidth`：

```typescript
// 删除: truncateToWidth,
import {
    Container,
    SelectList,
    Text,
    Spacer,
    matchesKey,
    Key,
    type SelectItem,
} from "@earendil-works/pi-tui";
```

- **验证方式**：
  - 查看 grill 问题的选项 → 确认显示完整标签文本（而不是截断+description 两列显示）
  - 当选项文本超宽时，SelectList 会自动截断到可用宽度（这是 SelectList 的内部行为，不需要手动干预）

## 依赖关系

- 步骤 1 和步骤 2、3 无直接依赖，但建议按顺序 1→2→3 执行，以保证逻辑一致性
- 步骤 3 中需先确认 `truncateToWidth` 是否在其他地方使用，再决定是否清理 import

## 测试策略

手动测试清单：

| 测试场景 | 操作 | 预期结果 |
|---------|------|---------|
| 输入框左方向键 | 在 dev-* 输入框中按 `←` | 光标左移 ✅（修复点） |
| 输入框 Ctrl+Shift+← | 在 dev-* 输入框中按 `Ctrl+Shift+←` | 返回上一题 ✅ |
| 输入框 Ctrl+Shift+→ | 在 dev-* 输入框中按 `Ctrl+Shift+→` | 跳过并继续 ✅ |
| Grill 选项列表 ← | 在 grill 第二题按 `←` | 无反应（SelectList 不处理 left 键）✅ |
| Grill 选项列表 Ctrl+Shift+← | 在 grill 第二题按 `Ctrl+Shift+←` | 返回上一题 ✅（修复点） |
| Grill 自定义输入 ← | 进入自定义输入框按 `←` | 光标左移 ✅（修复点） |
| Grill 自定义输入 Ctrl+Shift+← | 在自定义输入框按 `Ctrl+Shift+←` | 返回选项列表 ✅ |
| Grill 选项完整显示 | 查看长选项文本 | 完整 label 显示 ✅（修复点） |
| 原有功能 | ↑↓ Enter Esc | 正常导航/选择/取消 ✅ |

## 注意事项

- **最小改动**：仅修改 2 个文件中涉及的 4 个代码位置，总计约 10-15 行
- **不修改 pi-tui 库**：所有改动在 extensions/ 目录内完成
- **兼容性**：原有的 `Ctrl+Shift+←` 和 `Ctrl+Shift+→` 功能完全保留，新增的选项列表 `Ctrl+Shift+←` 与输入框保持一致的按键语义
- **SelectList 的 `← 返回上一题` 选项**：注意 `showQuestionTUI` 中还有一个 `"← 返回上一题"` 的 `SelectItem`（第 637 行），这是通过选择选项来返回，而非通过按键。此功能应保留，因为用户也可以通过 ↑↓ 导航到该选项后按 Enter 返回。但需要确认它与 `Key.left` 拦截的分离——按键拦截在 handleInput 中，选项选择在 SelectList 的 onSelect 回调中，两者互不干扰。保留该选项作为额外导航方式。
