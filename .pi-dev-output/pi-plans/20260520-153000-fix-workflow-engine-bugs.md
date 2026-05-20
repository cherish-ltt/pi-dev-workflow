# 修复 workflow-engine 中两个 Bug — 实施计划

## 概述

修复 `extensions/workflow-engine.ts` 中的两个 Bug：

1. **Bug A — executeLoopGroup 缺少 exitCode 检查**（第 1179 行）：`executeLoopGroup` 函数在调用 `runAgentWithProgress` 后，只处理了超时（`isTimeoutResult`），但没有检查 sub-agent 非正常退出（exitCode !== 0 且 exitCode !== -1）的情况。对比 `executeSingleStep` 在第 1146 行有显式的 exitCode 检查。这会导致 agent 崩溃或报错时，工作流继续运行 reviewer，产生错误的结果。

2. **Bug B — setTimeout cleanupWidget 竞态条件**（第 1436 行和第 1648 行）：工作流完成或取消后，使用 `setTimeout(() => cleanupWidget(), 5000)` 延迟 5 秒清理 widget。如果用户在这 5 秒内启动新工作流，定时器触发时会调用 `cleanupWidget`，将 `_workflowRunning` 设为 `false` 并清空 `_lastWorkflowCtx`，破坏正在运行的新工作流。

## 根因分析

**Bug A 根因**：`executeLoopGroup` 在 2025 年 3 月的迭代中从 `executeSingleStep` 分支出来，当时只实现了超时处理逻辑（`isTimeoutResult`），但遗漏了通用的 exitCode 非零检查。`executeSingleStep` 在第 1146 行有 `if (result.exitCode !== 0 && result.stderr) { throw new Error(...); }`，但 `executeLoopGroup` 中没有对应逻辑。

**Bug B 根因**：使用延迟 `setTimeout` 进行异步清理是一种脆弱的模式。它假设在定时器超时前不会有新的工作流启动，但用户可能在完成消息查看后立即开始新的工作流。`cleanupWidget` 会无条件重置 `_workflowRunning` 和 `_lastWorkflowCtx` 等全局状态，没有任何保护机制。

## 文件清单

### 修改文件
| 文件路径 | 改动描述 | 风险等级 |
|---------|---------|---------|
| `extensions/workflow-engine.ts` | 修复 Bug A（添加 exitCode 检查）和 Bug B（定时器竞态保护） | 低 |

### 新增文件
| 文件路径 | 用途说明 |
|---------|---------|
| `tests/test-workflow-engine-bugs.mjs` | 复现并验证 Bug A 和 Bug B 的修复 |

## 实施步骤

### 步骤 1：修复 executeLoopGroup 缺少 exitCode 检查（Bug A）

