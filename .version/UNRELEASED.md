# Unreleased

> 核心变化：快捷命令支持仅提交已暂存内容，HTML 审查支持固定 Git 基准范围；问卷可主动暂停并跨重启恢复，完成后先归档，再选择是否发送方案。

## 🚀 Features

- 增加 `/git-commit-staged` 和 `/git-commit-staged-push`：必填提交信息，仅提交当前 index；空暂存区不提交，提交失败不推送，推送失败可单独重试。原有全量和 AI 分批提交行为保持不变。
- `/grill` 完整回答后先保存原方案与最终答案，展示归档路径，再选择「仅保存」或「保存并发送」；Esc 保留归档，重试出题成功使用相同流程，保存失败不发送。
- HTML 审查支持显式本地基准引用，按唯一 merge-base 到固定 HEAD 的净变更审查，报告包含完整 SHA、文件清单和未纳入的未提交改动状态；空范围不回退，无效或不唯一的共同祖先明确报错。
- `/grill` 支持主动暂停并保存单份项目草稿，使用 `/grill-resume` 跨 Pi 重启恢复原方案、完整问题、已答内容和实际题目位置；取消不保存新增进度，写入失败保留旧稿，完成归档后清理本次草稿，发送仍需本轮选择。

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 修改 | `extensions/git-commands.ts`、`extensions/grill-me-agent.ts`、`skills/review-html/SKILL.md`、`README.md` |
| 新增 | `skills/review-html/scripts/review-base.mjs`、`tests/test-git-commands.mjs`、`tests/test-grill-completion.mjs`、`tests/test-grill-resume.mjs`、`tests/test-review-base.mjs` |

## 🔗 Commit History

```text
b394e70 fix(grill): 允许按数组位置恢复重复题目 ID
6a5898c feat(grill): 支持问卷暂停与跨重启恢复
1a8edc7 feat(review): 支持显式 Git 基准的净变更审查 (#17)
76d834f feat(grill): 完成后先保存并显式选择发送 (#16)
7304a0f feat(git): 支持仅提交已暂存内容 (#15)
```
