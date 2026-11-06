# Unreleased

> 核心变化：快捷命令支持仅提交已暂存内容；问卷完成后先归档，由用户选择是否发送方案。

## 🚀 Features

- 增加 `/git-commit-staged` 和 `/git-commit-staged-push`：必填提交信息，仅提交当前 index；空暂存区不提交，提交失败不推送，推送失败可单独重试。原有全量和 AI 分批提交行为保持不变。
- `/grill` 完整回答后先保存原方案与最终答案，展示归档路径，再选择「仅保存」或「保存并发送」；Esc 保留归档，重试出题成功使用相同流程，保存失败不发送。

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 修改 | `extensions/git-commands.ts`、`extensions/grill-me-agent.ts`、`README.md` |
| 新增 | `tests/test-git-commands.mjs`、`tests/test-grill-completion.mjs` |

## 🔗 Commit History

```text
22cb676 feat(grill): 完成问卷后保存方案并显式选择发送
7304a0f feat(git): 支持仅提交已暂存内容 (#15)
```
