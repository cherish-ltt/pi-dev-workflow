# [fix] Esc 双击确认停止工作流 — 实施计划

## 概述

修复工作流运行期间，一次 Esc 键就立即中断工作流的问题。改为：
- 第一次按 Esc：显示提示 "再次按下 Esc 键，停止 Workflow"
- 两次 Esc 间隔 < 5s 才退出
- 超过 5s 后重置状态，重新监听

**改动范围极小**，只修改 `workflow-engine.ts` 中 `runWorkflow` 函数内的 `onTerminalInput` 回调逻辑。

## 文件清单

### 修改文件
| 文件路径 | 改动描述 | 风险等级 |
|---------|---------|---------|
| `extensions/workflow-engine.ts` | Esc 处理逻辑：增加二次确认、5s 时间窗口、提示显示 | 低 |

### 新增文件
无

### 删除文件
无

## 实施步骤

### 步骤 1：修改 Esc 处理逻辑（二次确认 + 5s 时间窗口）

- **前置条件**：无
- **改动文件**：`extensions/workflow-engine.ts`
- **改动内容**：

定位到 `runWorkflow` 函数末尾的 `onTerminalInput` 回调（当前第 1709-1718 行）：

```typescript
// ── Register terminal input handler (Esc to cancel) ──
if (ctx.hasUI) {
    _terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
        if (!matchesKey(data, Key.escape)) return undefined;
        if (_workflowRunning && _workflowAbortController && !_workflowAbortController.signal.aborted) {
            ctx.ui.notify("⏹️ 用户取消工作流", "warning");
            cancelWorkflow();
            return { consume: true };
        }
        return undefined;
    });
}
```

**改为**（关键改动）：

```typescript
// ── Register terminal input handler (Esc to cancel, with double-press confirmation) ──
if (ctx.hasUI) {
    let _lastEscPressTime = 0;
    _terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
        if (!matchesKey(data, Key.escape)) return undefined;
        if (_workflowRunning && _workflowAbortController && !_workflowAbortController.signal.aborted) {
            const now = Date.now();
            if (_lastEscPressTime > 0 && now - _lastEscPressTime < 5000) {
                // Second Esc press within 5s → confirm cancel
                ctx.ui.notify("⏹️ 正在停止工作流...", "warning");
                cancelWorkflow();
                _lastEscPressTime = 0;
                return { consume: true };
            }
            // First Esc press (or expired) → show hint
            _lastEscPressTime = now;
            ctx.ui.notify("再次按下 Esc 键，停止 Workflow", "warning");
            return { consume: true };
        }
        return undefined;
    });
}
```

- **改动说明**：
  1. 引入 `_lastEscPressTime` 变量（函数块作用域），记录上一次 Esc 按下的时间
  2. 第一次按 Esc → 记录时间并显示提示 "再次按下 Esc 键，停止 Workflow"
  3. 在 5s 内再次按 Esc → 执行取消操作
  4. 超过 5s 后按 Esc → 重置为第一次状态（因为 `_lastEscPressTime > 0` 但差值 >= 5000，被视为过期，走到 `_lastEscPressTime = now` 分支重新计时）

- **验证方式**：
  1. 手动测试：启动工作流，按一次 Esc → 应看到提示，工作流继续
  2. 手动测试：5s 内再按一次 Esc → 工作流取消
  3. 手动测试：按一次 Esc，等待 5s+，再按一次 Esc → 相当于第一次，显示提示
  4. 确保原有取消功能在二次确认后正常运作（清理 widget、保存 checkpoint、归档）
  5. 确保 Esc 在其他非工作流场景的行为不受影响（只修改了 `_workflowRunning` 为 true 时的分支）

### 步骤 2：清理 `_lastEscPressTime` 状态

- **前置条件**：步骤 1 完成
- **改动文件**：`extensions/workflow-engine.ts`
- **改动内容**：

在 `cleanupWidget()` 函数中，确保 `_lastEscPressTime` 在 cleanup 时会被自然重置。但由于 `_lastEscPressTime` 是 `onTerminalInput` 回调闭包内的局部变量，当 `_terminalInputUnsubscribe()` 被调用时，闭包和 `_lastEscPressTime` 都会自然被 GC 回收。

**不需要额外改动**——`cleanupWidget()` 中已有的逻辑：
```typescript
if (_terminalInputUnsubscribe) {
    _terminalInputUnsubscribe();
    _terminalInputUnsubscribe = null;
}
```
已经在工作流结束时正确地解除了监听器注册。下次 `runWorkflow` 被调用时，会新建一个闭包和新的 `_lastEscPressTime` 变量。

- **验证方式**：
  1. 运行工作流，按 Esc 两次确认取消
  2. 确认所有 cleanup 逻辑正确执行
  3. 启动新的工作流，测试 Esc 逻辑从头开始工作

## 依赖关系

- 步骤 2 是验证步骤，不涉及代码改动
- 仅需修改一个函数回调中的逻辑

## 测试策略

1. **人工测试（主要方式）**：
   - 启动一个工作流（如 `/dev-feat` → 快速链式）
   - 按 Esc → 验证显示提示 "再次按下 Esc 键，停止 Workflow"
   - 工作流继续正常运行
   - 5s 内再按 Esc → 工作流取消，widget 消失
   - 重新启动工作流，按 Esc，等 5s+，再按 Esc → 显示提示（重置为第一次）

2. **单元测试** ：
   - 因 `onTerminalInput` 回调直接依赖 `ctx.ui` 和终端环境，不方便做纯单元测试
   - 可考虑在 `tests/` 目录下新增测试文件对回调逻辑进行隔离测试（mock `matchesKey`、`_workflowRunning` 等）

## 注意事项

- **最小改动原则**：只修改 `runWorkflow` 内的 `onTerminalInput` 回调，约 15 行代码
- **性能**：无影响，仅增加一个 `Date.now()` 调用和简单比较
- **并发安全**：`_workflowRunning` 是整个模块级别的标志，`_lastEscPressTime` 是闭包局部变量，不存在竞态问题
- **不要影响其他 Esc 处理**：其他地方的 Esc 处理（如 `uiSelect`、`uiConfirm` 中的 `onEscape` 回调）完全不受影响，它们由不同的 TUI 组件管理
- **不要破坏工作流的正常运行**：第一次 Esc 只是显示提示、不执行任何取消操作，工作流步骤继续执行
- **不要改变 notify 行为**：使用已有的 `ctx.ui.notify()` API，与代码库中其他通知一致
