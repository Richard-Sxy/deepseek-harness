# Agent Loop 模块学习笔记

## 摘要

`@deepseek-ai/dsh-agent-loop` 是 DeepSeek Harness 默认的 Agent 驱动器。它负责创建或恢复 Agent，把输入组织成 Turn 和 Step，调用 LLM、接收流式响应、执行工具，并把所有影响模型上下文的事实写入 Session 日志。

profile 是一份可以启动的插件组合，位于 $DSH_HOME/profiles/<name>/ 他的 manifest 用 dsh.profile.bundles 声明由哪些 bundle 按什么顺序组成。
bundle 是一个包，通过dsh.bundle.patch 指向一份 cordis.patch.yml 层。

挂载：
    启动器把各层 patch 按顺序叠起来，交给 Cordis Loader
    Loader对每一行 -id/name/config 导入对应包、运行他的 apply 或服务类，注册的事件监听/服务就生效了。
    如果 ~/.dsh/profile/<name> 为空，有一段代码会自动发现


agent-loop是对话主干，不是可选扩展

可以把它理解为整个 Agent 运行过程的调度器：

```text
接收输入
  → 打开 Turn
  → 组装提示词和工具 Schema
  → 打开 Step
  → 构造并发送模型请求
  → 保存模型回答
  → 执行 Tool Call
  → 把结果交给下一 Step
  → 没有后续工作时关闭 Turn
```

Agent Loop 不实现模型、工具、沙箱或持久化，而是通过 Cordis 服务和事件把这些插件连接起来。

## Agent 与 Agent Loop 的区别

| 组件 | 责任 |

| `dsh-agent` | 定义 `Agent` 接口、Agent Registry、Inbox 类型和 `agent/*` 事件 |
| `dsh-agent-loop` | 提供默认的 `Agent` 实现，真正运行 Turn、Step、LLM 和工具循环 |
| `dsh-session` | 保存不可变事件，并从事件派生模型消息 |
| `dsh-system-prompt` | 组装 System Prompt 和工具 Schema |
| `dsh-llm` | 选择 Provider、准备调用并返回模型流 |
| `dsh-tools` | 注册和执行模型调用的工具 |

普通消费者通过 `ctx.agents.create()` 或 `ctx.agents.resume()` 使用 Agent，不需要直接依赖 `ReactLoopAgent`。

## Turn、Step 和 Attempt

### Turn

Turn 是 Agent 响应一批用户工作的完整过程。它从 `turn/start` 开始，在模型完成、输入被拒绝、达到 Token 上限、取消、错误或 Agent 销毁时以 `turn/end` 结束。

### Step

Step 是**一次模型请求**以及该回答产生的工具执行。一个 Turn 可以包含多个 Step：

```text
Step 1：模型请求 → 模型调用 read
Step 2：携带 read 结果再次请求模型 → 模型调用 edit
Step 3：携带 edit 结果请求模型 → 模型给出最终回答
```

因此，一条用户消息不一定只触发一次模型请求。

### Attempt

一次 Step 中的模型请求可以失败并重试。每次**实际的模型流调用**都是一个 Attempt。

重试不会重新执行 System Prompt 组装、`agent/pre-step` 或用户消息准入。失败的流记录为 `assistant/attempt`，最终成功的流记录为 `assistant/message`。

## 输入 Inbox

Agent Loop 维护两个待处理输入队列：

| 队列 | 来源 | 行为 |
|---|---|---|
| `next-turn` | `agent.followup()` | 开启新的 Turn |
| `next-step` | `agent.steer()`、`agent.inject()`、工具附加上下文 | 在当前 Turn 的下一个 Step 进入模型 |

三种输入方式的区别：

```text
followup(message)
  → 放入 next-turn
  → 唤醒 Agent
  → 通常开始一个新 Turn

steer(message)
  → 放入 next-step
  → 唤醒 Agent
  → 尽快进入当前 Turn 的下一 Step

inject(message)
  → 放入 next-step
  → 不主动唤醒 Agent
  → 等待其他输入或工具结果触发下一 Step
```

在 Turn 的第一个边界，循环领取全部 `next-step` 输入和一条 `next-turn` 输入；后续 Step 只领取 `next-step`。

Inbox 不是临时内存数组。每次插入、替换、移除和领取都会写入 `agent/inbox/spliced`，因此 Agent 重启、Session 恢复和冷读取都可以重建尚未处理的消息。实现位于 [`packages/core/agent-loop/src/inbox.ts`](../packages/core/agent-loop/src/inbox.ts)。

