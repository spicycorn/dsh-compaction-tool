# dsh-compaction-tool（DSH 上下文压缩插件）

**把上下文压缩从主模型上剥离，交给一个快速副模型。**

一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 插件：主模型负责思考和回答，轻量快速的副模型只做总结——即便主模型很慢（比如本地 27B 长 prefill），压缩也不会卡住、不会超时。

> 🇬🇧 English docs: **[README.md](./README.md)**

---

## 为什么需要它？

DSH 内置压缩（`dsh-compaction-basic`）用**会话主模型**做总结。当主模型很慢（本地 27B 长 prefill）时，每次压缩都是数分钟的等待，阻塞对话。本插件把总结调用路由到**单独选择的快速模型**——在设置面板里选，零硬编码。

## 入口

| 入口 | 使用者 | 作用 |
|------|--------|------|
| **`compress_context`** | 主模型（工具调用） | 上下文快满时把旧历史总结为持久 checkpoint |
| **`/compact`** | 你（斜杠命令） | 立即强制压缩 |
| **设置 → 压缩** | 你（UI 面板） | 选择压缩模型、调整所有参数——实时生效，无需重启 |
| **自动压缩**（可选） | harness | 压力驱动的 `agent/pre-step` 钩子，默认关闭 |

## 所有设置均可在 UI 中编辑（无硬编码）

每个压缩设置都放在一个 settings 命名空间（`compaction`）里——和主模型选择器同一套机制：

- **设置 → 压缩** 列出可用模型和所有可调参数
- `compress_context` / `/compact` / 自动钩子**每次调用都实时读取**这些设置
- 部署配置只是这些设置的**默认值**（composition `base`）

> 在面板里选哪个模型，下次压缩就用哪个。无需重启、无需改文件。

## 配置项

| 字段 | 默认值 | 含义 |
|------|--------|------|
| `provider` | `""` | 压缩模型 provider（如 `lmstudio`） |
| `model` | `""` | 压缩模型 id（如 `nvidia/nemotron-3-nano-4b`） |
| `thresholdRatio` | `0.8` | 触发自动压缩的上下文占用比例（0..1]） |
| `keepLastNTurns` | `3` | 按「轮」保留的最近尾巴 |
| `keepLastNMessages` | `10` | 按「条」保留的最近尾巴（**优先于 turns**） |
| `summaryMaxTokens` | `1024` | 总结调用的输出 token 上限 |
| `autoCompaction` | `false` | 是否注册压力驱动的 `agent/pre-step` 钩子 |

所有字段都可以在 **设置 → 压缩** 里实时修改，无需重启。

## 工作原理

```
┌──────────────────────────────────────────────────────────────────┐
│  会话上下文窗口                                                  │
│  ┌──────────────────────────────────────┐ ┌───────────────────┐  │
│  │  压缩段（较早的历史）                 │ │  保留尾（最近消息）│  │
│  │  → 副模型总结                        │ │                   │  │
│  └──────────────────────────────────────┘ └───────────────────┘  │
│                         ↓                                        │
│              持久 checkpoint（可重放、可计价）                     │
└──────────────────────────────────────────────────────────────────┘
```

1. **测量** — `tokenMeter.measure` + 副模型上下文窗口
2. **门控** — 占用低于阈值时跳过（除非 `force: true`）
3. **切分** — 头部压缩段 + 最近保留尾，且边界是**工具配对安全**的：切点会自动调整，绝不把一条 assistant 消息里的 tool-call 与其后续 result 事件拆开（与 DSH 内置压缩同一规则）。因此实际保留的尾巴可能比请求值略大；若不存在安全的切分位置——或表层已经存在孤儿 result——插件会干净地拒绝本次压缩，而不是弄坏会话
4. **总结** — 调用**副模型**（`purpose: "compaction"`），复用会话前缀命中 KV cache；若压缩段超过该模型的输入预算（其上下文窗口的 70% 减去 `summaryMaxTokens`，未报告容量时用保守上限）则按 token 预算切成多块、逐块折叠总结——小本地引擎永远不会被要求处理一个超大请求。瞬时性引擎故障（设备丢失、连接重置、5xx/超时）会带退避重试
5. **落地** — 原子 checkpoint：`compaction/start` → `summary` → `user/message (surfaceOp: replace)` → `compaction/end`；若中途失败，会补写自己的结束标记，不会留下陈旧的压缩锁

**提交是原子的**：任何一步失败，会话 surface 都保持原样。

## 结果契约

```jsonc
{
  "status": "success" | "skipped" | "cancelled" | "failed",
  "message": "人类可读说明",
  "stats": { "tokensBefore": 0, "tokensAfter": 0, "nodesShadowed": 0 },
  "summaryText": "…",
  "secondaryModel": { "provider": "lmstudio", "model": "nvidia/nemotron-3-nano-4b" }
}
```

## 安装

```bash
# 官方 CLI（推荐）
dsh plugin --profile <你的profile> add dsh-compaction-tool@0.5.0

# 或手动
cd <profile目录>
npm install file:<路径>/dsh-compaction-tool
```

> **注意：** 如果 DSH 内置压缩正在运行，需要禁用以避免 `/compact` 命令冲突：
> ```yaml
> # cordis.patch.yml
> - id: compaction-basic
>   disabled: true
> - id: command-compact
>   disabled: true
> ```

## 开发

```bash
npm run build   # 把 src/compaction-tool.ts 编成 lib/index.mjs（Node 原生类型剥离）
npm pack        # 生成可发布的 tarball
```

## 项目结构

```
dsh-compaction-tool/
├── src/compaction-tool.ts    # TypeScript 源码（单文件）
├── lib/
│   ├── index.mjs             # 编译后的 host 插件（入口）
│   ├── index.d.ts            # 类型声明
│   └── client.js             # 浏览器端（设置面板）
├── cordis.patch.yml          # Bundle 挂载补丁
├── build.mjs                 # 构建脚本（Node 原生类型剥离）
├── SYSTEM_PROMPT.md          # 模型工具指引（EN）
├── SYSTEM_PROMPT.zh.md       # 模型工具指引（ZH）
├── INSTALL.zh.md             # 详细安装指南（ZH）
├── README.md / README.zh.md  # 本文件
└── LICENSE                   # MIT
```

## 许可证

[MIT](./LICENSE) © 2025
