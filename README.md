# @ghyper9023/pi-dev-workflow

> Developer workflow toolkit for [pi coding agent](https://pi.dev/): git agents, code review, Karpathy guidelines, themes, automation workflows

## 快速安装

```bash
# 通过 npm 安装（推荐）
pi install npm:@ghyper9023/pi-dev-workflow

# 或通过 git 安装
pi install git:github.com/cherish-ltt/pi-dev-workflow
```

然后 `/reload` 热加载即可使用所有功能。

## 目录结构

```
pi-package/
├── package.json                     # 包元数据 & pi 配置
├── README.md                        # 本文件
├── .gitignore
├── agents/
│   ├── git-agent.md                 # git-sub-agent 定义（专注 git 操作）
│   ├── review-agent.md              # review-sub-agent 定义（专注代码审查）
│   ├── grill/                       # 设计评审 (Grill) agent 定义
│   │   ├── dev-grill-agent.md       #   通用 /dev-feat Grill agent
│   │   ├── dev-fix-grill-agent.md   #   /dev-fix 根因分析评审
│   │   ├── dev-doc-grill-agent.md   #   /dev-doc 文档大纲评审
│   │   ├── dev-refactor-grill-agent.md
│   │   ├── dev-test-grill-agent.md
│   │   ├── dev-perf-grill-agent.md
│   │   └── dev-prd-agent.md         #   PRD 生成 agent
│   └── workflow/                    # 自动化工作流 agent 定义
│       ├── planner-agent.md         #   计划制定 agent
│       ├── worker-agent.md          #   代码实施 agent
│       ├── reviewer-agent.md        #   代码审查 agent
│       ├── trimmer-agent.md         #   代码精简 agent
│       └── docWriter-agent.md       #   文档撰写 agent
├── prompts/
│   ├── APPEND_SYSTEM.md             # 全局追加提示：强制使用简体中文+英文专业名词
│   ├── review-commit.md             # 审查 commit 的提示模板
│   └── review-diff.md              # 审查 diff 的提示模板
├── skills/
│   ├── grill-with-docs/
│   │   └── SKILL.md                 # 设计评审：挑战方案、统一术语、更新文档
│   ├── karpathy-guidelines/
│   │   └── SKILL.md                 # Karpathy 编码准则（避免 LLM 常见错误）
│   ├── review-html/
│   │   └── SKILL.md                 # 代码审查 → 输出交互式 HTML 报告
│   └── to-prd/
│       └── SKILL.md                 # 从对话上下文生成 PRD 文档
├── extensions/
│   ├── dev-prompts.ts               # 提示词优化向导（/dev-* 命令）
│   ├── git-commands.ts              # git-sub-agent 命令
│   ├── grill-me-agent.ts            # Grill + PRD 运行时：设计评审、PRD 生成
│   ├── sub-agents.ts                # 子代理系统：git-sub-agent + review-sub-agent
│   └── workflow-engine.ts           # 工作流编排引擎（由 dev-prompts.ts 引入）
└── themes/
    └── claude-code-theme.json       # Claude Code CLI 风格主题
```

## Sub-Agents（子代理）

子代理运行在独立的 `pi` 进程中，拥有隔离的上下文窗口，专注处理特定领域任务。

| 子代理 | 触发方式 | 职责 |
|---|---|---|
| **git-sub-agent** | `/git-commit [msg]` / `/git-push` / `/git-commit-push [msg]` | Git 全流程操作 |
| **review-sub-agent** | 自动检测用户提示中的审查意图 | 代码审查、diff 分析 |

### git-sub-agent

在隔离进程中执行 git 操作，支持三种子命令：

| 命令 | 说明 |
|---|---|
| `/git-commit [message]` | 暂存所有变更并提交（空信息让 AI 根据 diff 自动生成 Conventional Commits message） |
| `/git-push` | 推送到远程 |
| `/git-commit-push [message]` | 暂存 + 提交 + 推送一键完成 |

### review-sub-agent

当用户输入包含 review/审查/审阅 + code/代码/diff/commit/html 等关键词时，自动弹出三种模式选择：

| # | 模式 | 行为 |
|---|------|------|
| **1** | 后台审查（非阻塞，异步通知） | 后台运行审查，不阻塞对话，完成后通过消息通知 |
| **2** | 仅审查（阻塞，等待结果） | 等待审查完成才恢复交互 |
| **3** / Esc | 不是审查（放行给主代理） | 不启动子代理，原消息交给主 AI 处理 |

也支持 `/skill:review-html` 直接触发阻塞审查。
审查结果以交互式 HTML 报告形式写入 `pi-review/` 目录。

### subagent 工具

LLM 也可以直接调用 `subagent` 工具委派任务给任意子代理：

```
可用子代理：git-agent, review-agent
```

## Themes

| Theme | 说明 |
|---|---|
| **claude-code-theme** | 仿 Claude Code CLI 配色：深色底 + 琥珀金主色 + 紫罗兰辅色 |

## Dev Prompts（提示词优化向导）

基于 [ai提示词优化.md](./ai%E6%8F%90%E7%A4%BA%E8%AF%8D%E4%BC%98%E5%8C%96.md) 中的优质模板，通过交互式问答引导你填写 `[xxx]` 占位符，组装完整的高质量提示词后直接投递给主代理执行。

### 命令一览

| 命令 | 用途 | 对应模板类型 | 含工作流 |
|------|------|-------------|---------|
| `/dev-feat` | 新功能/创意生成 | `feat` | ✅ |
| `/dev-fix` | 问题排查/错误修正 | `fix` | ✅ |
| `/dev-doc` | 文档生成/总结 | `doc` | ✅ |
| `/dev-refactor` | 重构/优化现有结构 | `refactor` | ✅ |
| `/dev-test` | 测试用例生成 | `test` | ✅ |
| `/dev-perf` | 性能优化 | `perf` | ✅ |
| `/dev-style` | 风格/格式调整 | `style` | ✅ |
| `/dev-security` | 安全审查 | `security` | ✅ |
| `/dev-chore` | 日常维护/自动化 | `chore` | ❌（传统模式） |
| `/dev-explain` | 概念解释 | `explain` | ❌（传统模式） |
| `/dev-compare` | 对比评估 | `compare` | ❌（传统模式） |

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
✅ 提示词已组装完成，正在发送给主代理...
```

**交互规则**：
- **留空（直接回车）** — 该字段标记为「无」，对应的模板段落整段跳过
- **输入「无」** — 与留空效果相同，明确表示不需要该段内容
- **按 Esc** — 随时退出向导，不产生任何输出
- **填写后** — 自动用 `pi.sendUserMessage()` 投递给主代理，立即开始执行

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

### 示例 3：用 `/dev-feat` 走完整流程（含 Grill + 自动化工作流 + PRD）

```text
/dev-feat
编程语言/框架？ TypeScript
技术栈？ Express + PostgreSQL + Redis
目标模块/文件名？ src/api/payments.ts
核心功能描述？ 用户可以通过信用卡或 PayPal 进行一次性支付

→ 填写完成后，弹出确认框：
🔍 设计方案评审 — 是否进入设计评审 (Grill) 模式？
→ 逐题回答完毕（约 15-25 题），评审记录附加到提示词末尾。

→ 弹出工作流确认框：
🚀 进入自动化工作流？
工作流将自动执行以下步骤：
1. 📋 Planner — 分析代码库并生成实施计划
2. 🔧 Worker → Reviewer — 实施代码并审查
3. ✂️ Trimmer → Reviewer — 精简代码并审查
4. 📝 DocWriter — 更新文档

→ 选择"是"后，工作流开始执行...

📋 工作流进度
 ▶ ⏳ 📋 生成实施计划
   ⬜ 🔧 实施代码 → 审查
   ⬜ ✂️ 精简代码 → 审查
   ⬜ 📝 更新文档

→ Planner 完成 ✅，计划写入 pi-dev-output/pi-plans/
→ Worker + Reviewer 循环开始... 审查发现 critical 问题，自动进入第 2 轮循环...
→ 所有步骤完成后：🎉 工作流全部完成！

→ 弹出 PRD 确认框：
📋 创建 PRD — 是否为此功能创建 PRD 文档？
→ 选择"是"，PRD 保存到 pi-dev-output/pi-prd/payments-20260519.md
```

---

## Automation Workflow（自动化工作流引擎）

> 自 v0.4.0 起支持

`/dev-*` 向导组装完提示词后，除了直接发送给主代理（传统模式），还可以选择进入 **自动化工作流** — 由一组专业的 sub-agent 按预设步骤链自动执行，无需人工逐条指令干预。

工作流由 `extensions/workflow-engine.ts` 编排，在 `extensions/dev-prompts.ts` 中定义各命令的步骤链。每个步骤启动一个独立的 sub-agent 进程，拥有隔离的上下文窗口。

### Workflow Agent 一览

5 个专用 sub-agent 各司其职，定义在 `agents/workflow/` 目录下：

| Agent | 职责 | 定义文件 |
|-------|------|---------|
| **planner** | 分析代码库，生成详细的实施计划并写入 `pi-dev-output/pi-plans/` | `agents/workflow/planner-agent.md` |
| **worker** | 按计划逐步实现代码改动（严格遵循计划，不做计划外修改） | `agents/workflow/worker-agent.md` |
| **reviewer** | 审查代码质量，输出带严重等级的结构化报告（critical/medium/low） | `agents/workflow/reviewer-agent.md` |
| **trimmer** | 精简冗余代码、缩短冗长行、消除重复逻辑，优化可读性 | `agents/workflow/trimmer-agent.md` |
| **docWriter** | 根据代码最新状态更新 README 和代码注释 | `agents/workflow/docWriter-agent.md` |

### 工作流模式

步骤执行前，弹出模式选择对话框：

| 模式 | 说明 |
|------|------|
| **值守**（默认 / attended） | 自动步骤自动执行，`[confirm]` 步骤需用户确认，loop-group 循环需用户许可 |
| **完全信任**（full-auto） | 全自动运行，无任何确认步骤。超时自动重试一次，循环自动进入下一轮 |
| **完全值守**（full-attended） | 每一步（包括 auto 类型步骤）都需用户确认后才执行 |

### 命令工作流一览

每个 `/dev-*` 命令对应不同的步骤链。以下配置定义在 `extensions/dev-prompts.ts` 的 `WORKFLOW_STEPS` 常量中：

图例：
- `{}` — Loop-Group（执行 → 审查 → 循环，直到无严重问题或达最大次数）
- `[]` — Confirm 步骤（需用户确认是否执行）
- `→` — 顺序执行

| 命令 | 工作流步骤 | 说明 |
|------|-----------|------|
| `/dev-feat` | planner → {worker→reviewer} → {trimmer→reviewer} → [docWriter] | 完整流程：计划 → 实施+审查 → 精简+审查 → 文档（可跳过） |
| `/dev-fix` | planner → {worker→reviewer} → [docWriter] | 无 trimmer 阶段 |
| `/dev-refactor` | planner → {worker→reviewer} → {trimmer→reviewer} | 无 docWriter 阶段 |
| `/dev-perf` | planner → {worker→reviewer} | 无 trimmer 和 docWriter |
| `/dev-test` | planner → {worker→reviewer} | 同上 |
| `/dev-doc` | planner → docWriter | 简化流程，直接计划→撰写 |
| `/dev-style` | {trimmer→reviewer} | 无计划阶段，仅精简+审查（最多 2 轮循环） |
| `/dev-security` | reviewer | 仅安全审查 |
| `/dev-chore` | 无工作流 | 传统模式，直接发送 prompt |
| `/dev-explain` | 无工作流 | 传统模式 |
| `/dev-compare` | 无工作流 | 传统模式 |

### 断点续传 (Checkpoint)

工作流在执行过程中会定期保存 checkpoint 到 `pi-dev-output/pi-workflow/checkpoint.json`。如果工作流因终端关闭、网络断开或 AI 超时而中断，后续恢复方式如下：

- **自动恢复**：再次执行对应的 `/dev-*` 命令时，引擎自动检测 checkpoint 文件，弹出确认对话框询问是否恢复
- **手动恢复**：注册了专门的 `/dev-workflow-continue` 命令，用于手动恢复上次中断的工作流
- **Checkpoint 内容**：包含原始 prompt、运行模式、各步骤状态、loop 次数、plan 文件引用路径

如果在恢复对话框中选择"否"，则丢弃 checkpoint 重新开始。

### Loop-Group 循环审查

`{}` 标记的步骤组称为 Loop-Group。机制如下：

1. 先执行实施 agent（worker 或 trimmer），再执行 reviewer agent
2. Reviewer 输出 `[REVIEW_SUMMARY]` JSON 摘要：

```
[REVIEW_SUMMARY]
{"maxSeverity":"critical","critical":2,"medium":1,"low":3}
[/REVIEW_SUMMARY]
```

3. 若 `maxSeverity === "critical"` 且未达到最大循环次数（默认 3 次），进入下一轮循环
4. 在 `full-auto` 模式下自动循环；在 `attended` 模式下询问用户是否继续
5. 达到最大循环次数后，无论审查结果如何，进入下一步
6. Reviewer 输出支持 fallback 裸 JSON 解析（兜底识别）

### 超时处理

每个步骤有独立的超时时间（`timeoutMs` 字段）。超时后的行为因模式而异：

| 模式 | 超时行为 |
|------|---------|
| `full-auto` | 自动重试一次（带 `[RETRY]` 前缀），重试仍超时则步骤标记为 failed |
| `attended` / `full-attended` | 弹出选择：重新执行 / 跳过此步骤 / 取消工作流 |
| loop-group 内 | 超时后不阻塞循环，可自动进入审查阶段（带 `[TIMEOUT_WARNING]` 标记） |

## Skills

| Skill | 来源 | 说明 |
|---|---|---|
| **karpathy-guidelines** | [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) | 基于 Andrej Karpathy 对 LLM 编码陷阱的观察，强调简洁、精准、可验证 |
| **review-html** | 自制 | git diff / commit 审查，输出自包含的交互式 HTML 报告 |
| **grill-with-docs** | [mattpocock/skills](https://github.com/mattpocock/skills) | 设计评审 — 挑战方案、统一术语、实时更新 CONTEXT.md 和 ADR |
| **to-prd** | [mattpocock/skills](https://github.com/mattpocock/skills) | 从对话上下文和代码库理解生成 PRD，保存到 `pi-dev-output/pi-prd/` |

## 设计评审（Grill）机制

Grill（"拷问式评审"）是提交方案前由 AI sub-agent 从多个维度挑战你设计的交互流程。Grill 阶段在 `/dev-*` 向导完成后自动触发，以确认对话框询问是否进入评审。

评审流程：
1. **确认** — 弹出对话框，选择"是"进入评审
2. **生成问题** — sub-agent 根据方案上下文，一次生成全部评审问题（JSON 数组）
3. **逐题回答** — TUI 逐题展示，每道题带选项列表 + 自定义输入入口
4. **增强提示词** — 所有 Q&A 追加到原提示词末尾，形成 `enhancedPrompt`

### 按领域定制的 Grill Agent

不同的 `/dev-*` 命令使用专门定制的 grill agent，问题方向与任务类型对齐：

| 命令 | Grill 场景 | 评审维度 |
|---|---|---|
| `/dev-feat` | 设计方案评审 | 架构、数据流、模块边界、安全、测试策略、性能、可扩展性 |
| `/dev-fix` | Bug 根因分析评审 | 复现条件、根因推理、修复方案、回归风险 |
| `/dev-doc` | 文档大纲评审 | 受众定位、结构安排、示例选择 |
| `/dev-refactor` | 重构方案评审 | 模块边界、API 兼容性、测试策略、迁移风险 |
| `/dev-test` | 测试计划评审 | 覆盖维度、边界条件、模拟策略 |
| `/dev-perf` | 性能优化评审 | 基准测试方法、优化方向、回归风险 |

### 交互形式

每道问题在 TUI 中以 SelectList 呈现：
- 选项列表：`(a) ...` `(b) ...` `(c) ...`
- 最末选项：`✏️ 自定义输入` — 可输入自己的回答
- 导航：↑↓ 选择，Enter 确认，Esc 取消全部评审
- 进度：标题栏显示 `问题 3/18`

## PRD 文档生成

仅 `/dev-feat` 命令在执行完成后自动触发 PRD 生成。其余 `/dev-*` 命令不包含此阶段。

流程：
1. **等待** — 等待主代理完成任务（`ctx.waitForIdle()`）
2. **确认** — 弹出对话框询问是否创建 PRD
3. **生成** — sub-agent 读取对话上下文 + 代码库理解，按模板生成 Markdown PRD
4. **保存** — 写入 `pi-dev-output/pi-prd/<module>-<date>.md`，自动创建 `.gitignore` 忽略该目录
5. **后续操作** — 询问是否立即开始开发：
   - "是" — 将 PRD 作为开发指令发送给主代理
   - "否" — 仅保存文件，稍后手动引用
   - "✏️ 自定义开发指令" — 输入自定义指令，与 PRD 一起发送

PRD 模板包含：Problem Statement、Solution、User Stories、Implementation Decisions、Testing Decisions、Out of Scope、Further Notes。

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

### 加载

pi 会自动加载包内的 `skills/`、`prompts/`、`extensions/`、`themes/` 内容。
安装后执行 `/reload` 热加载所有变更。

### 包更新

```bash
pi install git:github.com/cherish-ltt/pi-dev-workflow
/reload
```

## 常见问题

**Q: Grill 阶段可以跳过吗？**
A: 可以。在 Grill 确认对话框中选择"否"即可跳过，原提示词不变直接投递给主代理。评审过程中按 Esc 也可随时取消，已回答的问题仍会附加到提示词中。

**Q: 所有 `/dev-*` 命令都支持 Grill 吗？**
A: 不是。以下命令支持 Grill：`/dev-feat`、`/dev-fix`、`/dev-doc`、`/dev-refactor`、`/dev-test`、`/dev-perf`。`/dev-chore`、`/dev-style`、`/dev-security`、`/dev-explain`、`/dev-compare` 不包含 Grill 阶段。

**Q: PRD 没有自动生成怎么办？**
A: 只有 `/dev-feat` 会在执行完成后触发 PRD 生成。其他命令不包含此阶段。如果需要为其他场景生成 PRD，可以手动使用 `to-prd` skill（直接引用 `/skill:to-prd`）。

**Q: 如何自定义 Grill 的问题数量和方向？**
A: 在 `extensions/grill-me-agent.ts` 中修改对应 AgentDef 的 `systemPrompt` 即可控制问题方向和数量。目前各领域 grill agent 的问题数量由 LLM 自主决定（典型 15-40 题）。

**Q: 评审结果是否影响原提示词？**
A: 评审问答以「设计评审记录」区块追加到原提示词末尾，原提示词内容不变。主代理执行时会同时参考原需求 + 评审中确认的决策。

**Q: `grill-with-docs` skill 和 `/dev-*` 内置的 Grill 有什么区别？**
A: `grill-with-docs` 是可独立调用的 skill（`/skill:grill-with-docs`），侧重领域术语统一和文档同步（更新 CONTEXT.md、创建 ADR）。`/dev-*` 内置的 Grill 是任务向导的一部分，侧重方案评审，不涉及文档持久化。

**Q: 工作流执行到一半中断了怎么办？**
A: 工作流引擎会在每次步骤完成后保存 checkpoint 到 `pi-dev-output/pi-workflow/checkpoint.json`。重新执行对应的 `/dev-*` 命令时会自动检测并询问是否恢复。也可手动使用 `/dev-workflow-continue` 命令恢复上次中断的工作流。

**Q: 如何跳过工作流，直接发送 prompt 给主代理？**
A: 在工作流确认对话框中选择"否"即可直接发送 prompt 给主代理，行为与传统模式完全一致。

**Q: `{}` loop-group 最多循环多少次？会无限循环吗？**
A: 不会无限循环。每个 loop-group 默认最大循环次数为 3（由 `maxLoops` 字段控制），达到上限后无论审查结果如何都会进入下一步。`/dev-style` 的 loop-group 最大次数为 2。如果使用 `full-auto` 模式且问题重复出现，达到上限后自动结束循环。

**Q: reviewer 的审查等级如何决定 workflow 走向？**
A: reviewer 输出 `[REVIEW_SUMMARY]` JSON 块，`maxSeverity: "critical"` 时触发下一轮循环（如果未达上限），`"medium"` 或 `"low"` 时结束循环进入下一步。

**Q: docWriter 步骤为什么要标记为 `[confirm]`？**
A: 文档更新是可选的。有时代码变更只是内部重构或 Bug 修复，不需要更新 README。`[confirm]` 允许用户跳过此步骤。

**Q: 超时后会发生什么？**
A: 在 `full-auto` 模式下超时会自动重试一次；在 `attended` 模式下会弹出对话框让用户选择：重新执行、跳过此步骤、取消工作流。重试后仍然超时则该步骤标记为 failed。

**Q: 所有命令都支持自动化工作流吗？**
A: 不是。`/dev-chore`、`/dev-explain`、`/dev-compare` 三个命令无工作流配置，使用传统模式直接发送 prompt。其余 8 个命令均包含工作流支持。具体各命令的步骤链见「命令工作流一览」表格。

## License

MIT
