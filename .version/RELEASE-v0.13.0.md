# v0.13.0

> 核心变化：更新全局代理规则并新增项目审查技能；dev 命令的意图预检改由可维护的 prompt-check 技能指导。

## 🚀 Features

- 更新全局追加提示词，统一思考、执行、编码、调试和报告规则。
- 新增 `project-audit-review` 技能，提供基于证据的项目审查与 Issue 报告流程。
- 新增 `prompt-check` 技能；五个 dev 命令每轮读取该技能，确认或取消后沿用现有交互流程。
- 更新使用文档，并验证技能读取、取消及缺失文件的行为。

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 新增 | `skills/project-audit-review/SKILL.md`、`skills/prompt-check/SKILL.md` |
| 修改 | `prompts/APPEND_SYSTEM.md`、`extensions/pre-check.ts`、`extensions/dev-prompts.ts`、`tests/test-dev-ask.mjs`、`tests/test-no-subagents.mjs`、`README.md` |

## 🔗 Commit History

```
5c3ac96 feat: 使用 prompt-check 技能指导 dev 意图预检
e96e08c feat: 更新全局规则并新增项目审查技能
```
