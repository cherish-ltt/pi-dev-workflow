# Unreleased

> 核心变化：`dev_ask` 默认供模型直接调用，不再依赖意图校验阶段临时激活，支持需求澄清、方案取舍和分轮追问。

## 🚀 Features

- `dev_ask` 加载后默认可用，保持 `model-only`；普通对话可直接使用，`/dev-pre-check` 结束、取消或报错均不再移除它。
- 工具说明、系统提示和参数 schema 明确每轮只询问前置条件已确定的问题，强烈推荐在 `grilling` 中收集当前 frontier 的决策，再根据答案推进下一轮。
- 未作答的问题保持开放，不代表同意推荐项；保留选项详情、Markdown/ASCII 预览、自由输入、返回和取消行为。

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 修改 | `extensions/dev-ask.ts`、`extensions/pre-check.ts`、`tests/test-dev-ask.mjs`、`tests/test-no-subagents.mjs` |
