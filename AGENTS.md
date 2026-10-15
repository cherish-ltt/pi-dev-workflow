# AGENTS.md

本文件给 AI coding agent 说明本仓库的版本记录机制，重点是 `.version/UNRELEASED.md` 的用途与维护方式。

## `.version/` 是什么

仓库的版本记录全部放在 `.version/`：

| 文件 | 作用 |
|---|---|
| `.version/UNRELEASED.md` | 尚未发布的变更，即下一个版本的发布说明草稿 |
| `.version/RELEASE-v<tag>.md` | 已发布版本的说明。推 `v*` tag 时，`.github/workflows/release.yml` 直接以该文件作为 GitHub Release 正文 |

## `UNRELEASED.md` 的作用

`UNRELEASED.md` 是「已落库但尚未发布」的变更清单。它保证两件事：

- 未发布内容有唯一落点：改动随时落库，发布时不必翻 `git log` 反推变更说明。
- 发布动作可机械执行：发布时把它的内容原样迁移为 `.version/RELEASE-v<下一个 tag>.md`，无需重新组织文档。

## 何时更新

任何对使用者可见的改动落库后，就把条目追加进 `UNRELEASED.md` 的对应段落，并补上该提交的 hash：

- 新增能力、行为变更 → `## 🚀 Features`
- 缺陷修复 → `## 🐛 Bug Fixes`
- 结构调整（不改对外行为）→ `## 🔧 Refactor`
- 许可、文档结构、发布流程等变更 → 按最贴近的段落归档，必要时新增段落

被要求「不改版本号」时同样写入 `UNRELEASED.md`，不要为此 bump `package.json`。

## 体例

与 `.version/RELEASE-v*.md` 保持一致：

```
# Unreleased

> 核心变化：一到两句说清本次最关键的改动

## 🚀 Features
- ...

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 新增 | ... |

## 🔗 Commit History

```
<上一 tag 之后的真实 commit hash + 标题>
```
```

- 段落按需保留，没有内容就整段删掉，不要留空段。
- `Commit History` 用 `git log --format='%h %s' v<上一 tag>..HEAD` 取真实 hash，不要手写或编造。
- 不列本文件自身所在提交的 hash，与 `RELEASE-v*.md` 的既有做法一致。
- 写变更内容与影响，不堆实现细节。

## 发布时

1. 把 `UNRELEASED.md` 的内容迁移为 `.version/RELEASE-v<下一个 tag>.md`（复制改名，然后清空 `UNRELEASED.md` 的条目）。
2. bump `package.json` 的 `version`。
3. 打 `v<version>` tag 并推送，触发 `release.yml` 与 `npm-publish.yml`。

顺序不能颠倒：`tests/test-no-subagents.mjs` 第 9 节会读取 `package.json` 的版本号，要求存在 `.version/RELEASE-v<version>.md`，并校验该文档覆盖「上一版本 tag .. 文档中最新 commit」区间内的全部 commit。版本号先于发布说明落地会直接让测试失败。
