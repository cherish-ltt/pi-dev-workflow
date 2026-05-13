# ghyper9023-self-workflow

> ghyper9023 自用 pi-package，为 [pi coding agent](https://pi.dev/) 提供个性化技能与提示词。

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

当用户输入包含 review/审查/审阅 + code/代码/diff/commit/html 等关键词时，自动委派 review-sub-agent 进行代码审查。
审查完成后将结果返回给用户。

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

1. 确保已安装 [pi coding agent](https://github.com/earendil-works/pi)
2. 将本包放入 pi 的包目录或通过 `pi.config.yaml` 引用
3. pi 会自动加载 `skills/`、`prompts/`、`extensions/`、`themes/` 下的内容
4. `/reload` 热加载所有变更

## License

MIT
