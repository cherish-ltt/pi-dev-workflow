# 修复 git diff 解析与循环计数 Bug — 实施计划

## 概述

修复两个 Bug：
1. **git diff 解析**：`f98799d` commit 中将 `getGitDiffChanges()` 的 git diff 解析从正则改为简单的 `split("\t")`，导致无法正确处理非 tab 分隔的输出（如 space-padded 格式），且 agent 输出文本被错误解析为文件路径（如 `checkpoint-${planId}.json`、`[],\t\t\toutputs:`）。
2. **循环计数偏移**：`executeLoopGroup` 中 `loopCount++` 在 reviewer 完成后才执行，导致第二次循环开始时 widget 仍显示旧的 loopCount，造成 "第 1 次循环" 重复出现。

## 文件清单

### 修改文件
| 文件路径 | 改动描述 | 风险等级 |
|---------|---------|---------|
| `extensions/workflow-engine.ts` | 修复 `getGitDiffChanges` 解析逻辑；修复 `loopCount` 更新时机 | 中 |
| `extensions/ui-helpers.ts` | 修复 `buildWidgetLines` 中循环计数的 fallback 逻辑 | 低 |

## 实施步骤

---

### 步骤 1：修复 `getGitDiffChanges` 中 git diff 输出的解析

- **前置条件**：无
- **改动文件**：`extensions/workflow-engine.ts`（函数 `getGitDiffChanges`）
- **改动内容**：

  **问题**：`f98799d` 将原来健壮的正则解析 `/^([MAD])\s+(.+)$/` 改为简单的 `split("\t")`。Git 的 `--name-status` 输出格式在不同环境/版本中可能使用 space-padded 格式（如 `"M       path/to/file"`），此时 `split("\t")` 只能得到 `parts.length === 1`，导致解析失败。结果文件变更不会被检测到。

  **修复方案**：将解析改回使用正则 `^([MAD])\s+(.+)$`，同时保留 tab split 作为后备（兼容两种格式）：

  ```typescript
  // 原来的正则方式（健壮）：
  // git diff --name-status output format: X\tfilepath or "X       filepath"
  const statusMatch = trimmed.match(/^([MAD])\s+(.+)$/);
  if (statusMatch) {
      const status = statusMatch[1]!.trim();
      const filePath = statusMatch[2]!.trim();
      if (filePath && !seen.has(filePath) && (status === "M" || status === "A" || status === "D")) {
          seen.add(filePath);
          changes.push({ status: status as "M" | "A" | "D", path: filePath });
      }
  }
  // 后备：tab split（兼容部分 git 版本输出的 tab 格式）
  else if (trimmed.includes("\t")) {
      const parts = trimmed.split("\t");
      if (parts.length === 2) {
          const status = parts[0]!.trim();
          const filePath = parts[1]!.trim();
          if (filePath && !seen.has(filePath) && (status === "M" || status === "A" || status === "D")) {
              seen.add(filePath);
              changes.push({ status: status as "M" | "A" | "D", path: filePath });
          }
      }
  }
  ```

  同时修复 `git status --porcelain` 部分：当前代码用 `trimmed.slice(0, 2)` 和 `trimmed.slice(3)`，但 `--porcelain` 格式是固定的 2 字符状态码 + 1空格 + path。需要更健壮的处理：

  ```typescript
  // 原来：statusPrefix = trimmed.slice(0, 2); filePath = trimmed.slice(3).trim();
  // 改为正则（更健壮）：
  const statusMatch2 = trimmed.match(/^(..)\s+(.+)$/);
  if (statusMatch2) {
      const statusPrefix = statusMatch2[1]!.trim();
      const filePath = statusMatch2[2]!.trim();
      if (filePath && !seen.has(filePath) && (statusPrefix === "??" || statusPrefix === "A " || statusPrefix.startsWith("A"))) {
          seen.add(filePath);
          changes.push({ status: "A", path: filePath });
      }
  }
  ```

- **验证方式**：手动执行 `git diff --name-status` 验证输出格式，确认正则能够正确解析。

---

### 步骤 2：修复 agent 输出文本刮取逻辑中的脏数据

