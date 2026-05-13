# ghyper9023-self-workflow

> ghyper9023 自用 pi-package，为 [pi coding agent](https://pi.dev/) 提供个性化技能、提示词、扩展和主题。

## 快速安装

```bash
pi install git:github.com/cherish-ltt/ghyper9023-self-workflow
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

## Skills

| Skill | 来源 | 说明 |
|---|---|---|
| **karpathy-guidelines** | [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) | 基于 Andrej Karpathy 对 LLM 编码陷阱的观察，强调简洁、精准、可验证 |
| **review-html** | 自制 | git diff / commit 审查，输出自包含的交互式 HTML 报告 |

## 使用方式

### 安装

```bash
# 通过 git 安装（推荐，自动更新）
pi install git:github.com/cherish-ltt/ghyper9023-self-workflow

# 或从本地目录安装
pi install /path/to/pi-dev-workflow
```

### 加载

pi 会自动加载包内的 `skills/`、`prompts/`、`extensions/`、`themes/` 内容。
安装后执行 `/reload` 热加载所有变更。

### 包更新

```bash
pi install git:github.com/cherish-ltt/ghyper9023-self-workflow
/reload
```

## License

MIT
