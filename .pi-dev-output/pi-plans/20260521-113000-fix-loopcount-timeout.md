# 修复 Workflow loopCount UI 不同步 & 超时时间分离 — 实施计划

## 概述

修复 workflow-engine.ts 中三个相互关联的 Bug：

1. **loopCount UI 不同步**：`executeLoopGroup()` 在 while 循环中每次迭代后 `loopCount++`，但未调用 `updateWidgetStep()` 更新 widget 状态，导致 widget 中的 `loopStr` 在第 2、3、4 次循环时仍显示"第 1 次循环"。
2. **reviewer 与 loopAgent 共用超时**：`executeLoopGroup()` 中 reviewer 调用 `runAgentWithProgress()` 时传的是 `step.timeoutMs`，未使用独立超时时间。
3. **默认超时值不准确**：worker 应为 30min、trimmer 应为 20min、reviewer 应为 15min。

## 根因分析

### Bug 1: loopCount UI 不同步
- `executeLoopGroup()` (workflow-engine.ts L1197-1270) 中，`loopCount++` (L1243) 之后没有任何 `updateWidgetStep()` 调用。
- 外层的 `executeWorkflowBackground()` 只在步骤完成时（done/failed）调用 `updateWidgetStep()` 更新 `loopCount`，因此中间迭代的 loopCount 从未通知 widget。
- Widget 端 `buildWidgetLines()` (ui-helpers.ts L460-470) 中，`loopStr` 显示逻辑依赖于 `s.loopCount`，且当 `isRunning && s.loopCount == null` 时硬编码显示"第 1 次循环"——这进一步掩盖了问题。

### Bug 2: reviewer 超时未分离
- `WorkflowStepDef` 接口没有 `reviewTimeoutMs` 字段。
- `executeLoopGroup()` L1224 行：`runAgentWithProgress(reviewAgent, reviewTask, stepIndex, step.reviewAgentName!, step.timeoutMs)` — reviewer 和 loopAgent 使用同一个 `step.timeoutMs`。

### Bug 3: 默认超时值不正确
- `dev-prompts.ts` 中所有 `worker` 相关的 loop-group 的 `timeoutMs` 都是 `900_000` (15min)，应为 `1_800_000` (30min)。
- `trimmer` 相关的 loop-group 的 `timeoutMs` 是 `300_000` (5min)，应为 `1_200_000` (20min)。
- reviewer 的独立超时（通过 `reviewTimeoutMs`）应为 `900_000` (15min)。

## 文件清单

### 修改文件
| 文件路径 | 改动描述 | 风险等级 |
|---------|---------|---------|
| `extensions/workflow-engine.ts` | 1) 给 `WorkflowStepDef` 增加 `reviewTimeoutMs` 字段；2) `executeLoopGroup()` 中 loopCount++ 后调用 `updateWidgetStep()`；3) reviewer 调用 `runAgentWithProgress()` 使用 `reviewTimeoutMs`；4) loop-group 行不显示 timeout | 中 |
| `extensions/dev-prompts.ts` | 1) 修改所有 loop-group 的 `timeoutMs` 默认值；2) 为所有 loop-group 添加 `reviewTimeoutMs` 字段 | 低 |
| `extensions/ui-helpers.ts` | 1) `buildWidgetLines()` 中 loop-group 行不显示超时时间；2) sub-step 级别显示各自的超时时间 | 低 |

### 新增文件
| 文件路径 | 用途说明 |
|---------|---------|
| `tests/test-loopcount-timeout-fix.mjs` | 测试 loopCount 同步、reviewer 独立超时、默认值修改 |

## 实施步骤

### 步骤 1：修改 `WorkflowStepDef` 接口，增加 `reviewTimeoutMs` 字段
- **前置条件**：无
- **改动文件**：`extensions/workflow-engine.ts`
- **改动内容**：在 `WorkflowStepDef` 接口中增加可选字段 `reviewTimeoutMs?: number;`（第 49-58 行）
- **验证方式**：TypeScript 编译不报错

