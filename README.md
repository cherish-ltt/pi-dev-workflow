# ghyper9023-self-workflow

> ghyper9023 自用 pi-package，为 [pi coding agent](https://pi.dev/) 提供个性化技能与提示词。

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
│   ├── karpathy-guidelines/
│   │   └── SKILL.md                 # Karpathy 编码准则（避免 LLM 常见错误）
│   └── review-html/
│       └── SKILL.md                 # 代码审查 → 输出交互式 HTML 报告
├── extensions/
│   └── git-commands.ts              # /git-commit, /git-push, /git-commit-push 命令
└── themes/
    └── claude-code-theme.json       # Claude Code CLI 风格主题
```

## Extensions

| Extension | 说明 |
|---|---|
| **git-commands** | 注册三个命令：`/git-commit [message]` 暂存并提交(空信息让AI代写)；`/git-push` 推送(带确认)；`/git-commit-push [message]` 暂存+提交+推送一键完成 |

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

1. 确保已安装 [pi coding agent](https://github.com/earendil-works/pi-coding-agent)
2. 将本包放入 pi 的包目录或通过 `pi.config.yaml` 引用
3. pi 会自动加载 `skills/`、`prompts/` 下的内容

## License

MIT