## 一次完整运行流程

```text
agent.followup(message)
  → message 写入持久 Inbox
  → Agent 从 idle 进入 running
  → 写入 turn/start
  → 领取 next-step 和一条 next-turn
  → System Prompt assemble()
  → 生成运行时上下文快照
  → agent/pre-step
      ├─ reject：Turn 以 blocked 结束
      └─ enter：继续
  → 写入 step/start
  → agent/request 解析请求配置
  → llm.prepareCall() 绑定具体 Adapter
  → 协调 system/message
  → 首次 Attempt 写入 user/message
  → 写入 request/header 和 request/context
  → Session.deriveMessages()
  → 冻结请求
  → LLM 流式调用
  → agent/assistant-stream
  → 写入 assistant/message 或 assistant/attempt
  → 提取 tool-call
  → 执行工具并写入 tool/call、tool/result
  → 写入 step/end
  → 有 next-step 输入：继续下一个 Step
  → agent/turn-stopping
  → 写入 turn/end
  → Agent 返回 idle
```

核心状态机位于 [`packages/core/agent-loop/src/agent.ts`](../packages/core/agent-loop/src/agent.ts)。

## 模型请求怎样构造

Agent Loop 不直接维护另一份聊天记录。请求消息必须从 Session 日志派生：

```text
Session 事件
  → Surface 投影
  → session.deriveMessages()
  → 冻结 messages
  → LLM Request
```

请求包含：

- Provider 和 Model。
- 推理强度、输出 Token 上限等模型配置。
- `Session.deriveMessages()` 得到的消息历史。
- 当前 Agent 可见的 Tool Schema。
- Session ID。
- 当前 Turn 的取消信号。

System Prompt 也作为 `system/message` 存在于 Session 历史中，不使用独立的请求 `system` 字段。

`agent-loop` 提供运行时不变式检查，确保请求与 Session 当前派生结果、已记录的 `request/header` 和工具 Schema 一致。这样，模型实际看到的内容可以从持久日志重建。相关实现位于 [`packages/core/agent-loop/src/invariant.ts`](../packages/core/agent-loop/src/invariant.ts)。

## System Prompt 更新

Agent Loop 根据 LLM Adapter 的 `systemPromptUpdate` 能力决定怎样保存提示词。

### 支持 `in-history`

在同一个 Request Series 中，提示词变化可以追加新的 `system/message`，保留前面已经缓存的历史，从而提高 KV Cache 复用率。

### 不支持历史内更新

Agent Loop 会清空后续仍然生效的 System 节点，并把最新提示词写回第一个 System 节点，确保模型只看到一个有效版本。

### 空提示词

空提示词会清除以前仍然生效的提示词，模型不会继续看到旧指令。即使第一次渲染为空，循环也会保留第零个 System 节点的位置。

Request Series 会在以下情况重新开始：

- `agent/pre-step` 显式声明 `startsRequestSeries`。
- Session Surface 自上次请求后发生替换。
- 图片接纳或省略决定改变 Surface。
- 可见工具 Schema 发生变化。

实现位于 [`packages/core/agent-loop/src/runtime-context.ts`](../packages/core/agent-loop/src/runtime-context.ts)。

## 流式输出

模型流有两条记录路径：

```text
实时路径：agent/assistant-stream
持久路径：assistant/message 或 assistant/attempt
```

`agent/assistant-stream` 依次发送 `start`、零个或多个 `chunk` 和一个 `end`。每个 Attempt 都有唯一 ID 和连续 Revision。`end` 只有在对应的持久事件成功写入后才标记为 `committed`；无法写入时标记为 `abandoned`。

完整成功回答写入 `assistant/message`。失败、重试或没有可安全展示内容的中断写入 `assistant/attempt`，但不会进入后续模型历史。实现位于 [`packages/core/agent-loop/src/assistant-stream.ts`](../packages/core/agent-loop/src/assistant-stream.ts)。

## 工具调用调度

模型一次回答可以产生多个 Tool Call。Agent Loop 根据每个工具的实时执行模式进行调度。

### 并行安全工具

返回 `parallel` 的调用进入有界滚动池，同时运行数量受 `maxParallelToolCalls` 限制，默认值为 `10`。

### 独占工具

独占调用形成顺序屏障：