### 步骤 2：修改 `dev-prompts.ts` 中所有 loop-group 的默认超时值
- **前置条件**：步骤 1 完成
- **改动文件**：`extensions/dev-prompts.ts`
- **改动内容**：

  1. **FEAT_WORKFLOW_STEPS** (第 369-401 行)
     - `worker-reviewer` 的 `timeoutMs`: `900_000` → `1_800_000`，新增 `reviewTimeoutMs: 900_000`
     - `trimmer-reviewer` 的 `timeoutMs`: `300_000` → `1_200_000`，新增 `reviewTimeoutMs: 900_000`

  2. **FIX_WORKFLOW_STEPS** (第 404-428 行)
     - `worker-reviewer` 的 `timeoutMs`: `900_000` → `1_800_000`，新增 `reviewTimeoutMs: 900_000`

  3. **REFACTOR_WORKFLOW_STEPS** (第 430-456 行)
     - `worker-reviewer` 的 `timeoutMs`: `900_000` → `1_800_000`，新增 `reviewTimeoutMs: 900_000`
     - `trimmer-reviewer` 的 `timeoutMs`: `300_000` → `1_200_000`，新增 `reviewTimeoutMs: 900_000`

  4. **PERF_WORKFLOW_STEPS** (第 458-475 行)
     - `worker-reviewer` 的 `timeoutMs`: `900_000` → `1_800_000`，新增 `reviewTimeoutMs: 900_000`

  5. **TEST_WORKFLOW_STEPS** (第 477-494 行)
     - `worker-reviewer` 的 `timeoutMs`: `900_000` → `1_800_000`，新增 `reviewTimeoutMs: 900_000`

  6. **STYLE_WORKFLOW_STEPS** (第 513-523 行)
     - `trimmer-reviewer` 的 `timeoutMs`: `300_000` → `1_200_000`，新增 `reviewTimeoutMs: 900_000`

- **验证方式**：检查所有 loop-group 配置都有对应的 `reviewTimeoutMs`，超时值符合需求

### 步骤 3：修改 `executeLoopGroup()` 中 reviewer 使用独立超时 + 每次循环后更新 UI
- **前置条件**：步骤 1、2 完成
- **改动文件**：`extensions/workflow-engine.ts`
- **改动内容**（在 `executeLoopGroup` 函数内，约第 1197-1270 行）：

  1. **取出 reviewTimeoutMs**：在 while 循环之前，定义 `const reviewTimeoutMs = step.reviewTimeoutMs ?? step.timeoutMs;`

  2. **修改 reviewer 的超时传递**：将 `runAgentWithProgress(reviewAgent, reviewTask, stepIndex, step.reviewAgentName!, step.timeoutMs)` 改为 `runAgentWithProgress(reviewAgent, reviewTask, stepIndex, step.reviewAgentName!, reviewTimeoutMs)`

  3. **loopCount++ 后立即更新 UI**：在 `loopCount++;`（第 1243 行）之后，添加：
     ```typescript
     // 立即更新 UI 显示当前循环次数
     state.loopCount = loopCount;
     updateWidgetStep(stepIndex, step.label, "running", {
         loopCount,
         maxLoops: step.maxLoops,
         timeoutMs: step.timeoutMs,
         startedAt: step.startTime || Date.now(),
     });
     ```
     注意：`step.startTime` 需要从外部传入或在函数内维护。`executeLoopGroup` 当前没有 `startTime` 参数。需要在 `executeWorkflowBackground` 中（第 1405 行）调用 `updateWidgetStep` 时已传入了 `startedAt`。方案是在 `executeLoopGroup` 中也接收 `startedAt` 或让 loop-group 步骤的 `startedAt` 能通过 `_widgetSteps[stepIndex]` 访问。

     更优的方案：在 `executeLoopGroup` 中直接通过 `_widgetSteps[stepIndex]` 读取 `startedAt`。但模块变量 `_widgetSteps` 是 `workflow-engine.ts` 的私有变量，直接在 `executeLoopGroup` 中引用是合理的（已在同一模块中）。

  4. **还原子步骤的 pending 状态**：在每次循环重新开始前，将 worker/reviewer 的 sub-step 状态重置为 "pending"，以便 UI 显示新的迭代。
     ```typescript
     // 每次循环开始时重置 sub-step 状态
     setWidgetSubStepStatus(stepIndex, step.loopAgentName!, "pending");
     setWidgetSubStepStatus(stepIndex, step.reviewAgentName!, "pending");
     ```

