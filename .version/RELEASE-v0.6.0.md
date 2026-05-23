# Release v0.6.0

## 🚀 Features

### 统一超时配置
- docWriter 超时从 5 分钟（300,000ms）延长至 10 分钟（600,000ms），适配大文档生成场景
- reviewer 安全审查步骤超时从 5 分钟调整为 15 分钟（900,000ms），确保安全审查有充分时间

### Planner Agent 指令增强
- 实施计划模板中新增**代码示例**字段，每一步骤可附带可直接运行的 TypeScript/JavaScript 代码块
- 模板新增 `**代码示例**：\`\`\`typescript ... \`\`\`` 章节，worker agent 可直接复制使用

## 🐛 Bug Fixes

### Git 变更识别噪声（文本爬取污染）
**根因**：`runAgentWithProgress()` 使用正则表达式从 AI agent 的自由文本输出中爬取文件路径，将非实际变更的路径（模板名、示例路径）误加到 `_workflowFileChanges`，导致 UI widget 和链上下文摘要中混入"乱 git 内容"。

**修复方案**：彻底移除所有文本爬取逻辑。
- 移除 `filePatterns` 正则数组（5 种模式嗅探）
- 移除 `seenTools` JSON fallback 解析（`tool_use` 事件嗅探）
- 移除 `outputPathPatterns` 多模式数组（review、plan 文件名嗅探）
- 文件变更检测**唯一来源**改为 `git diff --name-status`，与 VSCode、Zed 等专业 git 客户端一致
- `output` 路径展示改用 workflow ID 精准过滤，避免跨运行污染

### `addWidgetSubStepTool()` 冗余污染
- 移除 `addWidgetSubStepTool()` 中对 `_workflowFileChanges.push()` 的调用（该函数不再间接污染文件变更列表）
- `_workflowFileChanges.push` 的调用点缩减为唯一一处：`updateToolsFromGit()` 函数内部

### 链上下文摘要污染
- 移除 `executeSingleStep()` 中基于 `_workflowFileChanges` 的"计划制定摘要"/"文档更新摘要"链上下文创建
- 移除 `executeLoopGroup()` 中基于 `_workflowFileChanges` 的"代码实施摘要"/"代码精简摘要"链上下文创建
- 移除 `executeLoopGroup()` 中的"代码审查反馈"/"精简审查反馈"链上下文创建
- **保留**所有基于 `extractFinalOutput()` 的「工作总结」链上下文条目（AI 稳定输出）

### `updateToolsFromGit` 重复检测与 `.pi-dev-output` 过滤
- 修复 `Set` 去重 key 缺少 `:stepIndex` 后缀的 bug，同文件跨步骤可被正确识别
- 新增 `.pi-dev-output/` 路径过滤，工作流产物（计划、审查报告）不再被上报为用户代码变更

### Agent 文档内容与格式完善
- 所有 workflow agent（worker、planner、reviewer、docWriter、trimmer）补充完整的**工作流程**、**核心约束**、**输出规范**章节
- git-agent 和 review-agent 文档格式统一，内容结构标准化

## 🔧 Refactor

### Grill 系列 Agent 定位重构
将 Grill 系列 agent 从"评审/审查"定位全面改为"追问完善/打磨"定位，涉及 10 个文件：

| 文件 | 改动量 |
| :--- | :--- |
| `agents/grill/dev-grill-agent.md` | 角色从「设计评审专家」改为「方案追问专家」；内化 Socratic 追问方法 + 术语精确化 + 场景压力测试 |
| `agents/grill/dev-doc-grill-agent.md` | 从「文档评审」改为「文档大纲追问」；内化领域感知 + 术语挑战 |
| `agents/grill/dev-fix-grill-agent.md` | 从「Bug 根因评审」改为「Bug 根因追问」；内化追问树 + 代码交叉验证 |
| `agents/grill/dev-perf-grill-agent.md` | 从「性能优化评审」改为「性能优化方案追问」 |
| `agents/grill/dev-refactor-grill-agent.md` | 从「重构方案评审」改为「重构方案追问」 |
| `agents/grill/dev-test-grill-agent.md` | 从「测试计划评审」改为「测试策略追问」 |
| `agents/grill/dev-prd-agent.md` | 角色定位明确为 PRD 撰写，不与追问混淆 |
| `extensions/dev-prompts.ts` | 6 处 UI 提示词（title/description/loaderLabel）从"评审/挑战"改为"追问完善/打磨" |
| `extensions/grill-me-agent.ts` | 全部默认文案从"评审"改为"追问完善"；TUI 导航提示同步更新 |

### 工作流引擎精简
- 移除基于文本嗅探的 tool 检测（~120 行），文件变更检测完全依赖 `git diff`
- 简化 `runAgentWithProgress` 中的 output 路径提取逻辑，使用 `workflowId` 正则
- `updateToolsFromGit` 新增 `seen` 集合修复（stepIndex 区分）、`.pi-dev-output` 过滤

## 📦 Files Changed

```
21 files changed, 637 insertions(+), 516 deletions(-)
```

### Modified

| 文件 | 变更类型 |
| :--- | :--- |
| `.gitignore` | 修改 |
| `agents/git-agent.md` | 修改（文档格式与内容更新） |
| `agents/review-agent.md` | 修改（文档格式与内容更新） |
| `agents/grill/dev-grill-agent.md` | 修改（定位重构为追问完善） |
| `agents/grill/dev-doc-grill-agent.md` | 修改（定位重构为追问完善） |
| `agents/grill/dev-fix-grill-agent.md` | 修改（定位重构为追问完善） |
| `agents/grill/dev-perf-grill-agent.md` | 修改（定位重构为追问完善） |
| `agents/grill/dev-prd-agent.md` | 修改（角色定位更新） |
| `agents/grill/dev-refactor-grill-agent.md` | 修改（定位重构为追问完善） |
| `agents/grill/dev-test-grill-agent.md` | 修改（定位重构为追问完善） |
| `agents/workflow/planner-agent.md` | 修改（模板新增代码示例 + 文档格式更新） |
| `agents/workflow/worker-agent.md` | 修改（文档格式与内容更新） |
| `agents/workflow/reviewer-agent.md` | 修改（文档格式与内容更新） |
| `agents/workflow/docWriter-agent.md` | 修改（文档格式与内容更新） |
| `agents/workflow/trimmer-agent.md` | 修改（文档格式与内容更新） |
| `extensions/dev-prompts.ts` | 修改（超时配置 + UI 提示词更新） |
| `extensions/grill-me-agent.ts` | 修改（定位文案统一更新） |
| `extensions/workflow-engine.ts` | 修改（移除文本爬取 + 链上下文精简 + git diff 过滤） |
| `package-lock.json` | 修改（版本号 0.5.1 → 0.6.0） |
| `package.json` | 修改（版本号 0.5.1 → 0.6.0） |
| `tests/test-workflow-engine-bugs.mjs` | 修改（补充文本爬取移除、git diff 过滤等边界测试） |

## 🔗 Commit History

```
c18382e update version to v0.6.0
f815021 fix: 重构工作流引擎，修复计划器代理逻辑并补充测试用例
b0f759f fix: 精简冗余代码并补充工作流引擎边界测试用例
c30b81a refactor: 将 Grill 系列 agent 从"评审"定位全面改为"追问完善"定位
3c1df92 feat: 优化docWriter的超时时间，从5分钟提示到10分钟
eebf395 docs: 更新所有 agent 文档内容与格式调整
```
