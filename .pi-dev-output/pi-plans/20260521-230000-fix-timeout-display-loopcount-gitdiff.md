# 修复超时时间显示位置、循环次数计数与 git diff 解析 — 实施计划

## 概述

修复三个独立问题：

1. **超时时间显示位置错误**：当前超时时间（如 `超时时间60m`）被显示在步骤主行（step 行），而非子代理行（sub-step 行）。预期行为是 `|__ worker · (52.6s/超时时间60m )`。
2. **循环次数（loopCount）计数不显示**：上次 commit (01413c9) 修改了 loopCount 显示逻辑，导致 loop-group 启动后 `第 1 次循环` 不再显示。原因为 commit 中 `buildWidgetLines` 删除了 `isRunning` 状态下显示循环次数的逻辑，但 `executeLoopGroup` 中的 `updateWidgetStep` 调用在 loopCount 更新后未在 widget UI 上正确体现。
3. **getGitDiffChanges 中 git diff 解析使用正则而非简单 string 拆分**：当前正则 `^([MAD])\s+(.+)$` 在解析 `git diff --name-status` 的输出（格式为 `M\t.gitignore` 或 `M       .gitignore`）时，可能因不匹配制表符而丢失变更。实际输出非常规整，应使用简单的字符串拆分。

## 文件清单

### 修改文件

| 文件路径 | 改动描述 | 风险等级 |
|---------|---------|---------|
| `extensions/ui-helpers.ts` | 修改 `buildWidgetLines` 中的子代理行渲染，在 `status` 图标和 agent 名称后添加 `(当前计时/超时时间Xm)`；恢复步骤行中 `isRunning` 状态下 `loopCount` 的显示逻辑 | 低 |
| `extensions/workflow-engine.ts` | 修改 `getGitDiffChanges` 中 `git diff --name-status` 和 `git status --porcelain` 的解析逻辑，用简单字符串拆分替代正则匹配 | 低 |

## 实施步骤

### 步骤 1：修复子代理行的超时时间显示位置（ui-helpers.ts）