- **验证方式**：运行测试，检查 widget 状态在每次循环后是否正确更新

### 步骤 4：修改 `ui-helpers.ts` 中 loop-group 行的超时显示
- **前置条件**：无
- **改动文件**：`extensions/ui-helpers.ts`
- **改动内容**（在 `buildWidgetLines` 函数中，约第 455-456 行）：

  1. **loop-group 行不显示超时时间**：修改超时显示逻辑，当步骤是 loop-group 类型时跳过 timeout 显示。但由于 `buildWidgetLines` 不直接知道步骤类型，且 `WorkflowStepWidgetState` 中没有 `type` 字段，有两种方案：
     - **方案 A（推荐）**：在 `updateWidgetStep` 调用 loop-group 的 running/done 状态时，不传入 `timeoutMs`（设为 `undefined`），这样 `buildWidgetLines` 中 `s.timeoutMs` 为 `undefined`，`timeout` 字符串为空。
     - **方案 B**：在 `WorkflowStepWidgetState` 中增加 `type` 字段，但需要修改多个地方。

     采用方案 A：`executeLoopGroup` 的 `updateWidgetStep` 调用中不传 `timeoutMs`，而在 worker/reviewer 的 sub-step 级别显示各自的超时。

  2. **sub-step 级别显示超时**：在 sub-step 的 label 行（如 "worker ·" / "reviewer ·"）后面附加超时时间。sub-step 的 `detail` 字段可用于此目的。在 `runAgentWithProgress` 中设置 sub-step 的 `detail` 或通过 `setWidgetSubStepStatus` 扩展接口。

     具体做法：在 `runAgentWithProgress` 初始化 sub-step 时，将超时信息写入 `detail` 字段，例如 `worker · 超时时间30m`。

- **验证方式**：视觉检查 widget 输出，确认 loop-group 行不再显示超时，sub-step 行显示正确

### 步骤 5：修改 `executeWorkflowBackground` 中 loop-group 步骤的 `updateWidgetStep` 调用
- **前置条件**：步骤 4 完成
- **改动文件**：`extensions/workflow-engine.ts`
- **改动内容**：

  在第 1405 行，当步骤类型为 `loop-group` 时，不传入 `timeoutMs`：
  ```typescript
  updateWidgetStep(currentStepIndex, step.label, "running", {
      maxLoops: step.maxLoops,
      startedAt: stepStartTime,
      // loop-group 行不显示 timeoutMs，由子代理 sub-step 显示
  });
  ```

  在 done 状态更新时（第 1418 行），也不传 `timeoutMs`。

- **验证方式**：在 widget 中确认 loop-group 行没有超时显示

### 步骤 6：更新 `runAgentWithProgress` 在 sub-step 中显示超时
- **前置条件**：步骤 4 完成
- **改动文件**：`extensions/workflow-engine.ts`
- **改动内容**：

  修改 `runAgentWithProgress` 函数中初始化 sub-step 的代码（约第 739-758 行），在 sub-step 的 `detail` 字段中写入超时时间。

  由于 `runAgentWithProgress` 没有直接接收超时参数用于 UI 显示，可以在 sub-step 初始化时添加：
  ```typescript
  if (!existing) {
      step.subSteps.push({
          agent: agentName,
          status: "running",
          tools: [],
          outputs: [],
          startedAt: agentStartTime,
          detail: `超时时间${formatTimeout(timeoutMs)}`,
      });
      refreshWidget();
  }
  ```

  注意需要 import `formatTimeout` 到 workflow-engine.ts，或将其从 ui-helpers.ts 导出。

- **验证方式**：widget 中 sub-step 行应显示各自的超时时间

