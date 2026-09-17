# @ghyper9023/pi-dev-workflow

> Developer workflow toolkit for [pi coding agent](https://pi.dev/): git commands, code review, Karpathy guidelines, themes, prompt wizards

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
│   ├── APPEND_SYSTEM.md             # 全局追加提示：强制使用简体中文+英文专业名词
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
│   ├── dev-prompts.ts               # 提示词优化向导（/dev-* 命令）
│   ├── git-commands.ts              # git 命令（直接执行）
│   ├── grill-me-agent.ts            # Grill + PRD 运行时（运行在当前代理中）
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
| **pi-mcp-adapter** | MCP（Model Context Protocol）适配器扩展，让 Pi 接入 MCP 工具生态 | `pi install npm:pi-mcp-adapter` |
| **rpiv-ask-user-question** | 结构化问卷扩展：模型不确定时以带类型的选项向你提问，替代自由文本回复 | `pi install npm:@juicesharp/rpiv-ask-user-question` |
| **rpiv-todo** | 模型待办清单：实时悬浮面板展示，`/reload` 与会话压缩后依然保留 | `pi install npm:@juicesharp/rpiv-todo` |
| **@plannotator/pi-extension** | 交互式方案评审扩展：带注释的方案审查，可标注 Agent 消息，审查代码/PR | `pi install npm:@plannotator/pi-extension` |

## Git 命令

三个命令直接通过 pi 的内置执行器运行 git，结果写入当前会话上下文，不需要隔离的子代理进程。

| 命令 | 说明 |
|---|---|
| `/git-commit [message]` | 暂存所有变更并提交（空信息会让 AI 根据 diff 自动生成 Conventional Commits message） |
| `/git-push` | 推送到远程 |
| `/git-commit-push [message]` | 暂存 + 提交 + 推送一键完成 |

## Dev Prompts（提示词优化向导）

基于 [ai提示词优化.md](./ai%E6%8F%90%E7%A4%BA%E8%AF%8D%E4%BC%98%E5%8C%96.md) 中的优质模板，通过交互式问答引导你填写 `[xxx]` 占位符，组装完整的高质量提示词后**直接投递给当前代理执行**。

### 命令一览

| 命令 | 用途 | 对应模板类型 | 支持 Grill |
|------|------|-------------|---------|
| `/dev-feat` | 新功能/创意生成 | `feat` | ✅ |
| `/dev-fix` | 问题排查/错误修正 | `fix` | ✅ |
| `/dev-doc` | 文档生成/总结 | `doc` | ✅ |
| `/dev-refactor` | 重构/优化现有结构 | `refactor` | ✅ |
| `/dev-test` | 测试用例生成 | `test` | ✅ |
| `/dev-perf` | 性能优化 | `perf` | ✅ |
| `/dev-style` | 风格/格式调整 | `style` | ✅ |
| `/dev-security` | 安全审查 | `security` | ✅ |
| `/dev-chore` | 日常维护/自动化 | `chore` | ❌ |
| `/dev-explain` | 概念解释 | `explain` | ❌ |
| `/dev-compare` | 对比评估 | `compare` | ❌ |

### 使用方法

输入任意 `/dev-*` 命令进入向导，按提示逐项填写字段：

```text
# 示例：/dev-feat
📋 /dev-feat — 新功能/创意生成，请逐项填写以下信息（留空跳过对应段落，Esc 取消）

编程语言/框架？ TypeScript
技术栈？ NestJS + Prisma
目标模块/文件名？ src/auth/login.ts
核心功能描述？ 用户可以通过邮箱+密码注册并登录
...
✅ 提示词已组装完成，正在发送给当前代理...
```

**交互规则**：
- **留空（直接回车）** — 该字段标记为「无」，对应的模板段落整段跳过
- **输入「无」** — 与留空效果相同，明确表示不需要该段内容
- **按 Esc** — 随时退出向导，不产生任何输出
- **填写后** — 自动用 `pi.sendUserMessage()` 投递给当前代理，立即开始执行
- 向导会自动将组装好的提示词保存到 `.pi-dev-output/pi-grill/answers/`，中断后可恢复

### 示例 1：用 `/dev-fix` 修 Bug

```text
/dev-fix
文件路径？ src/api/users.ts
行号？ 42
Bug 描述？ 创建用户成功后返回 201，但实际上返回了 500
输入/现象？ POST /api/users 正确参数返回 Internal Server Error
预期行为？ 返回 201 + 用户数据
当前错误？ 500 Internal Server Error
```

组装后的提示词包含：根因诊断 → 修复方案 → 测试复现 → diff 输出。

### 示例 2：用 `/dev-doc` 写文档

```text
/dev-doc
模块/API 名称？ AuthService REST API
目标受众？ 前端开发者和后端集成方
关键信息点？ 注册、登录、刷新 token、登出四个接口的用法
示例语言？ TypeScript, curl
已有材料？ （留空跳过，从零生成）
```

组装后的提示词包含：角色（技术文档工程师）→ 大纲先行 → Markdown 层级文档 → 2 个可运行示例。

### 示例 3：用 `/dev-feat` 走完整流程（含 Grill + PRD）

```text
/dev-feat
编程语言/框架？ TypeScript
技术栈？ Express + PostgreSQL + Redis
目标模块/文件名？ src/api/payments.ts
核心功能描述？ 用户可以通过信用卡或 PayPal 进行一次性支付

→ 填写完成后，弹出确认框：
🔍 设计方案追问完善 — 是否进入方案追问完善 (Grill) 模式？
→ 逐题回答完毕（约 15-25 题），追问记录附加到提示词末尾。

→ 弹出 PRD 确认框：
📋 创建 PRD — 是否为此功能创建 PRD 文档？
→ 选择"是"，PRD 保存到 .pi-dev-output/pi-prd/payments-20260519.md
→ 最终提示词（含追问记录）发送给当前代理开始执行
```

## 方案追问完善（Grill）机制

Grill（"追问式打磨"）是提交方案前由 AI 从多个维度追问完善你的设计的交互流程。Grill 阶段在 `/dev-*` 向导完成后自动触发，以确认对话框询问是否进入追问完善。

由于当前主流模型普遍具备 >=1M 上下文窗口，Grill 不再创建隔离的子代理进程，而是由**当前代理**执行追问任务，所有追问记录直接追加到当前会话上下文中。

追问完善流程：
1. **确认** — 弹出对话框，选择"是"进入追问完善
2. **生成问题** — 当前代理根据方案上下文，一次生成全部追问问题（JSON 数组）
3. **逐题回答** — TUI 逐题展示，每道题带选项列表 + 自定义输入入口
4. **增强提示词** — 所有 Q&A 追加到原提示词末尾，形成 `enhancedPrompt`

### 按领域定制的 Grill 场景

不同的 `/dev-*` 命令使用不同的追问方向，问题维度与任务类型对齐：

| 命令 | Grill 场景 | 追问维度 |
|---|---|---|
| `/dev-feat` | 设计方案追问完善 | 架构、数据流、模块边界、安全、测试策略、性能、可扩展性 |
| `/dev-fix` | Bug 根因追问 | 复现条件、根因推理、修复方案、回归风险 |
| `/dev-doc` | 文档大纲追问完善 | 受众定位、结构安排、示例选择 |
| `/dev-refactor` | 重构方案追问 | 模块边界、API 兼容性、测试策略、迁移风险 |
| `/dev-test` | 测试策略追问 | 覆盖维度、边界条件、模拟策略 |
| `/dev-perf` | 性能优化方案追问 | 基准测试方法、优化方向、回归风险 |

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

自定义输入和 `/dev-*` 向导中的输入框支持：
- **实时换行预览**：输入超长文本时，输入框上方会显示完整的换行预览（灰色文字），实时跟随输入变化
- **光标操作**：`←` 和 `→` 键可正常移动光标编辑已有内容（不触发返回）
- **返回上一题**：`Ctrl+Shift+←` 在输入框中返回上一题
- **跳过输入**：`Ctrl+Shift+→` 提交当前内容（可为空）并继续

## PRD 文档生成

仅 `/dev-feat` 命令在执行完成后自动触发 PRD 生成。其余 `/dev-*` 命令不包含此阶段。

PRD 由当前代理生成，不再使用隔离的子代理进程：

1. **确认** — 弹出对话框询问是否创建 PRD
2. **生成** — 当前代理读取对话上下文 + 代码库理解，按模板生成 Markdown PRD
3. **保存** — 写入 `.pi-dev-output/pi-prd/<module>-<date>.md`
4. **后续操作** — 询问是否立即开始开发：
   - "是" — 将 PRD 作为开发指令发送给当前代理
   - "否" — 仅保存文件，稍后手动引用
   - "✏️ 自定义开发指令" — 输入自定义指令，与 PRD 一起发送

PRD 模板包含：Problem Statement、Solution、User Stories、Implementation Decisions、Testing Decisions、Out of Scope、Further Notes。

如果需要为其他场景生成 PRD，可以手动使用 `to-prd` skill（直接引用 `/skill:to-prd`）。

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

**Q: Grill 阶段可以跳过吗？**
A: 可以。在 Grill 确认对话框中选择"否"即可跳过，原提示词不变直接投递给当前代理。追问过程中按 Esc 也可随时取消，已回答的问题仍会附加到提示词中。

**Q: 所有 `/dev-*` 命令都支持 Grill 吗？**
A: 不是。以下命令支持 Grill：`/dev-feat`、`/dev-fix`、`/dev-doc`、`/dev-refactor`、`/dev-test`、`/dev-perf`。`/dev-chore`、`/dev-style`、`/dev-security`、`/dev-explain`、`/dev-compare` 不包含 Grill 阶段。

**Q: PRD 没有自动生成怎么办？**
A: 只有 `/dev-feat` 会在执行完成后触发 PRD 生成。其他命令不包含此阶段。如果需要为其他场景生成 PRD，可以手动使用 `to-prd` skill（直接引用 `/skill:to-prd`）。

**Q: 如何自定义 Grill 的问题数量和方向？**
A: 在 `extensions/grill-me-agent.ts` 中修改对应 Grill 场景的提示词即可控制问题方向和数量。目前各领域 Grill 的问题数量由 LLM 自主决定（典型 15-40 题）。

**Q: 追问问答是否影响原提示词？**
A: 追问问答以「方案追问记录」区块追加到原提示词末尾，原提示词内容不变。当前代理执行时会同时参考原需求 + 追问中确认的决策。

**Q: Grill 中如何返回上一题？**
A: 使用 `Ctrl+Shift+←` 返回上一题（在选项列表和自定义输入框中均适用）。裸 `←` 键在选项列表中无效果，在输入框中用于光标左移编辑文本。

**Q: 自定义输入框中的键位有哪些？**
A: `Enter` 确认提交，`Esc` 取消返回选项列表，`Ctrl+Shift+←` 返回上一题，`Ctrl+Shift+→` 跳过输入并继续，方向键 `←`/`→` 用于移动光标编辑已有文本。

**Q: `grill-with-docs` skill 和 `/dev-*` 内置的 Grill 有什么区别？**
A: `grill-with-docs` 是可独立调用的 skill（`/skill:grill-with-docs`），侧重领域术语统一和文档同步（更新 CONTEXT.md、创建 ADR）。`/dev-*` 内置的 Grill 是任务向导的一部分，侧重方案追问完善，不涉及文档持久化。

**Q: 自动审查可以关闭吗？**
A: 检测到审查意图时选择"3. 不是审查"即可放行原消息给当前代理。如果需要完全关闭，可以在 `extensions/dev-prompts.ts` 中移除 `pi.on("input")` 的审查拦截逻辑。

**Q: Git 命令需要子代理吗？**
A: 不需要。`/git-commit`、`/git-push`、`git-commit-push` 直接通过 pi 的内置执行器运行 git，结果会出现在当前会话中。

**Q: 提示词保存到哪个目录？**
A: 向导组装的提示词保存到 `.pi-dev-output/pi-grill/answers/`，Grill 生成的问题文件保存到 `.pi-dev-output/pi-grill/questions/`。中断后重新执行对应命令可从备份恢复。

## License

MIT
