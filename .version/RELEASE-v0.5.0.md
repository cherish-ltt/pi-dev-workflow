# Release v0.5.0

## 🚀 Features

### 工作流 UUID 溯源与链式上下文传递
- 为每个工作流运行生成唯一 UUID，注入所有子 agent 提示中，实现跨阶段文件关联追溯
- 子 agent 会话名、审查报告文件名、计划文件名均附加 UUID，便于调试和定位
- 新增 **chain context** 机制，将上一阶段输出（实施摘要/审查反馈）自动传递给下一阶段
- docWriter 阶段自动聚合全部变更文件列表
- UI 组件展示工作流 UUID，支持文件关联追溯

### 代理前置元数据（Frontmatter）配置体系
- 为所有 agent（git-agent, 各类 grill agent, review-agent, workflow 子 agent 等）新增标准前置元数据字段：`thinking`、`session`、`session-dir`、`no-context`、`no-extensions`、`mode`、`extra-args`
- 增强子代理 TypeScript 定义以支持新前言字段，并增加解析逻辑
- 新增完整的前置元数据配置参考文档 `.doc/AGENT-FRONTMATTER-REFERENCE.md`

### 自定义 UUID v7 生成器
- 使用时间前缀 + 随机后缀的 UUID v7 方案替换 `crypto.randomUUID()`，提升工作流标识符的唯一性与可排序性

### 代理思维等级属性
- 在 UI 子步骤面板中展示代理的 `thinkingLevel` 属性，增强运行状态可见性

## 🐛 Bug Fixes

### 子代理计时器错误
- 修复：代理完成后正确设置 `durationMs` 并清除 `startedAt`，计时不再持续增长
- 修复：已完成子代理使用记录的 `durationMs`，运行中才使用 live 计时
- 修复：移除父步骤行的计时/超时显示，仅子代理行展示
- 修复：循环组新循环时 `resetWidgetSubStepTimers` 清除上一轮计时数据

## 🔧 Refactor

### 移除 workflow agent 的 tools 白名单
- 移除 `agents/workflow/*-agent.md` 中的 tools 白名单，允许 MCP 工具访问
- `sub-agents.ts`：session 使用完整路径 + `.jsonl`，自动创建目录
- `workflow-engine.ts`：`executeSingleStep` 中捕获链上下文变更摘要
- 新增 `buildReviewTask` 强制 JSON 摘要提示，增强 reviewer 可靠性

### Agent 指令全面增强
- 所有 agent 添加 MCP/SKILL 额外工具说明（措辞更具体化）
- **worker**：合并重复约束，完善自我 review 流程
- **reviewer**：拆分分析代码为独立步骤，补充 `git log`/`git blame` 溯源；添加避免连续错误的思维增强提示
- **docWriter**：禁止为精简而删除原有正确文档

### Planner 步骤顺序调整
- 调整实施计划分析步骤顺序，优化产出质量

## 📦 Files Changed

```
22 files changed, 1140 insertions(+), 65 deletions(-)
```

### New

- `.doc/AGENT-FRONTMATTER-REFERENCE.md` — 代理前置元数据配置参考文档
- `tests/test-workflow-engine-bugs.mjs` — 工作流引擎缺陷回归测试（覆盖链上下文、Agent 元数据、UUID 溯源等场景）

### Modified

- `.gitignore` — 新增 `qa.md` 和 `.pi-dev.output/` 忽略规则
- `README.md` — 版本号更新
- `package.json` — 版本号更新至 v0.5.0
- `agents/*.md`（16 个文件）— 新增前置元数据字段 + 指令增强
- `extensions/sub-agents.ts` — 前置元数据解析、session 路径优化、链上下文支持
- `extensions/ui-helpers.ts` — UUID 展示、计时修正、思维等级显示
- `extensions/workflow-engine.ts` — UUID 生成、链上下文传递、计时修复、工具白名单移除

## 🔗 Commit History

```
bf27a21 feat: 添加代理思维等级属性到工作流子步骤，增强代理状态信息
64fdcb7 feat: 使用自定义 UUID v7 生成器替换随机 UUID，增强工作流唯一性
146261b refactor: 移除 workflow agent 的 tools 白名单，增强 session 路径与链上下文机制
9b0fa0f feat: 添加工作流 UUID 溯源与链式上下文传递机制
774b9d7 refactor(planner): 调整实施计划分析步骤顺序
f3192d1 feat: 增强代理配置并添加前置元数据引用
a04ca78 update version to v0.5.0
ca1259c refactor(agents): 增强 workflow agent 指令（reviewer）
e4e5e70 refactor(agents): 增强 workflow agent 指令（全部子 agent）
b84a729 fix(workflow): 修复子代理计时器错误
```
