

# @ghyper9023/pi-dev-workflow

> Developer workflow toolkit for [pi coding agent](https://pi.dev/): git commands, code review, dev commands, Karpathy guidelines, themes

## 快速安装

```bash
# 通过 npm 安装（推荐）
pi install npm:@ghyper9023/pi-dev-workflow

# 或通过 git 安装
pi install git:github.com/cherish-ltt/pi-dev-workflow
```

然后 `/reload` 热加载即可使用所有功能。
> [!NOTE]
> - 本 pi-package 已移除子代理，不会与其他 pi-package 的子代理功能冲突。
> - 本 pi-package 添加了 `APPEND_SYSTEM.md`，存在默认使用中文等特色设定，可自行修改 `prompts/APPEND_SYSTEM.md`。

## 目录结构

```
pi-package/
├── package.json                     # 包元数据 & pi 配置
├── README.md                        # 本文件
├── .gitignore
├── prompts/
│   ├── APPEND_SYSTEM.md             # 全局追加提示：默认使用简体中文+英文专业名词
│   ├── review-commit.md             # 审查 commit 的提示模板
│   └── review-diff.md              # 审查 diff 的提示模板
├── skills/
│   ├── grill-with-docs/
│   │   └── SKILL.md                 # 方案追问完善：挑战方案、统一术语、更新文档
│   ├── karpathy-guidelines/
│   │   └── SKILL.md                 # Karpathy 编码准则（避免 LLM 常见错误）
│   ├── review-html/
│   │   └── SKILL.md                 # 代码审查 → 输出交互式 HTML 报告
│   └── to-prd/
│       └── SKILL.md                 # 从对话上下文生成 PRD 文档
├── extensions/
│   ├── append-system.ts             # 追加 APPEND_SYSTEM.md 提示词
│   ├── dev-prompts.ts               # dev 命令（/dev-feat、/dev-fix、/dev-refactor、/dev-test）
│   ├── git-commands.ts              # git 命令（直接执行）
│   ├── grill-me-agent.ts            # /grill 与 /prd 命令 + 运行时（运行在当前代理中）
│   ├── pre-check.ts                 # 意图校验（/dev-pre-check + 共享的 confirmIntent）
│   ├── review-detect.ts             # 自动审查意图检测
│   ├── session-utils.ts             # 项目探测、验收标准、轮询等待
│   └── ui-helpers.ts                # TUI 组件构建器（Select/Confirm/Input）
└── themes/
    └── claude-code-theme.json       # Claude Code CLI 风格主题
```

## Themes

| Theme | 说明 |
|---|---|
| **claude-code-theme** | 仿 Claude Code CLI 配色：深色底 + 琥珀金主色 + 紫罗兰辅色 |
| **oh-my-pi-titanium** | 钛金属风格主题 |

## 推荐扩展（第三方）

以下为社区推荐的第三方 Pi 扩展，可按需安装：

| 扩展 | 作用 | 安装 |
|---|---|---|
| **pi-web-access** | 网页搜索、URL 抓取、GitHub 仓库克隆、PDF 提取、YouTube 视频理解与本地视频分析，支持多家搜索/内容服务提供商 | `pi install npm:pi-web-access` |
| **pi-mcp-adapter** | MCP（Model Context Protocol）适配器扩展，让 Pi 接入 MCP 工具生态 | `pi install npm:pi-mcp-adapter`<br>**pi v0.99 起 MCP 已内置（`pi mcp add` / `/mcp`），无需再装此扩展** |
| **rpiv-ask-user-question** | 结构化问卷扩展：模型不确定时以带类型的选项向你提问，替代自由文本回复 | `pi install npm:@juicesharp/rpiv-ask-user-question` |
| **rpiv-todo** | 模型待办清单：实时悬浮面板展示，`/reload` 与会话压缩后依然保留 | `pi install npm:@juicesharp/rpiv-todo` |
| **@plannotator/pi-extension** | 交互式方案评审扩展：带注释的方案审查，可标注 Agent 消息，审查代码/PR | `pi install npm:@plannotator/pi-extension` |
| **pi-permission-system** | 权限管理系统 | `pi install npm:@gotgenes/pi-permission-system` |
| **pi-web** |  pi-web 界面(更直观便捷) | `npm install -g @agegr/pi-web@latest` 使用`pi-web`启动 |
| **billion-context** | 上下文压缩插件：100K 上下文窗口就够用、令牌消耗减少 5 倍、单次会话可连续跑一个月（数十亿令牌）且压缩质量有保障，适用于 pi、OpenCode、Codex、Claude Code 等各类代理 | `pi install npm:billion-context`<br>或用启动器方式：`npm install -g billion-context` 后以 `bili pi` 启动 |
| **termdraw/pi** | 通过 opentui-island 将 termDRAW 嵌入到 Pi 中 | `pi install npm:@termdraw/pi` then in pi agent run `/termdraw` |



## Git 命令

三个命令直接通过 pi 的内置执行器运行 git，结果写入当前会话上下文，不需要隔离的子代理进程。

| 命令 | 说明 |
|---|---|
| `/git-commit [message]` | 暂存所有变更并提交（空信息会让 AI 根据 diff 自动生成 Conventional Commits message） |
| `/git-push` | 推送到远程 |
| `/git-commit-push [message]` | 暂存 + 提交 + 推送一键完成 |

## 意图预检（/dev-pre-check）

在真正动手前插入一道「意图校验」闸门：先让 AI 用自己的话复述它理解的任务意图，**只有你确认正确后才开始执行**。适合需求描述含糊、或希望先对齐理解再让 AI 动代码的场景。

```text
/dev-pre-check 帮我加个邮箱密码登录功能
```

不带参数时弹出输入框补填需求原文。

### 流程

1. **组合提示词** — `用户原始 prompt`（变动）+ 固定的「用自己的话重述你认为用户的目标是什么，以及用户试图解决的问题是什么」指令
2. **只分析不执行** — 提示词把本轮任务意图限定为意图理解：禁止修改/创建/删除文件，禁止调用写入类工具（write、edit、bash 写操作），禁止输出代码/补丁/实施计划，只允许只读探查
3. **输出复述** — 代理按固定格式给出：用户的目标 / 试图解决的问题 / 不确定之处 / 一句话概括
4. **用户确认**

   | 选择 | 行为 |
   |---|---|
   | 是 — 意图正确，开始执行 | 发送「原始 prompt + 已确认的意图复述」开始真正的工作 |
   | 否 — 意图不正确，我要补充说明后重新分析 | 输入修正说明 → 带上修正记录重新复述 → 再次确认（可循环） |
   | 取消 / Esc | 结束，不产生任何改动 |

5. **开始工作** — 已确认的意图复述作为权威前提一并发给代理，与其理解冲突时以该复述为准

### 与其他 dev 命令的关系

`/dev-pre-check` 只做「执行前对齐意图」这一件事，可独立用于任意任务。

`/dev-feat` 等 dev 命令内部复用同一套意图复述指令（`confirmIntent`）：发送提示词前先让你确认意图，但提示词组装、默认验收标准填充由它们自己完成，不依赖 `/dev-pre-check` 命令本身。

## Dev 命令

四个命令对应四类高频任务。**命令参数就是任务原文**，不带参数时才弹一次输入框；其余信息（项目语言、测试命令、lint 命令、pre-commit/CI）由项目探测自动补齐。

| 命令 | 用途 | 提示词中的身份 |
|------|------|---------------|
| `/dev-feat` | 新功能实现 | 资深 <项目语言> 工程师 |
| `/dev-fix` | 问题修复 | 资深 <项目语言> 调试工程师 |
| `/dev-refactor` | 重构 | 资深 <项目语言> 工程师 |
| `/dev-test` | 测试补充 | 资深测试工程师 |

### 流程

```text
/dev-feat 实现邮箱密码登录接口
   │
   ├─ 1. 任务原文：取命令参数，或弹一次必填输入框
   ├─ 2. 意图确认：代理复述「目标 / 问题 / 不确定之处」，你确认
   │      选「否」→ 输入补充说明 → 重新复述（可循环）
   │      取消 / Esc → 不产生任何改动
   ├─ 3. 组装提示词（见下）
   └─ 4. 发送给当前代理执行
```

### 提示词结构

组装出的提示词只补两件事：AI 的身份与职责、未说明验收标准时的默认收尾验收标准。任务目标直接取第 2 步已确认的意图，这里不再重新解释需求。

```markdown
[dev-feat] 实现邮箱密码登录接口

## 任务（原始描述）
实现邮箱密码登录接口

## 已确认的任务意图
（第 2 步你确认过的复述原文）

## 身份与职责
你是资深 TypeScript 工程师。
- 先读代码库再动手：给出逐步实施计划……
- 只实现任务要求的功能，不顺手重构无关代码
- 保持现有公共 API 兼容，不为假设性需求添加抽象层

## 验收标准
以下为默认收尾验收基线；任务描述中另有明确验收标准时，以任务描述为准。
- 运行 pnpm test 确认全部测试通过、无回归
- 运行 pnpm lint 符合代码规范
- 通过本地 pre-commit 钩子检查
- 通过 CI 检查
```

### 示例

```text
/dev-fix 登录接口在密码正确时返回 401
   ↓ 代理复述目标与问题
   ↓ 你确认
   ↓ 发送：任务 + 已确认意图 + 调试工程师职责 + 默认验收标准
```

```text
/dev-refactor
任务描述？ 把 src/auth/login.ts 拆成参数校验和会话创建两部分
   ↓ 同上（不带参数时弹一次输入框）
```

> 早期版本的 `dev-doc`、`dev-perf`、`dev-style`、`dev-security`、`dev-chore`、`dev-explain`、`dev-compare` 已删除：它们的模板与 `/dev-feat`、`/dev-fix` 差异很小，维护成本高于收益；同类任务直接用 `/dev-feat` 或 `/dev-refactor` 描述清楚即可。
> 需要先打磨方案再动手用独立的 `/grill`，需要先出 PRD 用独立的 `/prd`。

## 方案追问完善（/grill）

Grill（"追问式打磨"）是提交方案前由 AI 从多个维度追问完善设计的交互流程，现在是一个独立命令，不再挂在 `/dev-*` 后面。

```text
/grill 实现邮箱密码登录：注册、登录、会话保持
```

不带参数时弹一次输入框。

流程：
1. **确认** — 弹出对话框，选择"是"进入追问完善
2. **生成问题** — 当前代理根据方案上下文，一次生成全部追问问题（JSON 数组）
3. **逐题回答** — TUI 逐题展示，每道题带选项列表 + 自定义输入入口
4. **增强提示词** — 所有 Q&A 追加到原方案末尾，形成 `enhancedPrompt`，发送给当前代理执行

若在第 1 步选"否"，或过程中按 Esc 取消，都不会发送任何内容。

由于当前主流模型普遍具备 >=1M 上下文窗口，Grill 不再创建隔离的子代理进程，而是由**当前代理**执行追问任务，所有追问记录直接追加到当前会话上下文中。

### 交互形式

每道问题在 TUI 中以 SelectList 呈现：
- 选项列表：`(a) ...` `(b) ...` `(c) ...`（完整显示，不截断）
- 最末选项：`✏️ 自定义输入` — 可输入自己的回答
- 导航：↑↓ 选择，Enter 确认
- 返回：`Ctrl+Shift+←` 返回上一题（输入框中也可用 `Ctrl+Shift+←` 返回上一步）
- 跳过：`Ctrl+Shift+→` 在输入框中跳过当前输入并继续
- 取消：Esc 取消全部追问
- 进度：标题栏显示 `问题 3/18`

### 输入框特性

追问的自定义输入框与 dev 命令的任务描述输入框支持：
- **实时换行预览**：输入超长文本时，输入框上方会显示完整的换行预览（灰色文字），实时跟随输入变化
- **光标操作**：`←` 和 `→` 键可正常移动光标编辑已有内容（不触发返回）
- **返回上一题**：`Ctrl+Shift+←` 在输入框中返回上一题
- **跳过输入**：`Ctrl+Shift+→` 提交当前内容（可为空）并继续

## PRD 文档生成（/prd）

```text
/prd 支持邮箱密码注册登录，含密码重置
```

不带参数时弹一次输入框。PRD 由当前代理生成：

1. **确认** — 弹出对话框询问是否创建 PRD
2. **生成** — 当前代理读取需求描述 + 代码库理解，按模板生成 Markdown PRD
3. **保存** — 写入 `.pi-dev-output/pi-prd/<module>-<date>.md`
4. **后续操作** — 询问是否立即开始开发：
   - "是" — 将 PRD 作为开发指令发送给当前代理
   - "否" — 仅保存文件，稍后手动引用
   - "✏️ 自定义开发指令" — 输入自定义指令，与 PRD 一起发送

PRD 模板包含：Problem Statement、Solution、User Stories、Implementation Decisions、Testing Decisions、Out of Scope、Further Notes。

从对话上下文生成 PRD 也可以用 `to-prd` skill（`/skill:to-prd`）。

## Skills

| Skill | 来源 | 说明 |
|---|---|---|
| **karpathy-guidelines** | [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) | 基于 Andrej Karpathy 对 LLM 编码陷阱的观察，强调简洁、精准、可验证 |
| **review-html** | 自制 | git diff / commit 审查，输出自包含的交互式 HTML 报告 |
| **grill-with-docs** | [mattpocock/skills](https://github.com/mattpocock/skills) | 方案追问完善 — 挑战方案、统一术语、实时更新 CONTEXT.md 和 ADR |
| **to-prd** | [mattpocock/skills](https://github.com/mattpocock/skills) | 从对话上下文和代码库理解生成 PRD，保存到 `.pi-dev-output/pi-prd/` |

## 自动审查

当用户输入包含 `review`/`审查`/`审阅` 且同时包含 `code`/`代码`/`diff`/`commit`/`html` 等关键词时，会自动弹出模式选择：

| # | 模式 | 行为 |
|---|------|------|
| **1** | 开始审查（阻塞，等待结果） | 在当前代理中运行审查，等待交互式 HTML 报告生成 |
| **2** / Esc | 不是审查（放行给主代理） | 不启动审查，原消息交给当前 AI 处理 |

也支持直接输入 `/skill:review-html` 触发审查。审查结果以交互式 HTML 报告形式写入 `.pi-dev-output/pi-review/html/` 目录。

## 使用方式

### 安装

```bash
# 通过 npm 安装（推荐）
pi install npm:@ghyper9023/pi-dev-workflow

# 或通过 git 安装
pi install git:github.com/cherish-ltt/pi-dev-workflow

# 或从本地目录安装
pi install /path/to/pi-dev-workflow
```

pi 会自动加载包内的 `skills/`、`prompts/`、`extensions/`、`themes/` 内容。
安装后执行 `/reload` 热加载所有变更。

### 包更新

```bash
pi install git:github.com/cherish-ltt/pi-dev-workflow
/reload
```

## 常见问题

**Q: dev 命令问几个问题？**
A: 0 个。任务原文就是命令参数（如 `/dev-feat 实现邮箱密码登录接口`），不带参数时才弹一次必填输入框；语言、测试命令、lint 命令等由项目探测自动补齐。

**Q: dev 命令与 `/dev-pre-check` 是什么关系？**
A: 两者共用同一套意图复述指令（`extensions/pre-check.ts` 中的 `confirmIntent`），但 dev 命令自行组装提示词（身份职责 + 默认验收标准），`/dev-pre-check` 则只负责「复述 → 确认 → 执行」。可单独用 `/dev-pre-check` 校验任意任务，也可直接用 `/dev-feat` 等命令一步到位。

**Q: 验收标准会覆盖我自己写的吗？**
A: 不会。提示词里的验收标准段明确写明「任务描述中另有明确验收标准时，以任务描述为准」，默认条目只是收尾基线。

**Q: `/grill` 和 `/prd` 要在 `/dev-*` 之后运行吗？**
A: 不需要。两者都是独立命令，任何时候都能用：`/grill <方案描述>` 做提交前追问打磨，`/prd <需求描述>` 先生成 PRD。dev 命令不再触发它们。

**Q: `/grill` 中跳过或取消会怎样？**
A: 在确认对话框选"否"或按 Esc 取消，都不会向当前代理发送任何内容。

**Q: 如何自定义 Grill 的问题数量和方向？**
A: 在 `extensions/grill-me-agent.ts` 中修改追问提示词即可控制问题方向和数量。问题数量由 LLM 自主决定（典型 15-40 题）。

**Q: 追问问答是否影响原方案？**
A: 追问问答以「方案追问记录」区块追加到原方案末尾，原方案内容不变。当前代理执行时会同时参考原方案 + 追问中确认的决策。

**Q: Grill 中如何返回上一题？**
A: 使用 `Ctrl+Shift+←` 返回上一题（在选项列表和自定义输入框中均适用）。裸 `←` 键在选项列表中无效果，在输入框中用于光标左移编辑文本。

**Q: 自定义输入框中的键位有哪些？**
A: `Enter` 确认提交，`Esc` 取消返回选项列表，`Ctrl+Shift+←` 返回上一题，`Ctrl+Shift+→` 跳过输入并继续，方向键 `←`/`→` 用于移动光标编辑已有文本。

**Q: `grill-with-docs` skill 和 `/grill` 命令有什么区别？**
A: `grill-with-docs` 是 skill（`/skill:grill-with-docs`），侧重领域术语统一和文档同步（更新 CONTEXT.md、创建 ADR）。`/grill` 侧重方案追问完善，不涉及文档持久化。

**Q: 自动审查可以关闭吗？**
A: 检测到审查意图时选择"2. 不是审查"即可放行原消息给当前代理。如果需要完全关闭，可以在 `extensions/review-detect.ts` 中移除 `pi.on("input")` 的审查拦截逻辑。

**Q: Git 命令需要子代理吗？**
A: 不需要。`/git-commit`、`/git-push`、`git-commit-push` 直接通过 pi 的内置执行器运行 git，结果会出现在当前会话中。

**Q: `/dev-pre-check` 会顺手改代码吗？**
A: 不会。意图校验阶段的提示词明确禁止修改/创建/删除文件、禁止调用写入类工具、禁止输出代码与实施方案。只有你选择「是 — 意图正确，开始执行」后，才会把原始 prompt 作为真正的工作下发。

**Q: `/dev-pre-check` 等不到复述怎么办？**
A: 等待上限为 5 分钟（信号为「代理空闲且本轮产生了新的 assistant 文本」）。超时后弹出「重试 / 取消」供你决定。

**Q: `/dev-pre-check` 会触发 Grill 或 PRD 吗？**
A: 不会。它与 `/grill`、`/prd` 完全独立；dev 命令也只是复用它的意图复述指令，不进入任何额外流程。

**Q: 生成的提示词保存到哪个目录？**
A: dev 命令组装出的提示词会作为用户消息出现在当前会话中（可直接回看）；`/grill` 会把追问记录保存到 `.pi-dev-output/pi-grill/answers/`，生成的问题文件放在 `.pi-dev-output/pi-grill/questions/`。

## License

MIT
