# Release v0.10.0

> 核心变化：`dev_ask` 默认供模型直接调用，不再依赖意图校验阶段临时激活；技能替换为 `grilling`，通过设计树分轮对齐决策，并同步使用文档与来源致谢。

## 🚀 Features

- `dev_ask` 加载后默认可用，保持 `model-only`；普通对话可直接使用，`/dev-pre-check` 结束、取消或报错均不再移除它。
- 工具说明、系统提示和参数 schema 明确每轮只询问前置条件已确定的问题，强烈推荐在 `grilling` 中收集当前 frontier 的决策，再根据答案推进下一轮。
- 未作答的问题保持开放，不代表同意推荐项；保留选项详情、Markdown/ASCII 预览、自由输入、返回和取消行为。

## Skills 与文档

- 移除 `grill-with-docs` 及其格式文档，新增 `grilling`：按设计树分轮追问，强烈推荐直接使用 `dev_ask`，事实由当前代理只读探查，不要求子代理；达成共同理解后仍需用户确认才执行。
- README 同步技能目录、使用方式和 FAQ；链接 `mattpocock/skills` 与 `rpiv-ask-user-question` 并致谢，说明已内置类似问卷功能，不再推荐额外安装该插件。
- 现有 `/grill` 与 `/prd` 命令保持不变。

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 新增 | `skills/grilling/SKILL.md` |
| 删除 | `skills/grill-with-docs/SKILL.md`、`skills/grill-with-docs/ADR-FORMAT.md`、`skills/grill-with-docs/CONTEXT-FORMAT.md` |
| 版本 | `package.json`、`package-lock.json`、`.version/RELEASE-v0.10.0.md` |
| 修改 | `extensions/dev-ask.ts`、`extensions/pre-check.ts`、`tests/test-dev-ask.mjs`、`tests/test-no-subagents.mjs`、`README.md` |

## 🔗 Commit History

```
c74c5e7 feat(skills): 替换 grilling 技能并同步文档与致谢
0fb29fd feat(dev-ask): 默认开放模型调用并支持分轮决策
```
