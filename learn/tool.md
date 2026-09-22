# Tool 模块学习笔记

## 摘要

DeepSeek Harness 的 Tool 是模型可以主动调用的结构化能力。工具插件把名称、说明和参数 Schema 注册到 `ctx.tools`，系统在每次模型请求前把当前 Agent 可见的工具 Schema 交给模型；模型根据用户请求和工具说明生成 `tool-call`，Agent Loop 再执行工具、记录结果，并把结果加入下一次模型请求。项目没有独立的工具意图分类器，工具选择由模型完成，Harness 负责可见性、参数校验、权限策略、调度、执行、持久化和错误处理。

## Tool 是什么

Tool 可以理解为提供给模型调用的函数，但它比普通函数多出以下约束：

- 模型只能看到工具名称、功能说明和参数 Schema。
- Harness 在执行前校验模型生成的参数。
- 工具调用经过统一的权限和执行管线。
- 工具结果必须转换为模型能够读取的内容块。
- 调用和结果写入 Session，后续模型请求可以重建完整历史。
- 每个调用都携带取消信号，工具实现需要合作处理取消。

Tool、Plugin 和 Skill 的区别：
| 概念 | 作用 |
|---|---|
| Tool | 模型在运行过程中主动调用的结构化函数 |
| Plugin | 向 Cordis Context 注册服务、工具、事件监听器或策略的代码模块 |
| Skill | 提供工作方法、规则和参考资料，指导模型怎样完成一类任务 |

一个 Plugin 可以注册一个或多个 Tool；Skill 可以告诉模型什么时候、以什么步骤使用这些 Tool。

## 模型怎样选择工具
### 每一次模型请求都会发送 tool list

项目没有单独执行文本分类或关键词匹配。`ctx.tools` 把每个可见工具投影为以下模型可见信息：

```text
工具名称
工具描述
参数 JSON Schema
```

Headless Profile -> 每一次调用大模型都会发送工具的
```
job_output job_list job_kill
read read_image write edit glob grep
skill exit_plan_mode
send_message interrupt_agent list_agents subagent subagent_fork
workflow
todo_write get_goal create_goal update_goal
web_search web_fetch
```

模型结合用户消息、系统提示词和工具 Schema，自行决定：

1. 是否调用工具。
2. 调用哪个工具。
3. 参数填写什么。
4. 收到结果后是否继续调用其他工具。

只有 `name`、`description` 和 `parameters` 会进入模型请求。`execute`、输出处理、并发标记、超时和 UI 展示回调不会发送给模型。投影实现位于 [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts)。

## 一次工具调用的完整流程

```text
工具插件调用 ctx.tools.register()
  → ToolRuntime 保存 ToolDefinition
  → SystemPrompt 组装当前 Agent 可见的 ToolSchema  ⭐️
  → LLM 收到消息历史和工具 Schema
  → 模型输出 tool-call 内容块
  → Agent Loop 提取全部 tool-call
  → Session 写入 tool/call
  → ToolRuntime 执行权限和策略管线(完整的流程处理成多个步骤，顺序执行步骤)
  → 工具主体执行并返回规范值
  → ToolRuntime 渲染、整理并冻结结果
  → Session 写入 tool/result
  → 下一 Step 从 Session 派生包含工具结果的模型消息
```

Agent Loop 提取模型工具调用的入口位于 [`packages/core/agent-loop/src/agent.ts`](../packages/core/agent-loop/src/agent.ts)。调度和 Session 记录位于 [`packages/core/agent-loop/src/tool-calls.ts`](../packages/core/agent-loop/src/tool-calls.ts)。

## 核心组件与源码入口

| 组件 | 责任 | 源码 |

