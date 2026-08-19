# dsh-compaction-tool 安装与部署指南（中文）

本指南把 `dsh-compaction-tool` 装进一个正在运行的 DSH profile，并解释**为什么这样挂**、
**怎么挂**、以及**和内置压缩如何共存**。

## 1. 它是什么类型的插件（决定挂哪里）

DSH 里一切能力都是 `cordis.yml` 里的一行。判断一行属于**宿主平面**还是**agent preset**，标准是：
**是否要跨会话共享**。

`dsh-compaction-tool` 满足：

- **只消费** host 服务：`tools`（注册工具）、`llm`（模型调用）、`tokenMeter`（计价）；
- **不提供**任何 service；
- 注册的是**模型可见的工具 + 人的命令**（per-session 贡献）。

所以它和 `tool-bash` / `tool-todo` / `tool-web` 完全同类——**松挂在 agent preset 里即可，不需要
`isolate` realm**。realm 只用于「preset 拥有、且要对外提供」的 service（如 `compaction`、`workflows`）。
把它错放进一个 `isolate` realm 反而会让 `ctx.get("tokenMeter")` 之类解析到错误的作用域。

> 如果希望它对**所有 preset / 所有会话**可用，也可以挂到宿主 composition（`base.cordis.yml`）——
> 因为工具注册进 host 的 `tools` registry、`tokenMeter`/`llm` 本来就是 host 服务，单实例即可服务所有会话。
> 二选一即可，不必都挂。

## 2. 安装步骤（官方 CLI，推荐）

```bash
# 1) 发布或链接包到可解析位置（npm 仓库 / git / file:）
# 2) 一条命令安装 + 挂载
dsh plugin --profile web add dsh-compaction-tool@0.1.0
```

该命令做了三件事（和 `dsh-lmstudio-long-prefill` 的机制一致）：

1. 把包写进 profile `package.json` 的 `dependencies` + `dsh.profile.bundles`；
2. 在 profile 目录跑 `pnpm install`（`file:`/git/registry 皆可）；
3. 看到本包 `package.json` 里的 `dsh.bundle.patch`（= `cordis.patch.yml`），把**一行插件行**合并进
   组合树。无需手改 profile 文件。

> 若 profile 已有本插件的旧手动挂载行，切到 bundle 通道前删掉它，避免**双重挂载**
> （两个 `compress_context` 工具、两个 `/compact`）。

## 3. 选择压缩模型（关键，不再是硬编码）

压缩用的模型**不是写死的**。它放在一个 settings 命名空间（`compaction`）里——和主模型
选择器用的是同一套机制。改模型有**两个途径**，任选其一：

1. **设置面板（推荐，运行期随时可改）**：打开 **设置 → 压缩（Compaction）**，
   从模型列表里选一个。所有参数（阈值、保留条数、最大 token、自动压缩开关）也都可以
   在这里改。**改动实时生效**——无需重启、无需改代码。
2. **配置默认值**：`secondaryModelProvider` / `secondaryModelName` 是这个选择的**初始值**
   （composition `base`）。在 profile 的 `cordis.patch.yml` 里用 id 覆盖（该层在所有 bundle 层
   之后应用，`config` 是**整体替换**）：

```yaml
# cordis.patch.yml（profile 层）
- id: compaction-tool
  config:
    thresholdRatio: 0.8
    keepLastNTurns: 3
    keepLastNMessages: 10
    secondaryModelProvider: 'lmstudio'               # ← 默认 provider
    secondaryModelName: 'nvidia/nemotron-3-nano-4b'  # ← 默认快模型
    summaryMaxTokens: 1024
    autoCompaction: false
```

> 若两者都没设（都为空），压缩会**继承会话路由**（即用主模型做总结——失去「快」的意义）。
> 所以至少给一个默认值，或装好后在**设置面板 → 压缩**里选一个。

**选副模型的建议：**

- 要**快**：参数量小（3B~7B 级）、本地可跑（如 LM Studio / vLLM / llama.cpp 的 OpenAI 兼容端点）；
- 要是**推理模型**（先 reasoning 后正文），把 `summaryMaxTokens` 调到 1500~2000，给它推理预算；
- provider 走 OpenAI 兼容接口时，`api: openai-completions`、`baseURL` 指向本地端点即可
  （这部分在 `settings.yaml` 的 provider profile 里配，和主模型同一个 provider 也可以）。

## 4. 与内置压缩共存

`standard` preset 默认挂了：

```yaml
- id: compaction
  group: true
  isolate: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
      config: { auto: true, thresholdRatio: 0.8, ... }
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
```

本插件是**独立的另一条**压缩路径。二者关系：

| 场景 | 结果 |
| --- | --- |
| 只挂本插件 | `compress_context` 工具 + `/compact` 命令，走副模型。 |
| 只挂内置 | 内置 `/compact` + 自动压缩，走主模型。 |
| 两者都挂 | 允许，但会有**两个 `/compact`**（同名冲突，UI 可能只认其一）和**两个自动钩子**。`compaction/start`/`end` 标记会让二者**不会同时压缩同一段**（互斥锁），但体验冗余。 |

**推荐**：以本插件为主路径时，在 `cordis.patch.yml` 里把内置那两行 disable 掉：

```yaml
- id: compaction-basic
  disabled: true
- id: command-compact
  disabled: true
```

## 5. 验证是否挂上

```bash
dsh --profile web --dump-config | grep -A 10 'id: compaction-tool'
```

应看到本插件行 + 你的配置。新开一个会话，工具列表里应出现 `compress_context`，命令菜单里应有 `/compact`。

## 6. 回滚

- 卸载：`dsh plugin --profile web remove dsh-compaction-tool`（或从 `package.json` 删依赖 + `pnpm install`）；
- 临时禁用：在 `cordis.patch.yml` 加 `- id: compaction-tool` / `disabled: true`；
- 恢复内置：把第 4 步的 disable 去掉。

## 7. 常见问题

- **`/compact` 报 failed / 副模型没响应**：确认 `secondaryModelProvider/Name` 指向的模型在本机可用、
  provider 的 `baseURL` 可达；副模型是推理模型时调大 `summaryMaxTokens`。
- **工具返回 `skipped`**：占用低于阈值——属正常。要立即压缩就 `/compact`（命令恒为 `force`）或带 `force: true`。
- **取消**：主模型回合被中止时，总结调用会随 `AbortSignal` 一起中止，返回 `cancelled`，会话不变。
