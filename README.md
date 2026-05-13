# ghyper9023-self-workflow

> ghyper9023 自用 pi-package，为 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 提供个性化技能与提示词。

## 目录结构

```
pi-package/
├── package.json                     # 包元数据 & pi 配置
├── README.md                        # 本文件
├── .gitignore
├── prompts/
│   └── APPEND_SYSTEM.md             # 全局追加提示：强制使用简体中文+英文专业名词
├── skills/
│   ├── karpathy-guidelines/
│   │   └── SKILL.md                 # Karpathy 编码准则（避免 LLM 常见错误）
│   └── review-html/
│       └── SKILL.md                 # 代码审查 → 输出交互式 HTML 报告
├── extensions/                      # pi 扩展（预留，暂无内容）
└── themes/                          # pi 主题（预留，暂无内容）
```

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