```text
并行调用 A、B
  → 等待 A、B 完成
  → 独占调用 C
  → C 完成
  → 后续并行调用 D、E
```

即使并行工具的完成顺序不同，`tool/result`、工具附加上下文和 `concludesTurn` 决定仍按模型产生的顺序提交。

执行模式会在调用真正开始前重新检查，因此前一个工具对注册表的修改可以影响后续尚未启动的调用。实现位于 [`packages/core/agent-loop/src/tool-calls.ts`](../packages/core/agent-loop/src/tool-calls.ts)。

## 取消行为

`agent.cancel()` 使用合作式取消，不会直接强制结束同进程 Promise。

默认取消会：

- 中止当前 Turn。
- 清空 `next-step` 和 `next-turn`。
- 阻止尚未分发的模型 Tool Call 执行。
- 等待已经启动的工具收敛。
- 以 `aborted` 原因关闭 Turn。

使用 `keepInbox: true` 时，待处理输入会保留，但已经被当前 Turn 领取的输入不会自动放回队列。

如果模型已经向用户流式输出了一部分内容，取消会把能够安全组装的可见前缀保存为带有 `interrupted: true` 的 `assistant/message`。如果没有可见内容，则只写入 `assistant/attempt`。

模型已经生成但尚未开始执行的 Tool Call 会获得合成结果：

```text
Error: tool call aborted before dispatch
code: ABORTED_BEFORE_DISPATCH
```

这样，Session 回放时仍然保持完整的 Tool Call 与 Tool Result 配对。

## 创建、恢复与销毁

### 创建

`ctx.agents.create()` 的生命周期事务为：

```text
准备 Session
  → 获取持久化写句柄
  → 创建 Agent Scope 和 ReactLoopAgent
  → 执行可选 setup()
  → 注册 Session
  → 注册 Agent
  → 发布 session/created
  → 串行等待 agent/created
  → Agent 对外可用
```

任一步失败都会回滚已经准备的资源。

### 恢复

`ctx.agents.resume()` 会：

1. 以写模式打开持久 Session，阻止同一 ID 被并发恢复。
2. 读取物理上有效的事件。
3. 为进程崩溃留下的未关闭 Turn 补充中断结束事件。
4. 从日志恢复 Session 和 Inbox。
5. 创建新的运行时 Agent。
6. 完成 setup 和发布流程。

### 销毁

销毁顺序为：

```text
停止 Agent
  → 等待活动 Turn 和工具收敛
  → 撤销 Agent Scope
  → Flush 并关闭 Session 写句柄
  → 从 Agent Registry 移除
  → 从 Session Registry 移除
```

多方同时触发销毁时会共享同一个记忆化 Promise，避免重复拆除和竞态。生命周期管理位于 [`packages/core/agent-loop/src/index.ts`](../packages/core/agent-loop/src/index.ts)。

## 主要扩展事件

| 事件 | 类型 | 用途 |
|---|---|---|
| `agent/created` | serial | Agent 发布前执行初始化 |
| `agent/pre-step` | waterfall | 修改或拒绝本 Step 的输入 |
| `agent/request` | waterfall | 修改 Provider、Model 和请求配置 |
| `agent/request-error` | waterfall | 决定失败请求是否重试 |
| `agent/assistant-stream` | emit | 发布实时模型流 |
| `agent/turn-stopping` | serial | Turn 即将结束时检查是否继续 |
| `agent/status` | emit | 发布 `idle` 或 `running` 状态变化 |
| `agent/error` | emit | 报告当前 Turn 或 Step 的错误 |
| `agent/disposed` | emit | Agent 生命周期结束 |
| `agent-loop/config-start-failed` | emit | 声明式 Agent 启动失败 |

Waterfall 监听器必须调用 `next()` 才会把控制权交给后续监听器。

## 配置

主要配置如下：

```yaml
- name: '@deepseek-ai/dsh-agent-loop'
  config:
    maxParallelToolCalls: 10
    agents:
      - id: main
        provider: deepseek
        model: deepseek-chat
        reasoningEffort: high
        maxTokens: 8192
        cwd: /workspace
```

| 字段 | 含义 |
|---|---|
| `maxParallelToolCalls` | 每个 Step 允许同时运行的并行安全工具数量 |
| `agents[].id` | 声明式 Agent 的稳定标签 |
| `provider` / `model` | 初始模型路由 |
| `reasoningEffort` | 初始推理强度 |
| `maxTokens` | 单次模型请求的输出上限 |
| `cwd` | 新 Session 的工作目录 |
| `sessionId` | 使用指定 ID 创建 Session；重新挂载时恢复已实体化的历史 |
| `resumeSessionId` | 恢复已经存在的持久 Session |