| ToolRuntime | 工具注册、可见性、Schema 投影和执行管线 | [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts) |
| Tool 类型 | 定义 ToolDefinition、ToolExecution、执行结果、策略决定和事件 | [`packages/core/tools/src/types.ts`](../packages/core/tools/src/types.ts) |
| defineTool | 从类型化 DSL 生成参数 Schema，并在运行时校验参数 | [`packages/core/tools/src/schema.ts`](../packages/core/tools/src/schema.ts) |
| JSON Schema | 校验项目支持的原始 JSON Schema 子集 | [`packages/core/tools/src/json-schema.ts`](../packages/core/tools/src/json-schema.ts) |
| UI 展示描述 | 定义工具卡片的 Host 展示意图 | [`packages/core/tools/src/presentation.ts`](../packages/core/tools/src/presentation.ts) |
| PTC 模式 | 生成 SDK，通过 `run_code` 调用其他工具 | [`packages/core/tools/src/ptc.ts`](../packages/core/tools/src/ptc.ts) |
| Agent Loop 调度 | 执行模型产生的一组工具调用，处理并行、独占和取消 | [`packages/core/agent-loop/src/tool-calls.ts`](../packages/core/agent-loop/src/tool-calls.ts) |
| Agent Step | 从模型回答提取 `tool-call` 并进入工具调度 | [`packages/core/agent-loop/src/agent.ts`](../packages/core/agent-loop/src/agent.ts) |
| System Prompt | 汇总工具 Schema 与其他 Prompt 内容 | [`packages/core/system-prompt/src/index.ts`](../packages/core/system-prompt/src/index.ts) |

## ToolDefinition 的核心内容

一个工具定义包含两类信息。

### 模型可见部分

```text
name         工具名称
description  工具能够做什么以及何时使用
parameters   参数 JSON Schema
```

这些字段决定模型是否能够正确选择工具和生成合法参数。

### 仅运行时可见部分

```text
output             输出 Schema 和模型内容渲染
execute            工具主体
finalizeContent    最终内容修正
timeoutMs          合作式超时预算
isConcurrencySafe  是否允许与同组调用并行
presentCall        Host 端调用展示
presentResult      Host 端结果展示
```

核心接口位于 [`packages/core/tools/src/types.ts`](../packages/core/tools/src/types.ts)。类型化工具构造器位于 [`packages/core/tools/src/schema.ts`](../packages/core/tools/src/schema.ts)。

## 工具注册与可见性

工具通过以下入口注册：

```text
ctx.tools.register(toolDefinition)
```

注册返回 disposer。插件卸载时调用 disposer，工具会从注册表和后续模型请求中消失。注册实现位于 [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts)。

ToolRuntime 支持全局工具和 Agent Scope 工具：

- 全局工具可以被所有 Agent 继承。
- 通过 `agent.ctx` 注册的工具只属于该 Agent 的 Scope。
- 同名 Scope 工具可以覆盖继承的工具。
- `ctx.tools.restrict()` 可以对一个 Agent 使用 allow/deny 过滤器。
- 多个限制取交集，任意限制都可以移除继承工具。

可见性解析、限制和 Scope 覆盖都集中在 [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts)，避免“模型看到的工具”和“实际能够执行的工具”使用不同规则。

## 参数和输出校验

`defineTool()` 把项目的类型化参数 DSL 转换成 JSON Schema，并包装工具主体：

```text
模型参数
  → 转换为无损 JSON 快照
  → 深度冻结
  → 按参数 Schema 校验
  → 执行工具主体
  → 按输出 Schema 校验返回值
  → output.render() 转换为模型内容块
```

参数不合法时，工具主体不会按正常路径执行。工具返回不符合输出 Schema 时，系统产生 `INVALID_TOOL_OUTPUT` 错误。普通工具错误会被转换成结构化工具结果，不会直接结束整个 Agent Turn。

`defineTool()` 的实现位于 [`packages/core/tools/src/schema.ts`](../packages/core/tools/src/schema.ts)。输出校验和错误规范化位于 [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts)。

## 执行管线

每个工具调用依次经过：

```text
tools/pre-execute
  → ToolGuard
  → tools/execute
  → 工具主体 execute()
  → tools/post-execute
  → definition.finalizeContent()
  → tools/result
```

