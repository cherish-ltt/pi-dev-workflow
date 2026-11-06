# Unreleased

> 核心变化：增加仅提交已暂存内容的快捷命令，保留用户选定的提交范围。

## 🚀 Features

- 增加 `/git-commit-staged` 和 `/git-commit-staged-push`：必填提交信息，仅提交当前 index；空暂存区不提交，提交失败不推送，推送失败可单独重试。原有全量和 AI 分批提交行为保持不变。

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 修改 | `extensions/git-commands.ts`、`README.md` |
| 新增 | `tests/test-git-commands.mjs` |

## 🔗 Commit History

```text
24303c0 feat(git): 支持仅提交已暂存内容
```
