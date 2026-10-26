# Release v0.12.0

> 核心变化：意图识别轮询间隔由 2 秒收紧到 500ms，等待上限放宽到空闲 20 分钟 / 整体 30 分钟；同时修复 titanium 主题在官方 Pi 1.4.0 中的加载失败。

## 🚀 Features
- 意图识别轮询间隔由 2 秒收紧到 500ms，代理产出复述后不再多等最多 2 秒。审查报告检测与 `pollFor` 默认间隔一并收紧到 500ms。
- 复述环节的等待上限放宽：空闲阶段由 5 分钟延长到 20 分钟，整体绝对上限由 15 分钟延长到 30 分钟，长复述或需要大量只读探查的任务更少误触超时重试。代理忙碌期间仍不计时。

## 🐛 Bug Fixes
- titanium 主题改用官方 Pi Schema，移除不受支持的状态栏和 Python 模式颜色字段，消除加载时的 `Invalid theme` 错误。
- 新增主题回归测试，使用官方 Pi 的严格校验器和加载器检查仓库主题，并验证 titanium 的名称、主要配色与导出背景。

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 修改 | `extensions/pre-check.ts`、`extensions/review-detect.ts`、`extensions/session-utils.ts`、`README.md`、`themes/oh-my-pi-titanium.json` |
| 新增 | `tests/test-themes.mjs` |
| 版本 | `package.json`、`package-lock.json`、`.version/RELEASE-v0.12.0.md`、`.version/UNRELEASED.md` |

## 🔗 Commit History

```
97f2f40 perf(pre-check): 意图识别轮询改为 500ms，空闲上限 20 分钟、绝对上限 30 分钟
90cbbc1 docs(changelog): 记录 titanium 主题修复与回归测试
8ffb2dd test(theme): 增加官方 Pi 主题加载回归测试
c0a30f9 fix(theme): 修复 titanium 与官方 Pi 的兼容性
```
