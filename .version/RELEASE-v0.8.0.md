# Release v0.8.0

> 核心变化：**执行前先对齐意图**。新增 `/dev-pre-check` 意图预检命令；dev 命令从 11 个向导式命令收敛为 4 个「参数即任务 + 意图确认」命令；方案追问（`/grill`）与 PRD 生成（`/prd`）拆分为独立命令，解除与 `/dev-*` 的绑定。

## 🚀 Features

### `/dev-pre-check` 意图预检

在真正动手前插入一道「意图校验」闸门——先让 AI 用自己的话复述任务意图，只有用户确认正确后才开始执行。

- **组合提示词** — `用户原始 prompt`（变动）+ 固定的「用自己的话重述你认为用户的目标是什么，以及用户试图解决的问题是什么」指令，从而把本轮任务意图整体切换为「意图理解」
- **取参方式** — 命令参数优先（`/dev-pre-check 帮我加个登录功能`），不带参数时弹出输入框补填需求原文
- **只分析不执行** — 提示词以最高优先级约束本轮行为：禁止修改/创建/删除文件，禁止调用写入类工具（`write`、`edit`、bash 写操作），禁止输出代码/补丁/实施计划/改进建议，只允许只读探查；复述完成后立即停止
- **结构化复述** — 固定输出格式：`1. 用户的目标` / `2. 用户试图解决的问题` / `3. 不确定之处` / `4. 一句话概括`
- **确认闸门** — 复述产出后弹出三选一：
  - `是 — 意图正确，开始执行` → 发送「原始 prompt + 已确认的意图复述」，进入真正的工作
  - `否 — 意图不正确，我要补充说明后重新分析` → 输入修正说明，带上修正记录重新复述，再次确认（可循环）
  - `取消 / Esc` → 结束，不产生任何改动
- **已确认意图作为权威前提** — 执行阶段把用户确认过的复述一并发给代理，与其自身理解冲突时以该复述为准
- **已完成信号** — 以「代理空闲（`ctx.isIdle()` 为真）且本轮产生了新的 assistant 文本」作为复述完成标志，轮询间隔 2s、上限 5 分钟；不使用 `waitForIdle()`——它可能在 followUp 触发的新 turn 开始前立即返回，导致「瞬间完成」误判（v0.7.0 已记录同类问题）。超时后弹出「重试 / 取消」对话框，不静默失败
- **共享实现** — 「复述 → 确认 →（必要时）修正」抽取为导出的 `confirmIntent()`，dev 命令直接复用，不再各造一套意图识别

### dev 命令重写：11 个 → 4 个，参数即任务

- **命令收敛** — 只保留 `/dev-feat`、`/dev-fix`、`/dev-refactor`、`/dev-test`；移除 `/dev-doc`、`/dev-perf`、`/dev-style`、`/dev-security`、`/dev-chore`、`/dev-explain`、`/dev-compare`（与保留命令的模板差异很小，维护成本高于收益）
- **交互简化** — 2-5 问向导改为「命令参数即任务原文」（`/dev-feat 实现邮箱密码登录接口`），缺省时只弹一次必填输入框
- **执行前先确认意图** — 复用 `confirmIntent()`：代理先复述「目标 / 问题 / 不确定之处」，用户确认后才组装提示词
- **提示词只补两件事** — 「身份与职责」（资深 <项目语言> 工程师 / 调试工程师 / 测试工程师等）与「默认验收标准」；任务目标取第 2 步已确认的意图，不再由命令自行解释需求
- **默认验收标准按条目生成** — `session-utils` 的 `defaultAcceptance` 改为 `defaultAcceptanceItems`，按条目产出测试 / lint / pre-commit / CI 检查项，供提示词逐条列出
- **新增 `uiTaskArg()`** — 命令参数与输入框二选一取任务文本，`/dev-*`、`/grill`、`/prd` 共用
- **删除向导包袱** — 向导字段默认值、模板组装器（`WizardQuestion` / `assignAnswers` / `FIELD_DEFAULTS` / `applyDefaults`）、提示词落盘到 `.pi-dev-output/pi-grill/answers` 的逻辑

### `/grill` 与 `/prd` 成为独立命令

- **`/grill`** — 对方案做追问式打磨（术语精确化、边界条件、失败路径、验证方式），问答结果附到方案后交给当前代理执行
- **`/prd`** — 按需求描述生成 PRD 文档，保存到 `.pi-dev-output/pi-prd/`，并可选直接开始开发
- 两个命令都接受命令参数作为方案/需求文本，缺省时弹一次必填输入框；取消或未进入追问时**不发送任何内容**
- **解除与 dev 的绑定** — dev 命令不再触发 Grill 追问与 PRD 生成，两处运行时各自独立
- 移除仅服务于旧向导断点恢复的 `recoverFromBackup()`

