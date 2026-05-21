# Release v0.4.2

## 🚀 Features

- **Esc 双击确认停止机制** — 工作流运行期间，首次按 Esc 提示再次确认，3 秒内双击才终止工作流，避免误触中断
- **Grill 交互增强**
  - 选项标签超长时自动截断，完整文本显示在 description 中
  - 输入框上方增加实时换行预览区域
  - 左方向键支持返回上一题
  - 优化导航提示文字
- **独立超时配置** — reviewer 子代理新增 `reviewTimeoutMs` 独立超时，不再与 worker 共用超时时间（trimmer: 20min, worker: 30min, reviewer: 15min）
- **新主题** — 添加 `oh-my-pi-titanium` 主题
- **循环计数显示** — loop-group 在工作时正确显示 `第 N 次循环`，时序与执行同步

## 🐛 Bug Fixes

- **Git diff 解析** — 改用简单字符串分割替代正则匹配，避免解析出 `checkpoint-${planId}.json`、`[],\n\t\t\t\toutputs:` 等垃圾条目
- **循环计数器时序** — 修复循环计数从 planner 进入 loop 时显示错误（0→1→1→2 的问题），现正确为 0→1→2→3
- **超时显示位置** — 超时时间从 loop 组迁移到具体的子代理步骤上，显示更准确
- **工作流状态重置** — 修复 sub-step 状态重置函数名错误

## 🔧 Refactor

- UI 循环计数显示重构，子步骤时长/超时信息改进
- 文件变更检测支持 git 标准状态码（M/A/D）

## 📦 Files Changed

```
41 files changed, 7351 insertions(+), 62 deletions(-)
```