### tools/pre-execute

这是执行前的 waterfall。监听器可以返回：

- `allow`：允许继续。
- `deny`：拒绝并返回原因。
- `cancel`：作为取消处理。
- `ask`：调用 Approval 服务，只有 `allowed-once` 才继续。

### ToolGuard

Guard 在 `tools/pre-execute` 之后同步运行。Guard 只能返回拒绝原因或不做决定，不能强制允许，因此后注册的策略无法把拒绝改回允许。

### tools/execute

这是围绕实际工具主体的 waterfall，适合实现超时、重试和指标采集。包装器可以替换自己生命周期内的取消信号，但 ToolRuntime 会重新融合原始调用者信号，防止包装器切断用户取消。

### tools/post-execute

这是执行后的 waterfall。监听器可以接受结果、替换结果内容、附加下一次请求上下文，或者把结果转成带纠正反馈的失败。

### tools/result

这是只读观察事件。ToolRuntime 在结果完成无损 JSON 化和深度冻结后发送该事件，监听器不能修改最终结果。

执行管线的事件和结果类型位于 [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts) 与 [`packages/core/tools/src/types.ts`](../packages/core/tools/src/types.ts)。

## Approval 与 Tool 的关系

工具系统提供两种审批入口：

1. 通用策略监听器在 `tools/pre-execute` 返回 `ask`。
2. 某个工具在自己的 `execute()` 前主动调用 `ctx.approval.request()`，例如 Bash 沙箱提权。

两种入口最终都等待 `approval/request` waterfall 的回答。Web、ACP 或其他插件可以成为回答者；没有回答者时系统返回 `unavailable` 并拒绝执行。

通用 Tool `ask` 处理位于 [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts)。沙箱一次性提权位于 [`packages/sandbox/sandbox/src/escalation.ts`](../packages/sandbox/sandbox/src/escalation.ts)。

## Session 如何记录工具调用

Agent Loop 在真正调度前追加：

```text
tool/call
```

事件包含 Turn、Step、调用 ID、工具名称和模型产生的原始参数。工具完成或被取消后追加：

```text
tool/result
```

结果事件包含模型可见内容、失败状态、可选结构化错误和 UI 展示元数据，并通过事件序号关联对应的 `tool/call`。下一次模型请求由 Session 日志派生，因此工具结果能够进入模型上下文。

写入位置：

- `tool/call`：[`packages/core/agent-loop/src/tool-calls.ts`](../packages/core/agent-loop/src/tool-calls.ts)
- `tool/result`：[`packages/core/agent-loop/src/tool-calls.ts`](../packages/core/agent-loop/src/tool-calls.ts)
- Session 消息派生：[`packages/core/session/src/index.ts`](../packages/core/session/src/index.ts)

## 并行和独占调用

模型一次回答可以生成多个工具调用。Agent Loop 按工具的 `isConcurrencySafe(args)` 结果调度：

- 精确返回 `true` 的调用可以进入受上限控制的并行池。
- 没有声明、返回非 `true`、参数无效或分类器抛错时按独占调用处理。
- 独占调用构成顺序屏障，需要等待前面的并行调用完成。
- 结果即使并行完成，也按照模型产生调用的顺序写入 Session。

调度实现位于 [`packages/core/agent-loop/src/tool-calls.ts`](../packages/core/agent-loop/src/tool-calls.ts)。ToolRuntime 的调用分类位于 [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts)。

## 取消和超时

ToolRuntime 使用合作式取消：

- 每个工具主体通过 `exec.signal` 接收取消信号。
- 工具需要把该信号传给文件、网络或子进程操作。
- 工具主体开始前取消返回 `ABORTED_BEFORE_DISPATCH`。
- 工具主体开始后取消返回 `ABORTED`。
- ToolRuntime 不会放弃已经开始的 Promise，而是等待工具拥有的工作停止后再完成结果。
- `timeoutMs` 由工具调用超时策略通过 `tools/execute` 包装器执行，不由 ToolRuntime 硬杀同进程代码。

