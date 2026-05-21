# Grill/Input 文本换行与左方向键返回修复 — 实施计划

## 概述

修复 extensions/ 目录中 grill 和 dev-* 命令的三个 UI 问题：
1. dev-* 命令输入栏和 grill 自定义输入框不会自动换行（单行水平滚动），超长文本被截断
2. grill 提问回答环节的选项（a/b/c...）文字过长时不换行，内容被截断
3. grill 提问回答环节的 ← 左方向键返回上一题功能未实现

## 根因分析

### 问题 1：输入不换行
`ui-helpers.ts` 中的 `uiInput` 函数使用 pi-tui 的 `Input` 组件。该组件是**单行文本输入**，支持水平滚动但不支持换行：`render()` 只输出一行文本，`handlePaste()` 会移除所有换行符。无法通过配置启用多行模式。

### 问题 2：选项不换行
`grill-me-agent.ts` 中的 `showQuestionTUI` 使用 pi-tui 的 `SelectList` 组件显示选项（a/b/c...）。`SelectList.renderItem()` 使用 `truncateToWidth()` 将过长的 label **截断**而非**换行**。SelectList 不支持多行 item 渲染。

### 问题 3：左方向键不生效
`showQuestionTUI` 的 `handleInput` 将键盘事件直接转发给 `selectList.handleInput(data)`。
SelectList 只处理 `tui.select.up/down/confirm/cancel`（分别绑定了 ↑↓ Enter Esc），**不处理 `left` 键**（left 绑定的是 `tui.editor.cursorLeft`）。因此左方向键事件被静默丢弃。

## 文件清单

### 修改文件
| 文件路径 | 改动描述 | 风险等级 |
|---------|---------|---------|
| `extensions/grill-me-agent.ts` | 1. 在 `showQuestionTUI.handleInput` 中拦截左方向键实现返回 2. 对过长选项使用 `description` 字段显示完整文本 3. 新增 import | 低 |
| `extensions/ui-helpers.ts` | 1. `uiInput` 中添加实时换行预览区域 2. `uiInput.handleInput` 中拦截左方向键返回 | 低 |

**不修改**：`@earendil-works/pi-tui` 库（SelectList、Input 组件保持不变）。

## 实施步骤

### 步骤 1：修复 `grill-me-agent.ts` — 左方向键返回 + 选项过长处理

