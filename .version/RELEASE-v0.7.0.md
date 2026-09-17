# Release v0.7.0

> 核心变化：**彻底移除子代理架构**。不再 spawn 隔离子代理进程，Git 命令、Grill 追问、PRD 生成、代码审查全部由当前代理直接执行（当前模型普遍具备 ≥1M 上下文窗口，无需隔离上下文）。

## 🚀 Features

### 移除子代理基础设施
- 删除 `extensions/sub-agents.ts`（954 行）、`extensions/workflow-engine.ts`（2005 行）及 `agents/` 目录下全部 14 个 agent 定义
- 移除 `.doc/AGENT-FRONTMATTER-REFERENCE.md` 与 6 个依赖子代理的旧测试，合并为单一回归测试套件 `tests/test-no-subagents.mjs`

### Git 命令直接执行
- `/git-commit`、`/git-push`、`/git-commit-push` 改用 pi 内置执行器直接运行 git，不再委派 git 子代理
- 空提交信息时由当前代理基于 diff 生成 Conventional Commits 消息（附带前缀格式校验）

### Grill 与 PRD 在当前代理运行
- 方案追问完善（Grill）与 PRD 生成不再 spawn 子代理，由当前代理通过 `write` 工具落盘结果，扩展侧轮询读取
- `/dev-*` 向导组装完提示词后直接投递给当前代理，新增自动审查意图检测（可路由到 review-html skill）

### /dev-* 向导精简（2-4 轮概念式提问）
- 提问按「核心任务 → 验收标准（可跳过）→ 额外补充（可跳过）」组织，全部命令 2-4 轮完成
- 新增智能默认填充：自动探测项目语言、测试命令、lint 命令、pre-commit 钩子与 CI 配置
- 四段式组装「角色 / 任务 / 验收标准 / 额外补充」，缺省字段注入流畅默认值，提示词不空白不违和

### 工程化
- 新增 `.pre-commit-config.yaml`：通用文件检查（trailing-whitespace、冲突标记、大文件、YAML/JSON 校验、私钥检测）+ betterleaks 密钥泄露扫描 + ast-grep 结构化检查
- 新增 GitHub Release 自动化（`.github/workflows/release.yml`）：推送 `v*` 标签时自动发布，读取 `.version/RELEASE-<tag>.md` 作为 release 内容，未找到时写入引导查看 git commit 的默认提示

## 🐛 Bug Fixes

- 修复 `ctx.waitForIdle(超时)` 参数无效问题：SDK 签名不接受超时参数，新增 `session-utils.ts` 的 `waitForIdleWithTimeout()`（Promise.race 实现真实超时），覆盖 git-commands / grill-me-agent / dev-prompts 共 5 处调用
- 修复 `pi.on("input")` 未过滤扩展注入消息（`event.source === "extension"`）导致的递归风险
- 修复审查功能 `pi.sendUserMessage("/skill:review-html")` 未设置 `expandPromptTemplates` 导致 skill 不展开的问题
- 修复 PRD 生成失败时静默返回无提示的问题，增加错误通知
- 修复 commit message 提取未校验 Conventional Commits 格式导致异常提交消息的问题

## 🔧 Refactor

- git-commands 与 grill-me-agent 解除互相依赖，公共会话/等待/项目探测工具下沉至新的 `extensions/session-utils.ts`
- 移除 `ui-helpers.ts` 工作流进度 widget 面板（约 780 行）及其相关状态类型
- 清理未使用 import（BorderedLoader）、死代码分支与文件末尾缺失换行
- README、APPEND_SYSTEM.md、package.json 元数据同步新架构

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 删除 | `extensions/sub-agents.ts`、`extensions/workflow-engine.ts`、`agents/`（14 个 md）、`.doc/AGENT-FRONTMATTER-REFERENCE.md`、6 个旧测试 |
| 新增 | `extensions/session-utils.ts`、`tests/test-no-subagents.mjs`、`.pre-commit-config.yaml`、`.github/workflows/release.yml` |
| 修改 | `extensions/git-commands.ts`、`extensions/grill-me-agent.ts`、`extensions/dev-prompts.ts`、`extensions/ui-helpers.ts`、`README.md`、`prompts/APPEND_SYSTEM.md`、`package.json` |

## 🔗 Commit History

```
8d751c7 ci: 新增 v* 标签触发的 GitHub Release 自动化
c846996 docs: 添加第三方推荐扩展列表
54218ac feat: 精简 /dev-* 向导为概念式提问并智能默认填充
c599a25 chore: bump version to 0.7.0
462ccfd chore: 修正 README 措辞、pre-commit 大文件检查范围与 SKILL 尾随空格
6801299 test: 补充超时等待与审查入口的回归断言
6cb3243 fix: 审查检测过滤扩展注入消息防递归，skill 命令正确展开
b92131f fix: grill/PRD 等待当前代理带超时，PRD 失败增加错误提示
e8347f3 fix: git 命令等待带超时，共享会话工具下沉至 session-utils
c8b55b9 feat: 添加 .pre-commit-config.yaml 文件，配置通用文件检查和密钥泄露检测
1fa91f5 docs: 更新文档与元数据，反映子代理移除后的新架构
8c6add1 refactor: 移除工作流进度 widget 面板代码
d27a031 feat: /dev-* 向导组装完提示词后直接发送给当前代理
4019c2e feat: Grill 与 PRD 在当前代理中运行，不再 spawn 子代理
f9b8bef feat: run git commands directly instead of delegating to git-sub-agent
410c21f test: replace sub-agent-dependent tests with single regression suite
c03549a feat: remove sub-agent infrastructure
```