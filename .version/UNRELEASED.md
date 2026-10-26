# Unreleased

> 核心变化：修复 titanium 主题在官方 Pi 1.4.0 中因不支持的颜色字段而无法加载的问题，保留主题名称与原有受支持配色。

## 🐛 Bug Fixes
- titanium 主题改用官方 Pi Schema，移除不受支持的状态栏和 Python 模式颜色字段，消除加载时的 `Invalid theme` 错误。
- 新增主题回归测试，使用官方 Pi 的严格校验器和加载器检查仓库主题，并验证 titanium 的名称、主要配色与导出背景。

## 📦 Files Changed

| 类别 | 文件 |
|---|---|
| 修改 | [oh-my-pi-titanium.json](../themes/oh-my-pi-titanium.json) |
| 新增 | [test-themes.mjs](../tests/test-themes.mjs) |

## 🔗 Commit History

```
8ffb2dd test(theme): 增加官方 Pi 主题加载回归测试
c0a30f9 fix(theme): 修复 titanium 与官方 Pi 的兼容性
```