### 全局提示词：思考过程与验证约束

- **新增「思考过程」章节** — 固定六步流程：审题 → 思考 → 汇总 → 验证 → 讨教 → 最终；要求先结论后依据、区分事实/推断/假设、禁止编造，并明确「验证」一步要先假设目标已完成再回推缺口
- 文末三条强调语追加「在最终返回前确认已经遵守了[思考过程]的完整流程」
- **Validation 补充项目约束识别** — 要求查看项目中的 CI、`.pre-commit-check.yaml` 等内容（如有）并完成相关验证
- Language 章节措辞收紧为「用户明确指定其他语种时再切换语言」

### README 同步

- 推荐扩展表新增 `pi-permission-system`、`pi-web`
- 目录树中 `APPEND_SYSTEM.md` 的说明由「强制使用简体中文」修正为「默认使用简体中文」（社区 PR #9）
- dev 命令一节重写为 4 命令设计（参数即任务、流程、提示词结构）；Grill / PRD 改为独立命令 `/grill`、`/prd` 的说明
- 目录树补充 `review-detect.ts`、`session-utils.ts`
- FAQ 重写：交互轮次、与 `/dev-pre-check` 的关系、验收标准优先级、提示词存放位置

## 🐛 Bug Fixes

- 修复 `notify` 类型非法：`"success"` 不在 pi 的 `info` / `warning` / `error` 之列——审查报告通知、`/dev-pre-check` 完成通知、git 命令完成通知均改用 `"info"`；`runGitCommand` 的 ctx 内联类型收窄为同一联合类型，避免同类错误逃过类型检查
- 修复 `ui-helpers` 的 ctx 类型过窄：`pi.on("input")` 处理器拿到的是 `ExtensionContext` 而非 `ExtensionCommandContext`，统一放宽为 `ExtensionContext`

## 🔧 Refactor

- 自动审查检测独立为 `extensions/review-detect.ts`：承载 `pi.on("input")` 审查拦截与 `runReview`；`dev-prompts.ts` 只保留 dev 命令职责，移除 `fs` / `path` 与不再使用的 `uiSelect` / `uiConfirm` 引入
- `extensions/dev-prompts.ts` 由 959 行降至 146 行，清掉向导字段默认值、模板组装器与 Grill/PRD 绑定
- `extensions/session-utils.ts` 验收标准生成接口由拼接字符串改为条目数组
- 测试套件同步：断言指向 4 个 dev 命令与新提示词结构、审查检测迁至 `review-detect.ts`、`/grill` 与 `/prd` 注册、`recoverFromBackup` 已移除、`confirmIntent` 为共享实现

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 新增 | `extensions/pre-check.ts`、`extensions/review-detect.ts` |
| 修改 | `extensions/dev-prompts.ts`、`extensions/git-commands.ts`、`extensions/grill-me-agent.ts`、`extensions/session-utils.ts`、`extensions/ui-helpers.ts`、`prompts/APPEND_SYSTEM.md`、`README.md`、`tests/test-no-subagents.mjs`、`package.json` |
| 版本 | `.version/RELEASE-v0.8.0.md`（本文件） |

## 🔗 Commit History

```
725c605 docs: improve README（社区 PR #9）
53eb82d fix: git 命令完成通知改用合法 notify 类型
7092c95 feat: 添加对项目已有验证约束的识别指导
02aab6b docs: 更新 README 至新 dev 命令设计
97432b6 feat(grill): 新增独立 /grill、/prd 命令，解除与 dev 命令的绑定
7b8311c refactor(dev): dev 命令重写为 4 个命令，参数即任务 + 意图确认
49a5df1 refactor: 自动审查检测独立为 review-detect.ts
d6e035c chore: bump version to 0.8.0
bbb66f2 docs: 更新 README 与 v0.8.0 版本说明
95b1b39 test: 补充 /dev-pre-check 的回归断言
23f7334 feat: 新增 /dev-pre-check 命令，执行前先复述确认任务意图
925b8fc feat: 增加基于事实的思考过程指导，善用“系统 2 ”进行思考，事前验证查找漏洞。
d42a021 Change pi-web-ui to pi-web in README
6e8fe5c Add new extensions to README.md
```