取消状态和信号融合位于 [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts)。

## Native、PTC 和 Both

工具系统支持三种模型展示方式：

| 模式 | 模型看到的工具 |
|---|---|
| `native` | 每个可见工具自己的 Function Calling Schema |
| `ptc` | 只直接看到 `run_code`，并通过生成的 TypeScript 或 Python SDK 在代码中调用其他工具 |
| `both` | 同时看到原生工具和 `run_code` |

`ptc` 模式下，模型直接调用普通工具会得到 `UNKNOWN_TOOL`；普通工具只能由 `run_code` 内生成的 SDK 进行子调用。这保证模型看到的调用方式和运行时允许的调用方式一致。

模式选择和 Schema 投影位于 [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts)，PTC 执行桥位于 [`packages/core/tools/src/ptc.ts`](../packages/core/tools/src/ptc.ts)。

## UI 如何展示工具

工具执行和 UI 展示是分离的：

- Host 端消费者可以读取工具的 `presentCall()` 和 `presentResult()`。
- Web Client 根据持久化的原始调用、结果内容和 `meta` 选择自己的渲染器。
- UI 展示函数必须是纯函数，因为实时调用和 Session 回放都可能再次执行展示逻辑。

Host 展示类型位于 [`packages/core/tools/src/presentation.ts`](../packages/core/tools/src/presentation.ts)。Web 工具卡片从客户端注册的 `tool.call.toolview` 渲染器派生，不直接执行工具定义中的 Host 回调。

## 常见工具家族

| 工具家族 | 用途 | 入口目录 |

| Bash / PowerShell | 执行一次性 Shell 命令 | [`packages/shell`](../packages/shell) |
| Filesystem | 读取、写入、编辑和搜索文件 | [`packages/fs`](../packages/fs) |
| Terminal | 管理持久交互式终端 | [`packages/terminal`](../packages/terminal) |
| Web | 搜索和抓取网页 | [`packages/web`](../packages/web) |
| Subagent | 创建和协调子 Agent | [`packages/subagent`](../packages/subagent) |
| Jobs | 查询和终止后台任务 | [`packages/jobs`](../packages/jobs) |
| Workflow | 执行结构化工作流 | [`packages/workflow`](../packages/workflow) |
| User Questions | 暂停 Agent 并向用户提问 | [`packages/interaction/tool-ask-user`](../packages/interaction/tool-ask-user) |

完整工具名称和 Schema 由 [`docs/tool-catalog.md`](../docs/tool-catalog.md) 生成；需要确认某个工具的精确参数时，应以该目录和对应工具源码为准。

## Tool 和普通命令的区别

用户在聊天输入框中输入的 `/permission` 等 Slash Command 不属于模型 Tool。Command 由人直接触发，不经过模型选择，也不产生普通模型工具调用。

```text
自然语言请求 → 模型 → Tool
Slash Command → Command Registry → 直接执行
```

Command 系统位于 [`packages/interaction/commands`](../packages/interaction/commands)。

## 推荐阅读顺序

1. 先看 Tool 的用户视角：[`packages/core/tools/README.md`](../packages/core/tools/README.md)。
2. 再看核心类型：[`packages/core/tools/src/types.ts`](../packages/core/tools/src/types.ts)。
3. 阅读 `defineTool()`：[`packages/core/tools/src/schema.ts`](../packages/core/tools/src/schema.ts)。
4. 阅读 ToolRuntime 注册和 Schema 投影：[`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts)。
5. 阅读 Agent Loop 调度：[`packages/core/agent-loop/src/tool-calls.ts`](../packages/core/agent-loop/src/tool-calls.ts)。
6. 选择一个具体工具追踪，例如 [`packages/shell/tool-bash/src/index.ts`](../packages/shell/tool-bash/src/index.ts)。
7. 最后阅读完整执行管线：[`docs/tool-execution-pipeline.md`](../docs/tool-execution-pipeline.md)。
