# Agent Frontmatter 配置参考

所有子代理的行为通过其 `.md` 文件的 YAML frontmatter 配置。  
每个字段对应 `spawnSubagent()` 构造的 pi CLI 参数。

---

## 完整字段一览

```yaml
---
name: <string>            # 必填 — agent 标识名
description: <string>     # 必填 — agent 描述
tools: <csv>              # 工具白名单（逗号分隔）
thinking: <string>        # 推理等级
session: <boolean>        # 是否保存 session
session-dir: <string>     # session 存储目录（默认 .pi-dev-output/pi-subagent-sessions/）
no-context: <boolean>     # 是否跳过 AGENTS.md/CLAUDE.md
no-extensions: <boolean>  # 是否禁用扩展加载
mode: <string>            # 输出模式
extra-args: <string>      # 额外 CLI 参数（空格分隔）
---
```

---

## 字段详解

### `name` — Agent 标识名

- **必填** ✓
- **类型**: `string`
- **作用**: 作为 `subagent` tool 的 `agent` 参数值、日志标识、session 文件名前缀
- **示例**: `planner`, `git-agent`, `review-agent`

### `description` — Agent 描述

- **必填** ✓
- **类型**: `string`
- **作用**: 在工具描述中展示，帮助 LLM 理解该 agent 的用途

### `tools` — 工具白名单

- **类型**: 逗号分隔的字符串
- **作用**: 对应 `--tools` CLI 参数
- **参数范围**: pi 内置工具名（可用 `pi --help` 查看），如 `read`, `bash`, `write`, `find`, `ls`, `grep`, `edit` 等
- **默认值**: 不传 `--tools` 则所有内置工具可用
- **示例**: `tools: read, bash, write, find, ls, grep`

### `thinking` — 推理等级

- **类型**: 字符串
- **作用**: 对应 `--thinking` CLI 参数
- **参数范围**:

| 值 | 说明 | 延迟影响 | Token 影响 |
|----|------|---------|-----------|
| `off` | 关闭推理（纯执行） | 基准 | 基准 |
| `low` | 少量推理 | +20~40% | +30~50% |
| `medium` | 中等推理 | +50~100% | +50~80% |
| `high` | 深度推理 | +100~300% | +100~200% |
| `xhigh` | 极限推理 | +200~500% | +200~400% |

- **建议**:
  - `off` — git 操作、按计划写代码、机械精简
  - `low` — 计划制定、代码审查、设计评审、PRD 编写
  - `medium` — 复杂架构分析、跨模块重构
  - `high` — 安全审计、深层 Bug 追踪
  - `xhigh` — 极其复杂的跨领域分析

### `session` — Session 持久化

- **类型**: 布尔值
- **作用**: 对应 `--no-session` / `--session` CLI 参数
- **参数范围**: `true` | `false`
- **`false`** (默认): 子代理运行结束后不保留交互记录，性能最优
- **`true`**: 保存完整交互记录，便于调试/查看子代理的思考过程

当 `session: true` 时：
  - 自动生成 session 名: `{ISO时间戳}_{agent名称}`
  - 默认存储路径: `.pi-dev-output/pi-subagent-sessions/`
  - 可通过 `session-dir` 自定义路径

### `session-dir` — Session 存储目录

- **类型**: 字符串（路径）
- **作用**: 对应 `--session-dir` CLI 参数
- **仅在 `session: true` 时生效**
- **默认值**: `.pi-dev-output/pi-subagent-sessions/`
- **示例**: `session-dir: /tmp/my-sessions`

### `no-context` — 项目上下文文件

- **类型**: 布尔值
- **作用**: 对应 `-nc` CLI 参数
- **参数范围**: `true` | `false`

| 值 | 行为 | 适用场景 |
|----|------|---------|
| `true` (默认) | 跳过 AGENTS.md / CLAUDE.md | git 操作、纯执行场景 |
| `false` | 加载 AGENTS.md / CLAUDE.md | 需要项目上下文的 agent（架构分析、代码审查） |

### `no-extensions` — 扩展加载

- **类型**: 布尔值
- **作用**: 对应 `-ne` CLI 参数
- **参数范围**: `true` | `false`

| 值 | 行为 | 适用场景 |
|----|------|---------|
| `true` (默认) | 禁用所有扩展，启动更快 | git 操作（仅需 bash） |
| `false` | 加载扩展（MCP 工具、Skill 文件等） | 需要 MCP/Skill 的 agent（计划、审查、文档） |