- **前置条件**：无
- **改动文件**：`extensions/ui-helpers.ts`
- **改动内容**：

  **1a. 在 `buildWidgetLines` 的子代理渲染循环中，在 agent 行后添加计时和超时信息。**

  当前子代理行渲染（ui-helpers.ts ~第539行）：
  ```
  lines.push(`${agentIndent}${agentConnector} ${subIcon} ${sub.agent} ·`);
  ```

  需要修改为：
  ```
  let subDurStr = "";
  let subTimeoutStr = "";
  // 计算 sub-step 的当前时长
  if (sub.startedAt) {
    const elapsedMs = Date.now() - sub.startedAt;
    subDurStr = dim(theme, ` (${formatDurationFull(elapsedMs)}`);
  } else if (isSubRunning) {
    subDurStr = dim(theme, ` (0s`);
  }
  // 从 sub.detail 提取超时信息（detail 已在 runAgentWithProgress 中设置为 "超时时间60m"）
  if (sub.detail) {
    subTimeoutStr = dim(theme, `/${sub.detail}`);
  }
  const subDurClose = subDurStr ? dim(theme, ")") : "";
  
  lines.push(`${agentIndent}${agentConnector} ${subIcon} ${sub.agent} ·${subDurStr}${subTimeoutStr}${subDurClose}`);
  ```

  **1b. 步骤行中的超时时间移除/调整**

  当前步骤行（step 行）有 `durStr + timeout + durClose`，对于 loop-group 步骤，`timeoutMs` 在 workflow-engine.ts 中已被设置为 `undefined`（`step.type === "loop-group" ? undefined : step.timeoutMs`），所以步骤行不会显示超时——这部分逻辑保持不变。

  但对于非 loop-group 步骤，步骤行仍显示 `(1m59s/超时时间15m)`，这是正确的行为，无需改动。

  **关键设计决策**：让子代理行显示 `(当前计时/超时时间)`，步骤行对于 loop-group 不显示超时（因为 loop-group 的超时已在子代理级别体现）。

- **验证方式**：运行 `node tests/test-loopcount-timeout-fix.mjs`，确认现有测试全部通过；手动检查 widget 渲染逻辑。

### 步骤 2：修复循环次数（loopCount）显示（ui-helpers.ts）

- **前置条件**：步骤 1 完成
- **改动文件**：`extensions/ui-helpers.ts`
- **改动内容**：

  **2a. 在 `buildWidgetLines` 中，恢复 `isRunning` 状态下显示循环次数的逻辑。**

  当前代码（ui-helpers.ts ~第471行）：
  ```typescript
  if (s.loopCount != null && s.loopCount > 0) {
      loopStr = dim(theme, ` · 第 ${s.loopCount} 次循环`);
  } else if (s.maxLoops != null) {
      // 仅在 pending 时显示"第 0 次循环"
      // running 状态时 loopCount 应由 executeLoopGroup 通过 updateWidgetStep 更新
      if (isPending) {
          loopStr = dim(theme, ` · 第 0 次循环`);
      }
  }
  ```

  这里的问题是：当 loop-group step 处于 `isRunning` 状态且 `loopCount` 已通过 `updateWidgetStep` 设置（如 `loopCount=1`）时，`s.loopCount != null && s.loopCount > 0` 条件应匹配，所以 `第 1 次循环` **应该**显示。但实际运行中，`updateWidgetStep` 在 `executeLoopGroup` 中的调用可能没有被正确触发。

  排查 `executeLoopGroup` 中的代码（workflow-engine.ts ~第1250行）：
  ```typescript
  loopCount++;
  // 立即更新 UI 显示当前循环次数
  state.loopCount = loopCount;
  updateWidgetStep(stepIndex, step.label, "running", {
      loopCount,
      maxLoops: step.maxLoops,
      startedAt: _widgetSteps[stepIndex]?.startedAt || Date.now(),
  });
  ```

  这里 `updateWidgetStep` 被调用时传入了 `"running"` 状态和 `loopCount`。调用 `updateWidgetStep` 会触发 `refreshWidget()`，然后 `buildWidgetLines` 读到的 `s.loopCount` 应为刚刚设置的值（例如 1），因此 `s.loopCount != null && s.loopCount > 0` 应成立，`第 1 次循环` 应显示。

  **根因分析**：问题在于 `updateWidgetStep` 的 `extra` 参数展开覆盖了 step widget state 中的 `loopCount`。在 `updateWidgetStep` 函数中：
  ```typescript
  _widgetSteps[index] = {
      ...existing,
      label,
      status,
      ...extra,
  };
  ```

  这里 `extra` 包含 `{ loopCount, maxLoops, startedAt }`，这会将 `loopCount` 设置到 widget step 上。所以 `s.loopCount` 是有的。理论上代码是正确同步的。

  但实际行为中，`executeLoopGroup` 的 `while` 循环中，**在 `loopCount++` 和 `updateWidgetStep` 执行之前**，reviewer 的 `runAgentWithProgress` 内部调用了 `refreshWidget()`（通过 `setWidgetSubStepStatus`），这意味着在第一次循环中，widget 在 loopCount 更新前被渲染了。但 `updateWidgetStep` 紧随其后就会更新。

  **真正的 bug**：在 `executeLoopGroup` 中，第一次循环的 `updateWidgetStep` 调用在 `loopCount++`（从 0 变为 1）之后。因此第一次循环完成后，`loopCount=1`，这能在 widget 上显示 `第 1 次循环`。但是，**当进入下一轮循环时**，`setWidgetSubStepStatus(stepIndex, step.loopAgentName!, "pending")` 和 `setWidgetSubStepStatus(stepIndex, step.reviewAgentName!, "pending")` 被调用，这些调用触发 `refreshWidget()` 但**不会**更新 `loopCount`，所以 `loopCount` 仍然是上一次循环的值（如 1），所以在第二次循环的 worker 运行时，UI 显示的还是 `第 1 次循环`。

  但实际上，根据需求描述："第 0 次循环只在排队时候显示了，等 loop 组开始工作连第 1 次循环的提示都不见了"。这意味着 **完全看不到循环计数**。

  更可能的原因是：**在 `executeLoopGroup` 中，第一次循环的 `updateWidgetStep` 调用位置不正确**。注意 `executeLoopGroup` 中执行流程：

  1. `while (loopCount < maxLoops)` — 进入循环，`loopCount=0`
  2. 重置 sub-step 为 pending
  3. 运行 worker agent
  4. 运行 reviewer agent
  5. `loopCount++`（变成 1）
  6. `state.loopCount = loopCount;`（设置为 1）
  7. `updateWidgetStep(...)` — 这里设置 `loopCount=1`

  在第 3 步运行 worker 期间，`runAgentWithProgress` 会多次调用 `refreshWidget()`（通过 `setWidgetSubStepStatus`、`addWidgetSubStepTool` 等）。这些 refresh 中，widget step 的 `loopCount` 是 **未定义**（`undefined`）的，因为 `updateWidgetStep` 还未被调用。所以在 worker 运行期间，`buildWidgetLines` 读到 `s.loopCount == null`，只看到 `s.maxLoops != null`，然后因为 `isRunning` 为 true，老的代码逻辑（在 commit 01413c9 之前的代码）会显示 `第 1 次循环`，但 commit 01413c9 删除了这个逻辑——**导致整个 worker/reviewer 运行期间 loopCount 完全不可见**。

  也就是说，在 commit 01413c9 中，这部分代码被删除：
  ```
  -            if (isRunning) {
  -                // Immediately show 第 1 次循环 when loop-group starts
  -                loopStr = dim(theme, ` · 第 1 次循环`);
  -            }
  ```

  移除这个逻辑的意图是"让 `executeLoopGroup` 通过 `updateWidgetStep` 管理 loopCount"。但当 worker/reviewer 运行时（第 3、4 步），`updateWidgetStep` 还未被调用（它在第 7 步才调用），所以 widget 没有 loopCount，也没有显示任何循环计数。

  修复方案：**恢复 `isRunning` 状态下显示 `第 1 次循环` 的逻辑**（当 `s.loopCount` 为 null/undefined 时），或者更精确地说，在 `isRunning` 状态下，如果 `s.loopCount == null` 但 `s.maxLoops != null`，也显示 `第 1 次循环`。

  同时，移除 `isRunning` 状态的限制条件：
  ```typescript
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
  ```

  这样，当子代理刚刚开始运行时，即便 `loopCount` 还未更新，也能立即显示 `第 1 次循环`。

- **验证方式**：运行 `node tests/test-loopcount-timeout-fix.mjs`；阅读修改后的代码确认逻辑正确

### 步骤 3：修复 `getGitDiffChanges` 中的 git diff 解析逻辑（workflow-engine.ts）

- **前置条件**：无
- **改动文件**：`extensions/workflow-engine.ts`
- **改动内容**：

  **3a. 修改 `git diff --name-status` 的解析。**

  当前使用正则：
  ```typescript
  const match = trimmed.match(/^([MAD])\s+(.+)$/);
  ```

  `git diff --name-status` 的实际输出格式为 `M\t.gitignore`（即 `status + 制表符 + 文件路径`）。上面的正则中 `\s+` 可以匹配制表符，**实际上不会有匹配问题**。但是根据用户反馈，正则会"识别出来一些无关东西，判断不出来是哪里来的"。

  更健壮的方案：直接按制表符或空格拆分，取第一个字符为 status，其余为文件路径：
  ```typescript
  // Format: "M\tpath/to/file" (tab-separated) or "M       path/to/file" (spaces)
  const firstSpace = trimmed.indexOf("\t");
  if (firstSpace < 0) {
    // Try multiple spaces
    const statusChar = trimmed[0];
    if (statusChar === "M" || statusChar === "A" || statusChar === "D") {
      const rest = trimmed.slice(1).trim();
      if (rest) {
        changes.push({ status: statusChar as "M" | "A" | "D", path: rest });
      }
    }
  } else {
    const status = trimmed.slice(0, firstSpace).trim();
    const path = trimmed.slice(firstSpace + 1).trim();
    if (status && path && !seen.has(path)) {
      seen.add(path);
      changes.push({ status: status as "M" | "A" | "D", path });
    }
  }
  ```

  **更简单的方案**：由于 `git diff --name-status` 的输出格式保证是 `X\tfilepath\n`，最简单的做法是按 `\t` 拆分：
  ```typescript
  // git diff --name-status 输出格式：X\tfilepath\n
  // 直接按制表符拆分，X 是第一个字符，filepath 是第二部分
  const parts = trimmed.split("\t");
  if (parts.length === 2) {
    const status = parts[0]!.trim();
    const filePath = parts[1]!.trim();
    if (filePath && !seen.has(filePath) && (status === "M" || status === "A" || status === "D")) {
      seen.add(filePath);
      changes.push({ status: status as "M" | "A" | "D", path: filePath });
    }
  }
  ```

  **3b. 修改 `git status --porcelain` 的解析。**

  同理，`git status --porcelain` 的输出格式为 `XY filepath\n`（如 ` M .gitignore`、`?? newfile.ts`、`A  filepath`）。可以用字符串拆分：

  ```typescript
  // git status --porcelain 格式：XY filepath (e.g., " M .gitignore", "?? newfile.ts")
  // 前两个字符是状态，后面的空格分隔，然后是文件路径
  const statusPrefix = trimmed.slice(0, 2); // e.g., "??", " M", "A "
  const filePath = trimmed.slice(3).trim(); // after "?? " or " M "
  if (filePath && !seen.has(filePath) && (statusPrefix === "??" || statusPrefix === "A " || statusPrefix.startsWith("A"))) {
    seen.add(filePath);
    changes.push({ status: "A", path: filePath });
  }
  ```

  **注意**：`git status --porcelain` 的前两个字符格式是固定的 `XY`（X 是 index 状态，Y 是 working tree 状态）。`??` 表示 untracked，`A ` 表示 staged new，` M` 表示 modified in working tree 等。

  但当前代码只关心 "??" 和 "A "（以 "A" 开头），所以直接检查前两个字符即可。

- **验证方式**：运行 `node tests/test-loopcount-timeout-fix.mjs`

## 依赖关系

- 步骤 1、2 修改同一文件（`ui-helpers.ts`），但改动在不同位置，可独立实施
- 步骤 3 修改不同文件（`workflow-engine.ts`），完全独立于步骤 1、2
- 三个步骤可以按任意顺序实施，互不依赖

## 测试策略

- 运行现有测试 `node tests/test-loopcount-timeout-fix.mjs`，确保所有通过
- 手动审查相关代码路径，确认改动正确

## 注意事项

- **超时时间在子代理行的显示**：当前的 `sub.detail` 已在 `runAgentWithProgress` 中设置为 `超时时间60m`（具体为 `` 超时时间${formatTimeout(timeoutMs)} ``）。但要注意，`sub.detail` 的显示位置需要调整——当前逻辑是在 `childItems` 为空时才显示 `sub.detail`，作为子项。需要改为直接在 agent 行末尾显示 `(当前计时/${sub.detail})`。同时需要注意：当 sub-step 有 tools/outputs 时，`sub.detail` 不应再作为子项出现（避免重复）。
- **show detail change**: 当前 `sub.detail` 只在 `childItems.length === 0` 时显示为子项。修改后，`sub.detail` 应被解析为超时信息拼接到 agent 行末尾，而不作为独立的子项。因此需要修改子代理行的渲染逻辑。
- **子代理超时时间的 data flow**: 当前 `runAgentWithProgress` 已在 sub-step 的 `detail` 字段写入 `超时时间60m`。这个 detail 可以直接重用。但需要区分：`detail` 目前既被当做"超时时间文本"使用，也被当做"其他详情文本"（当没有 tools/outputs 时）。修改后，如果 `detail` 包含 "超时时间"，则应解析到 agent 行；否则仍作为普通子项。
- 更简单的做法是：**直接在内置渲染中为 sub-step 添加超时时间字段**，或者将超时时间单独存为一个字段。但为了最小改动，直接利用现有的 `detail` 字段（已在 `runAgentWithProgress` 中设置为 `超时时间60m`），在 agent 行渲染时拼接。
