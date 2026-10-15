# Release v0.9.0

> 核心变化：**意图识别轮次里直接问清楚**。新增内部提问工具 `dev_ask`，把影响实现方向的不确定项做成「题目 + 2-4 个选项」一次问完；确认环节新增「是 + 补充」，补充说明并入已确认意图后直接开工；复述等待改为忙碌感知，不再把「模型正在提问」误判成「未获取到复述」；`/dev-pre-check` 在命令补全里提到首位。

## 🚀 Features

### `dev_ask`：意图识别轮次里的结构化提问

意图复述此前只能把不确定项写进「不确定之处」的文字里，等用户读完整段复述后再自行补充，来回成本高。本次让模型在复述轮次内直接提问：

- **新增 `extensions/dev-ask.ts`** — 提供 `dev_ask` 工具：
  - 参数为「题目数组」，每题含 `header`（最多 16 字符）、`question`、2-4 个选项；每个选项带 `label` 与 `description`（含义或取舍）
  - 题目数量不限，一次调用问完，避免连续多次调用打断
  - 逐题弹出「不确定项 i/N｜短标签 + 完整问题」，每题自动追加「✎ 自己输入…」可自由作答
  - 支持「← 返回上一步」重答上一题；按 Esc 放弃剩余提问
- **答案回灌模型** — 工具结果按「问题 → 答案」逐条列出；被放弃时明确要求「未作答的问题按你的最佳判断处理，并在『不确定之处』中标注为开放问题」；正常结束时声明「以上答案视为用户已确认的前提」
- **默认不激活** — `defaultActive: false` + `exposure: "model-only"`，仅由 `confirmIntent()` 通过 `activateDevAsk()` 在每轮复述前后临时加入/移除模型工具列表（`finally` 保证还原），不会出现在无关会话的工具列表与 system prompt 中
- **无 UI 兜底** — `ctx.hasUI` 为假时直接返回文字提示，要求模型把不确定项写回文字说明

### `/dev-pre-check`：确认环节「补充后直接开工」与忙碌感知等待

- **新增确认选项「是 + 补充 — 补充说明后直接开工（不重新复述）」** — 输入补充说明后，内容以 `### 用户补充（已确认，直接采纳，不需重新复述）` 段并入已确认意图，直接进入执行，不再跑一轮复述；输入框按 Esc 退回确认选项（而非直接取消整个流程），修正选项保留原有「补充后重新复述」循环
- **复述等待改为 `waitForRestatement()`** — 原实现用 `pollFor` 的绝对超时（5 分钟），会把「模型正在 `dev_ask` 上等用户作答」误判成「未获取到复述」：
  - 代理忙碌（执行工具、等待用户作答）期间不计超时，进入空闲后重新计时
  - 保留 30 分钟绝对上限（`PRE_CHECK_MAX_WAIT_MS`），避免代理始终不空闲时无限等待
  - 超时后仍弹出「重试 / 取消」供用户决定
- **复述指令补充** — 要求「关键不确定项用 `dev_ask` 一次性提问」，并声明「工具列表里没有 `dev_ask` 时把不确定项留在第 4 节文字里，不要臆造工具」；第 4 节定义收紧为「列出提问后仍未解决、以及不值得提问的项」

### 补全优先排序：`/dev-pre-check` 排到最前

命令名补全的模糊匹配分数在 `/dev*` 之间相同，同分时排序回落到扩展加载顺序（= 扩展文件名顺序），而 pi 未提供扩展可用的命令优先级接口。因此：

- 在 `session_start` 通过 `ctx.ui.addAutocompleteProvider()` 包一层补全 provider
- 仅在命令名补全（prefix 形如 `/dev`）时把 `dev-pre-check` 提到首位，参数补全与路径补全保持原序

### `uiSelect` 支持带说明的选项

- 新增导出类型 `SelectChoice = string | { label; description? }`；`uiSelect` 的 `items` 由 `string[]` 改为 `SelectChoice[]`
- 传字符串时行为不变（label 即返回值）；传对象时 `value` 仍取 `label`，`description` 显示为同一行右侧的说明——`dev_ask` 的选项说明即依赖此项

### 测试与文档同步

- 结构断言更新（107 条，全部通过）：新增 `dev-ask.ts` 断言段（工具名、`activateDevAsk`、`exposure`/`defaultActive`、选项数上限、自定义入口、复用 `BACK_OPTION_TEXT`、不依赖第三方插件与 typebox），新增 `SelectChoice` 断言，pre-check 断言覆盖「补充后直接开工」、「用户补充」段、`activateDevAsk`/`restoreAsk`、补全提权、`PRE_CHECK_MAX_WAIT_MS`/`waitForRestatement`，并改为断言不再 `import { pollFor`
- README 同步：目录结构新增 `dev-ask.ts`、意图预检流程与确认表格更新、新增「补全优先排序」小节、FAQ 补充等待上限与 `dev_ask` 作用域

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 新增 | `extensions/dev-ask.ts` |
| 修改 | `extensions/pre-check.ts`、`extensions/ui-helpers.ts`、`tests/test-no-subagents.mjs`、`README.md`、`package.json` |
| 版本 | `.version/RELEASE-v0.9.0.md`（本文件） |

## 🔗 Commit History

```
fc0378a chore: bump version to 0.9.0
7a0b68e docs: 同步 README 至 dev_ask 提问与补全优先排序
c49e061 feat(pre-check): 命令补全把 /dev-pre-check 提到首位
7fa304f feat(pre-check): 复述轮次启用 dev_ask 提问，新增「补充后直接开工」与忙碌感知等待
627103c feat(dev-ask): 新增 dev_ask 提问工具，uiSelect 支持带说明的选项
```