### `mode` — 输出模式

- **类型**: 字符串
- **作用**: 对应 `--mode` CLI 参数
- **参数范围**: `json` | `text`

| 值 | 行为 | 适用场景 |
|----|------|---------|
| `json` (默认) | JSON 结构化输出，workflow-engine 可解析 | 工作流 agent（planner/worker/reviewer/trimmer/docWriter） |
| `text` | 自然文本输出 | LLM 直接调用的场景 |

**注意**: 工作流引擎依赖 `extractFinalOutput()` 解析 JSON 输出，工作流 agent 必须使用 `mode: json`。

### `extra-args` — 额外 CLI 参数

- **类型**: 字符串（空格分隔多个参数）
- **作用**: 在所有标准参数之后追加，优先级最高
- **用途**: 传递 pi CLI 的其他参数，如 `--verbose`, `--color always`, `--max-tokens 4096` 等
- **示例**: `extra-args: --verbose --max-tokens 4096`

---

## 原始 CLI 参数映射表

以下是对应关系：**原始硬编码参数 → 配置位置**

| 原始参数 | 含义 | 配置方式 |
|---------|------|---------|
| `-p` | 非交互模式 | **始终启用**，不可配置 |
| `--no-session` | 不保存会话 | frontmatter `session: false` 或 `argsOverride.session = false` |
| `-nc` | 禁用上下文文件 | frontmatter `no-context: true` 或 `argsOverride.noContext = true` |
| `-ne` | 禁用扩展发现 | frontmatter `no-extensions: true` 或 `argsOverride.noExtensions = true` |
| `--mode json` | JSON 结构化输出 | frontmatter `mode: json` 或 `argsOverride.mode = "json"` |
| `--thinking off` | 关闭深度思考 | frontmatter `thinking: off` 或 `argsOverride.thinkingLevel = "off"` |
| `--tools ...` | 工具白名单 | frontmatter `tools: read, bash, ...` 或 `argsOverride.tools = [...]` |

**优先级**: `argsOverride` (调用方) > frontmatter > 硬编码默认值

---

## Agent 配置速查表

| Agent | thinking | session | no-context | no-extensions | mode | 适用场景 |
|-------|----------|---------|------------|---------------|------|---------|
| **git-agent** | off | false | **true** ✅ | **true** ✅ | json | 纯 git 命令，最小开销 |
| **planner** | low | false | **false** 🔓 | **false** 🔓 | json | 需 MCP/Skill 分析代码结构 |
| **worker** | off | false | **false** 🔓 | **false** 🔓 | json | 按计划写代码，可调用 MCP |
| **reviewer** | low | false | **false** 🔓 | **false** 🔓 | json | 需 Skill 审查代码 |
| **trimmer** | off | false | **false** 🔓 | **false** 🔓 | json | 精简代码，可用 MCP |
| **docWriter** | off | false | **false** 🔓 | **false** 🔓 | json | 更新文档，可读代码库 |
| **review-agent** | low | false | **false** 🔓 | **false** 🔓 | json | HTML 审查报告 |
| **dev-*-grill-agent** | low | false | **false** 🔓 | **false** 🔓 | json | 设计评审追问 |
| **dev-prd-agent** | low | false | **false** 🔓 | **false** 🔓 | json | PRD 合成 |

> ✅ `true` = 禁用 / 🔓 `false` = 开启

---

## `argsOverride`（调用方覆写）参考

`spawnSubagent()` 第 7 个参数，TypeScript 接口:

```typescript
interface SubagentArgs {
  thinkingLevel?: string;    // "off" | "low" | "medium" | "high" | "xhigh"
  session?: boolean;         // true/false
  sessionDir?: string;       // 自定义 session 路径
  noContext?: boolean;       // true/false
  noExtensions?: boolean;    // true/false
  mode?: string;             // "json" | "text"
  tools?: string[];          // 工具白名单数组
  appendSystemPrompt?: string; // 额外 system prompt
  extraArgs?: string[];      // 原始 CLI 参数
}
```

示例（workflow-engine 中覆写）:

```typescript
const result = await spawnSubagent(agent, task, cwd, signal, timeout, onProgress, {
  thinkingLevel: "medium",    // 临时提升推理等级
  session: true,              // 调试时保存 session
  noExtensions: false,        // 临时开启 MCP
});
```
