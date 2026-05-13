# @ghyper9023/pi-dev-workflow

> Developer workflow toolkit for [pi coding agent](https://pi.dev/): git agents, code review, Karpathy guidelines, themes

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
│   └── review-agent.md              # review-sub-agent 定义（专注代码审查）
├── prompts/
│   ├── APPEND_SYSTEM.md             # 全局追加提示：强制使用简体中文+英文专业名词
│   ├── review-commit.md             # 审查 commit 的提示模板
│   └── review-diff.md              # 审查 diff 的提示模板
├── skills/
│   ├── karpathy-guidelines/
│   │   └── SKILL.md                 # Karpathy 编码准则（避免 LLM 常见错误）
│   └── review-html/
│       └── SKILL.md                 # 代码审查 → 输出交互式 HTML 报告
├── extensions/
│   ├── dev-prompts.ts               # 提示词优化向导（/dev-* 命令）
│   ├── git-commands.ts              # git-sub-agent 命令
│   └── sub-agents.ts                # 子代理系统：git-sub-agent + review-sub-agent
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

| 命令 | 用途 | 对应模板类型 |
|---|---|---|
| `/dev-feat` | 新功能/创意生成 | `feat` |
| `/dev-fix` | 问题排查/错误修正 | `fix` |
| `/dev-doc` | 文档生成/总结 | `doc` |
| `/dev-refactor` | 重构/优化现有结构 | `refactor` |
| `/dev-test` | 测试用例生成 | `test` |
| `/dev-chore` | 日常维护/自动化 | `chore` |
| `/dev-perf` | 性能优化 | `perf` |
| `/dev-style` | 风格/格式调整 | `style` |
| `/dev-security` | 安全审查 | `security` |
| `/dev-explain` | 概念解释 | `explain` |
| `/dev-compare` | 对比评估 | `compare` |

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

## Skills

| Skill | 来源 | 说明 |
|---|---|---|
| **karpathy-guidelines** | [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) | 基于 Andrej Karpathy 对 LLM 编码陷阱的观察，强调简洁、精准、可验证 |
| **review-html** | 自制 | git diff / commit 审查，输出自包含的交互式 HTML 报告 |

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

## License

MIT