### 步骤 7：导出 `formatTimeout` 供 workflow-engine.ts 使用
- **前置条件**：步骤 6 中的设计决策
- **改动文件**：`extensions/ui-helpers.ts`
- **改动内容**：

  将 `formatTimeout` 函数前面加上 `export`（约第 427 行），使其可被其他模块导入使用。

- **验证方式**：TypeScript 编译通过

### 步骤 8：编写测试文件 `test-loopcount-timeout-fix.mjs`
- **前置条件**：所有代码修改完成
- **改动文件**：`tests/test-loopcount-timeout-fix.mjs`（新增）
- **改动内容**：编写测试覆盖以下场景：
  1. **loopCount 更新测试**：模拟 `executeLoopGroup` 的 while 循环，验证每次 `loopCount++` 后 `updateWidgetStep` 被调用，且传入正确的 `loopCount` 值
  2. **reviewer 独立超时测试**：验证 reviewer 调用 `runAgentWithProgress` 时使用 `reviewTimeoutMs` 而非 `step.timeoutMs`
  3. **默认超时值测试**：静态分析 `dev-prompts.ts` 中所有 loop-group 配置，验证超时值是否符合需求（worker=30min, trimmer=20min, reviewer=15min）
  4. **loop-group 行不显示 timeout 测试**：验证 `updateWidgetStep` 对 loop-group 步骤不传 `timeoutMs`
  5. **sub-step 显示 timeout 测试**：验证 `runAgentWithProgress` 在新 sub-step 的 `detail` 中写入超时信息
  6. **回归测试**：确保原有功能（非 loop-group 步骤的超时显示、完成状态等）不受影响
- **验证方式**：运行 `node tests/test-loopcount-timeout-fix.mjs`

## 依赖关系

- 步骤 1 是步骤 2、3 的前置条件（接口先定义才能使用）
- 步骤 2 是步骤 3 的前置条件（配置中的 `reviewTimeoutMs` 值在步骤 3 中使用）
- 步骤 4、5、6、7 可并行进行设计，但应顺序实施（步骤 4 → 步骤 7 → 步骤 6 → 步骤 5）
- 步骤 8 在所有代码修改完成后进行

## 测试策略

- **单元测试**：通过静态分析源代码模拟函数行为，验证 loopCount 更新逻辑、超时分离逻辑
- **集成测试**：模拟完整的 `executeLoopGroup` 执行流程，检查 widget state 的每个字段
- **回归测试**：运行已有的 `test-workflow-engine.mjs` 和 `test-workflow-engine-bugs.mjs`，确保无破坏
- **手动测试**：在 TUI 中运行 `/dev-fix` 命令，观察 widget 中 loop-count 和超时显示是否正确

## 注意事项

1. **loopCount 初始值**：`executeLoopGroup` 中 `loopCount` 从 `loopCounts[step.id] ?? 0` 开始（第 1199 行）。这意味着第一次循环时 `loopCount` 为 0，在 `loopCount++` 后变为 1。UI 中第一次显示应该是"第 1 次循环"，与现有 `buildWidgetLines` 中的硬编码一致。

2. **`_widgetSteps` 的访问**：`executeLoopGroup` 中需要读取 `_widgetSteps[stepIndex]` 来获取 `startedAt`。由于 `_widgetSteps` 是模块级变量，直接在函数中引用即可。

3. **sub-step 的重置**：每次循环开始时，需要将 worker 和 reviewer 的 sub-step 状态重置为 "pending"，否则 UI 会显示上次循环的已完成状态。这通过 `setWidgetSubStepStatus` 实现。

4. **超时 UI 显示**：根据设计评审第 8 问的决策，loop-group 行不显示超时时间，超时只显示在 sub-step 级别。worker sub-step 显示"超时时间30m"，reviewer sub-step 显示"超时时间15m"。

5. **`WORKFLOW_SUB_STEP_WIDGET_STATE.detail`**：利用现有的 `detail` 字段来显示 sub-step 的超时信息，无需添加新字段。