- **改动文件**：`extensions/grill-me-agent.ts`
- **改动内容**：

  **a) 新增 import（文件头部，约第 13~15 行）**
  添加：
  ```typescript
  import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
  ```
  
  **b) `showQuestionTUI` 中拦截左方向键（约第 670 行的 `handleInput`）**
  当前代码仅做 `selectList.handleInput(data)`。左方向键传入 SelectList 后无效果。
  
  修改为：先检查左方向键，若匹配则直接 `done("__BACK__")`，**不转发给 SelectList**：
  ```typescript
  return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
          // 左方向键 → 返回上一题（SelectList 不处理 left 键，需自行拦截）
          if (backable && currentIndex > 1 && matchesKey(data, Key.left)) {
              done("__BACK__");
              return;
          }
          selectList.handleInput(data);
          tui.requestRender();
      },
  };
  ```

  **c) 选项文字过长处理（约第 640 行构建 `selectItems` 处）**
  SelectList 的 `renderItem` 对主列使用 `truncateToWidth` 截断。当选项文本超过主列宽度时，内容不可见。
  
  修改方案：将完整 label **截断到合理长度**，将完整文本放入 `description` 字段。SelectList 在有 description 时会使用两列布局（主列 + description 列），让用户尽可能看到更多内容：
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
          // 只有被截断时才提供 description，展示完整文本
          description: truncated !== label ? opt : undefined,
      };
  });
  ```

  **注意**：`truncateToWidth` 已经是 `@earendil-works/pi-tui` 的导出，可直接 import。

- **验证方式**：
  - 运行 `/dev-fix` → 进入 grill → 在第一个问题上按 ← 键（此时 backable=false，currentIndex=1），不应触发返回
  - 进入第二个问题，按 ← 键，确认返回第一个问题
  - 确认选择了第一个问题的答案后，返回第一个问题，应看到" - 上次选择"标记
  - 对包含长选项文字的问题，确认 label 被截断但 description 列显示完整文本

### 步骤 2：修复 `ui-helpers.ts` — 输入框实时换行预览

- **改动文件**：`extensions/ui-helpers.ts`
- **改动内容**：

  在 `uiInput` 函数的返回对象中（约第 230~245 行），当前的 `handleInput` 仅转发给 `input.handleInput(data)`。修改为：在转发后读取 `input.getValue()`，用 `wrapTextWithAnsi` 换行后更新一个预览 Text 组件。

  完整修改如下（仅修改 `uiInput` 函数的返回部分）：

  ```typescript
  // 在 Input 上方添加预览 Text（约第 215 行，在 input 创建前）
  const previewText = new Text("", 0, 0);
  container.addChild(previewText);
  container.addChild(new Spacer(1));
  // ... 创建 input ...

  // 修改 return 对象中的 handleInput（约第 230 行）
  return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
          // 先让 Input 处理输入（更新内部 value）
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
  ```

  **注意**：
  - `previewText` 的初始状态应为空文本（`""`）
  - 每次按键后，`input.handleInput(data)` 会修改 Input 的内部 value，然后我们立即读取并更新预览
  - 使用 `theme.fg("dim", ...)` 使预览文本颜色较淡，与输入框区分
  - `wrapTextWithAnsi` 已经 import

- **验证方式**：
  - 运行 `/dev-feat` → 在"核心功能描述"输入框输入超过终端宽度的长文本 → 确认上方出现换行预览
  - 按 Backspace 删除字符 → 确认预览实时更新
  - 按 Esc 取消 → 确认预览消失、输入被取消
  - 按 Enter 提交 → 确认正常提交

### 步骤 3：修复 `ui-helpers.ts` — 左方向键返回（自定义输入环节）

- **改动文件**：`extensions/ui-helpers.ts`
- **改动内容**：

  在 `uiInput` 的 `handleInput` 中，**在调用 `input.handleInput(data)` 之前**拦截左方向键。当 `backable=true` 且按下左方向键时，返回 `BACK_MARKER`。

  现有代码中已经支持 `Ctrl+Shift+←` 作为返回键（约第 240~244 行）。现在增加裸的 ← 键支持：

  ```typescript
  handleInput: (data) => {
      // [新增] 左方向键 → 返回（优先于 Input 的光标左移）
      if (backable && matchesKey(data, Key.left)) {
          done(BACK_MARKER);
          return;
      }
      
      // [原有] Ctrl+Shift+← → 返回
      if (backable && matchesKey(data, Key.ctrlShift("left"))) {
          done(BACK_MARKER);
          return;
      }
      // [原有] Ctrl+Shift+→ → 提交并继续
      if (backable && matchesKey(data, Key.ctrlShift("right"))) {
          done(input.getValue() || "");
          return;
      }
      
      // [原有] 转发给 Input 处理
      input.handleInput(data);
      
      // [新增] 更新预览（步骤 2）
      const val = input.getValue();
      if (val.length > 0) {
          const wrapped = wrapTextWithAnsi(val, width - 4);
          previewText.setText(
              wrapped.map(l => theme.fg("dim", `  ${l}`)).join("\n")
          );
      } else {
          previewText.setText("");
      }
      
      tui.requestRender();
  },
  ```

  **关于光标左移的替代方案**：拦截左方向键后，Input 组件中失去光标左移能力。但 pi-tui 的 keybinding 中 `tui.editor.cursorLeft` 同时绑定了 `left` 和 `ctrl+b`（见 keybindings.d.ts），用户可以使用 `Ctrl+B` 替代左方向键进行光标左移。这是合理的权衡。

- **验证方式**：
  - 进入 grill → 选择"自定义输入" → 按 ← 键 → 确认返回到选项列表
  - 在非 grill 场景的普通输入（如 `/dev-feat` 的第一题）中按 ← 键 → 确认整个 wizard 被取消（因为 backable=true 但当前是第一题，返回即取消）
  - 确认 Ctrl+B 在输入框中仍可左移光标

### 步骤 4：更新 hints 文案（可选）

- **改动文件**：`extensions/grill-me-agent.ts`（约第 663~667 行）
- **改动内容**：

  更新 hint 文本，说明左方向键也可用于返回：

  ```typescript
  const hint = backable && currentIndex > 1
      ? "  ↑↓ 导航 • Enter 选择 • ← 返回上一题 • Esc 取消全部评审"
      : "  ↑↓ 导航 • Enter 选择 • Esc 取消全部评审";
  ```

- **验证方式**：检查 grill 问题界面底部提示文字是否正确显示

## 依赖关系

- 步骤 1 与步骤 2、3 无依赖，可并行
- 步骤 3 依赖步骤 2 的代码修改位置（handleInput 中需同时处理左方向键和预览更新）
- 步骤 4 可选，在步骤 1 之后

## 测试策略

手动测试清单：

| 测试场景 | 操作 | 预期结果 |
|---------|------|---------|
| Grill 左方向键返回 | 在 grill 第二个问题按 ← | 返回第一个问题，保留之前的选择 |
| Grill 选项显示 | 包含长选项文字的问题 | label 截断有 ...，description 列显示完整文本 |
| Grill 自定义输入返回 | 选自定义输入后按 ← | 返回到选项列表 |
| dev-* 长文本预览 | 输入超长文本 | Input 上方显示换行后的完整文本预览 |
| 普通 Esc 取消 | 按 Esc | 取消当前操作（不破坏原有功能） |
| 上一步/下一步导航 | 使用 Ctrl+Shift+←/→ | 原有功能不受影响 |
| 非 backable 左方向键 | 普通输入中按 ← | 光标在输入框中左移 |

## 注意事项

- **不修改 pi-tui 库代码**，所有改动在 `extensions/` 目录内完成
- **左方向键拦截**：在 SelectList 环境中，left 键对 SelectList 无意义（SelectList 只用 ↑↓ 导航），拦截 100% 安全。在 Input 环境中，左方向键的"光标左移"功能可用 Ctrl+B 替代
- **预览性能**：每次按键触发 `wrapTextWithAnsi`，对数百字符的输入性能可忽略
- **description 列**：SelectList 的 description 列本身也被 `truncateToWidth` 截断，但两列布局比单列能显示更多内容