- **前置条件**：无
- **改动文件**：`extensions/workflow-engine.ts`
- **改动位置**：第 1179 行 `let agentResult = await runAgentWithProgress(...)` 之后
- **改动内容**：在 `isTimeoutResult(agentResult)` 判断之前，插入 exitCode 检查。如果 `agentResult.exitCode !== 0` 且 `agentResult.exitCode !== -1`（-1 是超时标记），则根据 mode 分支处理：
  - **full-auto 模式**：直接 `throw new Error(...)`，由上层 `executeWorkflowBackground` 的 catch 块捕获，将步骤标记为 failed。
  - **非 full-auto 模式**：弹出 UI 选择，让用户选择"重新执行"、"跳过此步骤"或"取消工作流"（与超时处理的分支逻辑一致）。
  
  具体代码片段（在 `isTimeoutResult` 检查之前插入）：

  ```typescript
  // 检查 agent 是否异常退出（非超时非零退出码）
  if (result.exitCode !== 0 && !isTimeoutResult(result)) {
    if (mode === "full-auto") {
      throw new Error(`Agent ${step.loopAgentName} 异常退出 (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
    } else {
      const choice = await uiSelect(ctx, `❌ ${step.loopAgentName} 异常退出 (exit ${result.exitCode})`, [
        "1. 重新执行", "2. 跳过此步骤", "3. 取消工作流",
      ]);
      if (!choice || choice.startsWith("3")) { cancelWorkflow(); return; }
      if (choice.startsWith("2")) { state.status = "skipped"; return; }
      // 重新执行
      result = await runAgentWithProgress(loopAgent, `[RETRY]\n\n${loopTask}`, stepIndex, step.loopAgentName!, step.timeoutMs);
    }
  }
  ```

- **验证方式**：运行 `node tests/test-workflow-engine-bugs.mjs` 确认测试通过

### 步骤 2：修复 setTimeout cleanupWidget 竞态条件（Bug B）

- **前置条件**：步骤 1 完成
- **改动文件**：`extensions/workflow-engine.ts`
- **改动位置**：
  1. 第 1436 行：`executeWorkflowBackground` 函数末尾的 `setTimeout(() => cleanupWidget(), 5000);`
  2. 第 1648 行：`cancelWorkflow` 回调中的 `setTimeout(() => cleanupWidget(), 5000);`
- **改动内容**：引入一个模块级别的定时器 ID 变量 `_cleanupTimer: ReturnType<typeof setTimeout> | null`，并在以下两个位置修改：
  
  1. 声明新变量（在全局变量区域，约第 606 行附近）：
     ```typescript
     let _cleanupTimer: ReturnType<typeof setTimeout> | null = null;
     ```
  
  2. 修改第 1436 行的 `setTimeout`：
     ```typescript
     // 清除之前的定时器
     if (_cleanupTimer) clearTimeout(_cleanupTimer);
     _cleanupTimer = setTimeout(() => {
       _cleanupTimer = null;
       cleanupWidget();
     }, 5000);
     ```
  
  3. 修改第 1648 行的 `setTimeout`：
     ```typescript
     if (_cleanupTimer) clearTimeout(_cleanupTimer);
     _cleanupTimer = setTimeout(() => {
       _cleanupTimer = null;
       cleanupWidget();
     }, 5000);
     ```
  
  4. 在 `initWidget` 函数中（约第 639 行）添加清除逻辑，确保新工作流启动时取消旧定时器：
     ```typescript
     if (_cleanupTimer) {
       clearTimeout(_cleanupTimer);
       _cleanupTimer = null;
     }
     ```

  5. 在 `cleanupWidget` 函数中（约第 790 行）添加清除逻辑：
     ```typescript
     if (_cleanupTimer) {
       clearTimeout(_cleanupTimer);
       _cleanupTimer = null;
     }
     ```

- **验证方式**：运行 `node tests/test-workflow-engine-bugs.mjs` 确认测试通过

### 步骤 3：编写测试用例

- **前置条件**：步骤 1 和步骤 2 完成
- **新增文件**：`tests/test-workflow-engine-bugs.mjs`
- **测试内容**：

  **Bug A 测试**：
  - **测试 1**：模拟 `SubagentResult` 对象，验证 `executeLoopGroup` 在收到 `exitCode: 1` 且 `stderr: "some error"` 时的行为
    - 构造 `{ exitCode: 1, stderr: "Agent crashed: OOM", output: "" }`
    - 验证 `isTimeoutResult` 返回 `false`
    - 验证自定义的 simulate 函数能正确识别非零退出码
  - **测试 2**：验证 `executeSingleStep` 已有 exitCode 检查（确认现有行为不被破坏）
  - **测试 3**：验证 `isTimeoutResult` 对 `{ exitCode: -1, stderr: "timed out" }` 返回 `true`（确认超时仍被正确识别）

  **Bug B 测试**：
  - **测试 4**：模拟定时器竞态场景
    - 验证 `initWidget` 被调用时能清除旧的 `_cleanupTimer`
    - 验证 `cleanupWidget` 被调用时能清除 `_cleanupTimer`
    - 验证新工作流启动后，旧定时器不会触发

- **验证方式**：运行 `node tests/test-workflow-engine-bugs.mjs`

## 依赖关系

- 步骤 1 和步骤 2 相互独立，可并行实施
- 步骤 3 依赖步骤 1 和步骤 2 完成

## 测试策略

- **Bug A 单元测试**：通过模拟 `SubagentResult` 对象和 `isTimeoutResult` 函数，验证非零退出码被正确识别和处理
- **Bug B 单元测试**：通过模拟定时器 ID 管理和 `initWidget` 的清理行为，验证竞态条件被消除
- **回归测试**：运行现有测试 `node tests/test-workflow-engine.mjs` 确认无破坏

## 注意事项

1. **最小化改动**：只插入必要的新逻辑，不重构现有代码结构
2. **与 executeSingleStep 保持一致**：Bug A 的修复逻辑应与 `executeSingleStep` 第 1146 行的 exitCode 检查保持一致
3. **定时器清除顺序**：在 `initWidget` 中清除旧定时器必须在设置 `_workflowRunning = true` **之前**完成，确保不会在旧定时器触发和新定时器设置之间出现窗口期
4. **手动确认**：部署后需手动测试快速连续启动两个工作流的场景
