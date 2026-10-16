# Unreleased

> 核心变化：许可协议从单一 MIT 改为 **MIT 与 Apache-2.0 双协议并行**（SPDX `MIT OR Apache-2.0`，使用者任选其一）；同时建立 `.version/UNRELEASED.md` 作为未发布变更的记录落点。`dev_ask` 新增随选项切换的详情区，支持说明换行与 ASCII/Markdown 预览。

## 🚀 Features

### 许可协议：MIT 与 Apache-2.0 双协议并行

- **`LICENSE` → `LICENSE-MIT`** — 原 MIT 文本与版权声明原样保留，仅重命名，与 Apache 文本并列
- **新增 `LICENSE-APACHE`** — Apache License 2.0 官方全文（202 行，与 `apache.org/licenses/LICENSE-2.0.txt` 逐行一致，无行尾空格，可过 pre-commit 的 trailing-whitespace 钩子）
- **`package.json` / `package-lock.json`** — `license` 字段改为 SPDX 表达式 `MIT OR Apache-2.0`；两个文件同批更新，避免 lockfile 与 manifest 不一致
- **README** — License 段改为说明双协议并行、任选其一，并给出两个许可文件的链接与 SPDX 标识

Apache-2.0 相对 MIT 额外提供专利授权与商标条款，双协议并行让使用方可按自身合规要求选择。

### dev_ask：选项预览

- 选项可附带 Markdown `preview`，展示 ASCII 结构图、代码或配置；详情区同时展示当前选项的说明与预览，宽界面左右分栏，窄界面上下排列。
- 超出屏幕的详情可用 PgUp/PgDn 翻页，保留自由输入、返回上一题和 Esc 放弃的现有答题行为。

## 🐛 Bug Fixes

- 修复 `dev_ask` 把所有说明挤在各选项行右侧的问题：详情现在只随当前高亮选项展示，长说明自动换行，不再被单行截断。

## 🔧 Refactor

### 建立未发布变更的记录落点

此前未发布的改动只能靠 `git log` 反推，发布时需临时组织 Release 说明。本版本起：

- **新增 `.version/UNRELEASED.md`** — 记录已落库但尚未发布的变更，体例与 `.version/RELEASE-v*.md` 一致，发布时直接迁移为 `.version/RELEASE-v<下一个 tag>.md`
- **新增 `AGENTS.md`** — 说明 `.version/` 两类文件的分工、`UNRELEASED.md` 的作用与更新时机、发布迁移顺序，并写明「`RELEASE-v<version>.md` 必须先于版本号落地」这一测试约束（`tests/test-no-subagents.mjs` 第 9 节）
- **`.gitignore`** — 移除对 `AGENTS.md` 的忽略（此前被 `gitnexus analyze` 段忽略，无法入库），保留 `.claude/`、`CLAUDE.md`、`qa.md` 的忽略

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 新增 | `LICENSE-APACHE`、`AGENTS.md`、`.version/UNRELEASED.md`、`tests/test-dev-ask.mjs` |
| 重命名 | `LICENSE` → `LICENSE-MIT` |
| 修改 | `package.json`、`package-lock.json`、`README.md`、`.gitignore`、`extensions/dev-ask.ts` |

## 🔗 Commit History

```
05ad368 docs: 新增 AGENTS.md 说明 .version/UNRELEASED.md 的作用
f2d7491 chore(license): 改为 MIT 与 Apache-2.0 双协议并行
```