精确、完整的配置字段以生成的 [`docs/config-catalog.md`](../docs/config-catalog.md) 为准。

## 插件边界

Agent Loop 负责标准的“调用模型、执行工具、再次调用模型”生命周期。下列能力应通过扩展点实现，而不是直接修改循环：

| 要增加的能力 | 扩展方式 |
|---|---|
| 新模型 | 注册 `ctx.llm` Adapter |
| 新工具 | 注册到 `ctx.tools` |
| 请求策略 | 监听 `agent/request` |
| 输入过滤 | 监听 `agent/pre-step` |
| 重试策略 | 监听 `agent/request-error` |
| Turn 预算 | 监听 `agent/turn-stopping` 并取消 |
| Prompt 内容 | 注册 System Prompt Section |
| 持久状态 | 增加 Session Event 和投影 |
| 特殊 Agent 生命周期 | 实现另一个 `AgentFactory` |

## 当前限制

- `maxParallelToolCalls` 只能限制声明为并行安全的工具。
- 并行安全分类是单个调用级别的；需要比较多个调用是否争用同一资源时，应把工具保持为独占。
- 省略稳定 `sessionId` 时，声明式 Agent 每次启动会创建新 Session。
- 声明式 Agent 没有逐 Agent 的 persona 或 setup 回调；复杂组合需要使用编程式 API。
- Agent Loop 没有内置最大 Step 数或 Turn 预算，失控循环需要外部策略通过生命周期事件取消。
- 插件异常会结束当前 Turn，但 Driver 会保留，后续输入仍可启动新 Turn。

## 核心源码路径

| 文件 | 责任 |
|---|---|
| [`packages/core/agent-loop/src/index.ts`](../packages/core/agent-loop/src/index.ts) | 插件入口、配置、Agent 创建、恢复、发布和销毁 |
| [`packages/core/agent-loop/src/agent.ts`](../packages/core/agent-loop/src/agent.ts) | Inbox、Turn、Step、模型请求和取消状态机 |
| [`packages/core/agent-loop/src/inbox.ts`](../packages/core/agent-loop/src/inbox.ts) | 持久 Inbox 投影和结构化修改 |
| [`packages/core/agent-loop/src/assistant-stream.ts`](../packages/core/agent-loop/src/assistant-stream.ts) | 模型流累积、实时帧和持久结算 |
| [`packages/core/agent-loop/src/tool-calls.ts`](../packages/core/agent-loop/src/tool-calls.ts) | 工具独占屏障、有界并行池和顺序提交 |
| [`packages/core/agent-loop/src/runtime-context.ts`](../packages/core/agent-loop/src/runtime-context.ts) | System Prompt 与运行时上下文投影 |
| [`packages/core/agent-loop/src/invariant.ts`](../packages/core/agent-loop/src/invariant.ts) | 模型请求的日志重建不变式 |

## 推荐阅读顺序

1. 阅读包说明：[`packages/core/agent-loop/README.zh.md`](../packages/core/agent-loop/README.zh.md)。
2. 阅读 Agent 接口和事件：[`packages/core/agent/README.zh.md`](../packages/core/agent/README.zh.md)。
3. 阅读核心状态机：[`packages/core/agent-loop/src/agent.ts`](../packages/core/agent-loop/src/agent.ts)。
4. 对照生命周期图：[`docs/agent-lifecycle.zh.md`](../docs/agent-lifecycle.zh.md)。
5. 阅读工具调度：[`packages/core/agent-loop/src/tool-calls.ts`](../packages/core/agent-loop/src/tool-calls.ts)。
6. 阅读创建和恢复事务：[`packages/core/agent-loop/src/index.ts`](../packages/core/agent-loop/src/index.ts)。
7. 最后查看 Core 子系统事件与公共 API：[`docs/subsystems/core.zh.md`](../docs/subsystems/core.zh.md)。

如果只记住一条主线，可以记成：

```text
Inbox 保存待处理输入
  → Turn 组织一轮工作
  → Step 组织一次模型调用与工具执行
  → Session 保存所有模型可见事实
  → 工具结果或 Steering 触发下一 Step
  → 没有待处理工作时结束 Turn
```