- **前置条件**：无
- **改动文件**：`extensions/workflow-engine.ts`（函数 `runAgentWithProgress` 中的文本刮取部分）
- **改动内容**：

  **问题**：五个 `filePatterns` 正则过于宽松，会从 agent 的自然语言输出中误匹配脏数据。具体来说：

  1. Pattern `/(?:^|\n)\s*(?:edit|new|delete|read|modify|create|update|add|remove)\s*[:：]\s*([^\n]+\.[a-zA-Z0-9_]+)/gim` 可以匹配 agent 文本中类似：
     - "M   [],\n\t\t\t\toutputs:"（遇到 "M" 不匹配，但 "remove"或其他匹配？不，这个 pattern 需要前面的动词）
     - 实际上，agent 的输出中可能有类似这样的文本：
       ```
       modify: [],\n\t\t\t\toutputs: ...
       ```
     或进度消息中的其他文本片段。

  2. 标记代码块的 pattern `` /`([^`]+\.[a-zA-Z0-9_]+)`/g `` 可能匹配到 `` `checkpoint-xxx.json` `` 或 `` `checkpoint-${planId}.json` `` 这样的模板字符串。

  **修复方案**：在 `filePatterns` 的每个匹配结果后添加更严格的过滤器，排除明显不是文件路径的字符串：

  ```typescript
  // 在 filePath 验证后添加额外过滤
  // 过滤器：排除包含不合法路径字符或模板表达式的字符串
  if (filePath.includes("${") || filePath.includes("\\n") || filePath.includes("\\t")) continue;  // 排除模板字符串和转义字符
  if (filePath.includes("[]") || filePath.includes("{}")) continue;  // 排除数组/对象字面量
  if (filePath.match(/^[\s,;)\]}]+$/)) continue;  // 排除纯符号
  ```

  关键修改位置：`runAgentWithProgress` 函数中，`const filePath = m[1]!.trim()` 之后的验证逻辑块。

- **验证方式**：用包含 `checkpoint-\${planId}.json` 和 `[],\n\t\t\t\toutputs:` 等脏数据的测试文本运行逻辑，确认不会产生误匹配。

---

### 步骤 3：修复循环计数偏移

- **前置条件**：步骤 1 和 2 完成
- **改动文件**：`extensions/workflow-engine.ts`（函数 `executeLoopGroup`）和 `extensions/ui-helpers.ts`（函数 `buildWidgetLines`）
- **改动内容**：

  **根本原因**：`executeLoopGroup` 中的循环计数更新顺序有误。当前的顺序是：

  1. 进入 while 循环（此时 `loopCount` 还未递增）
  2. 重置 sub-step 为 pending
  3. 执行 worker agent
  4. 执行 reviewer agent
  5. `loopCount++` 并 `state.loopCount = loopCount`
  6. 检查是否需要继续循环

  当 reviewer 发现 critical 问题需要再次循环时，`loopCount` 已经在步骤 5 增加为 1，所以在第二次循环开始时 widget 显示的是 "第 1 次循环"（因为 `state.loopCount = 1`），但实际上用户期望看到的是 "第 2 次循环"（即将开始第 2 轮）。

  更准确地说，期望的显示行为是：
  - Pending 时：`第 0 次循环`（表示尚未开始）
  - 第 1 次循环执行中：`第 1 次循环`
  - 第 1 次循环完成，需要第 2 次循环，第二次循环执行中：`第 2 次循环`
  - ...

  **修复方案 A（推荐，最小改动）**：在 while 循环**开始处**（进入新的一轮循环之前）更新 loopCount。

  将 `loopCount++` 和 `state.loopCount = loopCount` 从 reviewer 完成之后**移到 while 循环最开头**。这样：

  ```typescript
  while (loopCount < maxLoops) {
      loopCount++;  // 递增计数，表示"即将开始第 N 次循环"
      state.loopCount = loopCount;
      
      // 立即更新 UI
      updateWidgetStep(stepIndex, step.label, "running", {
          loopCount,
          maxLoops: step.maxLoops,
          startedAt: _widgetSteps[stepIndex]?.startedAt || Date.now(),
      });
      
      // 重置 sub-step 状态
      setWidgetSubStepStatus(stepIndex, step.loopAgentName!, "pending");
      setWidgetSubStepStatus(stepIndex, step.reviewAgentName!, "pending");
      // ... 后续逻辑 ...
  }
  ```

  同时需要移除原来 reviewer 完成后的 `loopCount++` 和 `state.loopCount = loopCount` 部分（在 `if (reviewSummary?.maxSeverity === "critical" ...)` 判断之前）。

  **注意**：由于 `loopCount` 现在从 1 开始递增（而不是原来的从 0 开始，在 reviewer 完成后才 ++），所以需要同步修改 `buildWidgetLines` 中的 fallback 逻辑：

  ```typescript
  // 在 ui-helpers.ts 的 buildWidgetLines 中：
  if (s.maxLoops != null) {
      if (isRunning) {
          // 当 loop-group 开始运行时，loopCount 已经通过 executeLoopGroup 在循环开头设置了，
          // 所以不需要 fallback 显示"第 1 次循环"
          // 直接使用 s.loopCount 的值
          if (s.loopCount == null || s.loopCount === 0) {
              // 安全 fallback（理论上不会走到这里）
              loopStr = dim(theme, ` · 第 1 次循环`);
          }
      } else if (isPending) {
          loopStr = dim(theme, ` · 第 0 次循环`);
      }
  }
  ```

- **验证方式**：
  1. 启动工作流，观察 loop-group 的循环计数显示
  2. 验证第 1 次循环显示 `第 1 次循环`
  3. 当 reviewer 触发再次循环时，验证显示 `第 2 次循环` 而不是 `第 1 次循环`
  4. 验证第 3 次循环显示 `第 3 次循环`

---

### 步骤 4：同步修改 loadCheckpoint 恢复时的循环计数

- **前置条件**：步骤 3 完成
- **改动文件**：`extensions/workflow-engine.ts`（`runWorkflow` 函数中恢复 checkpoint 的逻辑）
- **改动内容**：

  由于 `loopCount` 的语义发生变化（从"已完成次数"变为"当前正在进行的轮次"），需要确保从 checkpoint 恢复时，`loopCount` 能正确恢复。

  当前 checkpoint 中的 `loopCounts[step.id]` 存储的是已完成次数（即原来的语义）。如果 loopCount 现在从 1 开始，则恢复时需要确保：
  
  - 如果 checkpoint 中 `loopCounts[step.id] = 1`（已完成 1 次），恢复后应显示 `第 1 次循环` 但不重新执行已完成的工作。
  
  但检查代码逻辑：checkpoint 恢复时会跳过 `status === "done"` 的步骤，所以 `loopCounts` 只对**未完成**的 loop-group 步骤有效。对于未完成的步骤，`loopCounts` 为 0 或上一次退出时的值。

  **实际上不需要修改**，因为 `loopCounts[step.id]` 只作为 `while` 循环的起始值（`let loopCount = loopCounts[step.id] ?? 0;`）。在步骤 3 中，我们将 `loopCount++` 移到了 while 开头，所以：
  
  - 恢复后 loopCount = previous_loopCount（已完成次数）
  - while 开始执行时立即 ++，变成 previous_loopCount + 1（当前轮次）
  
  这恰好是正确的行为。

- **验证方式**：从 checkpoint 恢复工作流，确认循环计数正确。

---

## 依赖关系

- 步骤 1 和 2 相互独立，可并行实施
- 步骤 3 独立于步骤 1、2
- 步骤 4 依赖步骤 3

## 测试策略

### 单元测试（手动验证）

1. **git diff 解析测试**：
   - 用以下格式模拟 git diff 输出：
     - `M\tpath/to/file.ts`（tab 分隔）
     - `M       path/to/file.ts`（空格分隔，多空格）
     - `A\tnewfile.ts`
     - `D\tdeletedfile.ts`
   - 验证所有格式都能正确解析

2. **文本刮取过滤器测试**：
   - 用以下文本测试 `filePatterns` 匹配：
     - `checkpoint-${planId}.json`
     - `[],\n\t\t\t\toutputs:`
     - `edit: src/main.rs`（应匹配）
     - `I've modified src/main.rs`（应匹配）
     - `try`（不应匹配）
   - 验证过滤器正确排除脏数据

3. **循环计数测试**：
   - 模拟 loop-group 执行流程：
     ```
     pending → 第 0 次循环
     running 第一次循环 → 第 1 次循环
     running 第二次循环 → 第 2 次循环
     running 第三次循环 → 第 3 次循环
     ```
   - 验证显示值正确

### 集成测试

1. 运行一个实际工作流，观察 UI 显示
2. 手动触发 reviewer 发现 bug，观察再次循环时的显示

## 注意事项

1. **最小改动原则**：只修改有 bug 的逻辑，不重构其他部分
2. **向后兼容**：checkpoint 文件格式不变，`loopCounts` 字段语义变化需要确保从旧 checkpoint 恢复时行为正确
3. **git diff 解析**：改回正则解析的同时保留 tab split 后备，兼容多种 git 输出格式
4. **文本刮取**：添加的过滤器不应影响正常文件路径的匹配（如 `src/main.rs`、`extensions/workflow-engine.ts` 等）
