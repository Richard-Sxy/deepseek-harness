# MCP 模块学习笔记

## 摘要

Model Context Protocol（MCP）是一套连接 Agent Host 与外部能力提供者的协议。MCP Server 可以声明工具、资源和服务器说明；DeepSeek Harness 作为 MCP Client 建立连接，发现这些能力，并把远端工具转换成普通的 DSH Tool。模型仍然只看到工具名称、说明和参数 Schema，真正的网络或进程通信由 DSH、MCP SDK 和 MCP Server 完成。

## 基础知识

⭐️ MCP Server 是一个本地进程或远程 HTTP 服务，接收结构化请求并返回结构化结果。

### MCP的触发机制

1. 把配置硬编码到 cordis.patch.yaml 后，重启 DSH
```
- insert：
  - id: mcp-memory
    name: '@deepseek-ai/dsh-mcp-client'
```

2. Prompt触发：理解就是在 cordis.patch.yaml 注册以后就会把 工具列表输入到文件当中。

我启动 GitHub MCP 来启动项目
@deepseek-ai/dsh-mcp-client

## MCP 和 DSH Tool 的关系

MCP Tool 最终也会成为 DSH Tool。区别只在于工具主体在哪里执行：

| 原生 DSH Tool | DSH 插件中的 `defineTool()` | DSH 进程或受管子进程 |
| MCP Tool | MCP Server 的 `tools/list` 返回值 | 外部 MCP Server |

连接成功后，`dsh-mcp-client` 把 MCP Server 返回的工具定义转换为 DSH 的 `ToolDefinition`，再调用：

```text
ctx.tools.register(definition)
```

因此，MCP Tool 会继续使用 DSH 已有的工具可见性、Guard、执行事件、Session 记录、结果渲染和取消机制。
转换入口位于 [`packages/mcp/mcp-client/src/tools.ts`](../packages/mcp/mcp-client/src/tools.ts)，通用工具运行时位于 [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts)。

## MCP 能提供哪些内容

MCP 协议可以承载多类能力，当前 DSH 主要处理以下内容。

Tools、Resource、Streamable HTTP Server

### Tools

Tool 是模型可以主动调用的结构化函数。Server 提供名称、说明、输入 Schema 和可选输出 Schema，DSH 将其注册到 `ctx.tools`。

例如，Server 原始工具名为：

toolName: create_issue
serverName: github

拼装后 -> mcp__github__create_issue

服务器之间使用不同命名空间，所以两个 Server 都提供 `search` 时不会冲突：

```text
mcp__github__search
mcp__memory__search
```

命名和长度规范化位于 [`packages/mcp/mcp-client/src/tools.ts`](../packages/mcp/mcp-client/src/tools.ts)。当名称包含不支持的字符或超过限制时，系统会规范化名称并附加身份 Hash，避免不同工具变成同一个公开名称。

### Resources

Resource 是 Server 提供的资源(可读取数据，例如文档、记录或动态 URI)。模型必须显式调用以下共享工具：

```text
list_mcp_resources
list_mcp_resource_templates
read_mcp_resource
```

每次调用必须指定 `server`。这些工具由共享的 `mcp-resources` 服务注册，而不是每个 Server 重复注册一组。实现位于：

- [`packages/mcp/mcp-resources/src/index.ts`](../packages/mcp/mcp-resources/src/index.ts)
- [`packages/mcp/mcp-resources/src/tools.ts`](../packages/mcp/mcp-resources/src/tools.ts)

### Server Instructions

MCP Server 可以在连接时返回说明文字。DSH 会给说明加上 Server 标识，并作为该 Agent Scope 的 System Prompt Section：

```text
### MCP server: <serverName>

<server instructions>
```

说明文字按字面内容加入 Prompt，不执行模板插值。默认最大值为 32,768 UTF-8 字节，超出时连接尝试失败。注册入口位于 [`packages/mcp/mcp-client/src/server-context.ts`](../packages/mcp/mcp-client/src/server-context.ts)，大小检查位于 [`packages/mcp/mcp-client/src/connection.ts`](../packages/mcp/mcp-client/src/connection.ts)。

### 当前没有接入的 MCP 能力

当前 DSH 不支持以下 MCP 能力：

- MCP Prompt 模板。
- Human-input Elicitation。
- Task-based Execution。
- Resource Subscription 和资源更新通知。

这些限制由 [`docs/subsystems/mcp.md`](../docs/subsystems/mcp.md) 和 [`packages/mcp/mcp-client/README.md`](../packages/mcp/mcp-client/README.md) 维护。

## 两种连接方式

一个 `mcp-client` 插件实例只负责一个 MCP Server，并使用稳定的 `serverName` 标识它。

### stdio

DSH 启动一个本地子进程，通过标准输入和标准输出交换 MCP 消息：

```yaml
- id: mcp-example
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: example
    transport: stdio
    command: example-mcp-server
    args: []
    env: {}
    cwd: !!js process.cwd()
```

stdio 适合本地 MCP Server。子进程由官方 MCP SDK 启动，不经过 Bash Tool，也不会自动继承 Bash 沙箱。DSH 会先清除名称看起来像凭据的环境变量以及所有 `DSH_*` 变量，再合并配置中显式声明的 `env`。实现位于 [`packages/mcp/mcp-client/src/transport.ts`](../packages/mcp/mcp-client/src/transport.ts)。

### Streamable HTTP

DSH 连接一个已经运行的远程或本地 HTTP MCP 服务：

```yaml
- id: mcp-example-http
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: example
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers: {}
```

HTTP 模式只负责连接，不负责启动或管理远端服务进程。Transport 创建同样位于 [`packages/mcp/mcp-client/src/transport.ts`](../packages/mcp/mcp-client/src/transport.ts)。

## MCP Server 的连接和注册流程

```text
Cordis 加载一个 mcp-client 配置项
  → 校验并占用 serverName
  → 创建 stdio 或 Streamable HTTP Transport
  → 官方 MCP SDK 建立连接并协商协议版本
  → 读取并限制 Server Instructions
  → 调用 tools/list 发现工具
  → 为每个工具生成 mcp__<server>__<tool> 名称
  → 转换为 DSH ToolDefinition
  → 注册到当前 Scope 的 ctx.tools
  → 注册该连接的 Resource Provider
  → 后续模型请求包含新增工具 Schema 和 Server Instructions
```

主要源码入口：

| 组件 | 责任 | 源码 |
|---|---|---|
| 插件入口 | 配置 Schema、`serverName` 占用、等待首次连接 | [`packages/mcp/mcp-client/src/index.ts`](../packages/mcp/mcp-client/src/index.ts) |
| 连接管理 | 建立连接、工具同步、断线重连、资源请求、销毁 | [`packages/mcp/mcp-client/src/connection.ts`](../packages/mcp/mcp-client/src/connection.ts) |
| Transport | 创建 stdio 或 Streamable HTTP Transport | [`packages/mcp/mcp-client/src/transport.ts`](../packages/mcp/mcp-client/src/transport.ts) |
| 工具桥接 | 工具发现、命名、注册、调用和结果转换 | [`packages/mcp/mcp-client/src/tools.ts`](../packages/mcp/mcp-client/src/tools.ts) |
| Server 上下文 | 注册资源 Provider 和 Server Instructions | [`packages/mcp/mcp-client/src/server-context.ts`](../packages/mcp/mcp-client/src/server-context.ts) |
| 资源服务 | 按 Agent Scope 管理 Server 和共享资源工具 | [`packages/mcp/mcp-resources/src/index.ts`](../packages/mcp/mcp-resources/src/index.ts) |

## 模型如何调用 MCP Tool

模型不会直接连接 MCP Server。它只看到转换后的 DSH Tool Schema：

```json
{
  "name": "mcp__github__create_issue",
  "description": "Create an issue in a GitHub repository.",
  "parameters": {
    "type": "object",
    "properties": {
      "title": { "type": "string" }
    }
  }
}
```

当模型输出工具调用时，DSH 使用注册时保存的映射发送原始 MCP 名称：

```text
模型产生：mcp__github__create_issue
DSH 查找：对应的 ToolDefinition
MCP 请求：tools/call { name: "create_issue", arguments: ... }
```

公开名称不会被拆解后再推测原始名称；注册时创建的闭包直接保留原始名称。调用代码位于 [`packages/mcp/mcp-client/src/tools.ts`](../packages/mcp/mcp-client/src/tools.ts)。

## 工具列表会动态变化

MCP Server 可以通知客户端工具列表已经改变。DSH 收到通知后重新执行工具发现，并替换这一 Server 的工具集合。

同步分为两个阶段：

1. 获取完整的新工具列表，并在内存中构造下一代 ToolDefinition。
2. 获取成功后，移除旧工具并注册新工具。

如果第一阶段失败，旧工具继续保留。如果注册新工具时发生名称冲突，本次新集合整体回滚，不会留下只注册一半的状态。同步实现位于 [`packages/mcp/mcp-client/src/tools.ts`](../packages/mcp/mcp-client/src/tools.ts)。

工具列表变化会改变后续模型请求中的工具 Schema，也可能降低前缀缓存复用。工具说明和输入 Schema 在注册期间会进入每次模型请求，因此 MCP Server 暴露的工具越多，输入 Token 成本通常越高。

## 断线和重连

默认情况下，连接断开后会自动重连：

```text
首次延迟：500 ms
最长延迟：30,000 ms
连续失败上限：10 次
```

延迟按指数方式增加。在短暂断线期间，最后一次成功发现的工具仍然出现在模型工具列表中，但实际调用会失败。重连成功后，DSH 会重新同步工具。

达到失败上限后，DSH 注销该 Server 的工具并停止重连；重新加载配置或重启 Host 才会再次尝试。策略和状态机位于 [`packages/mcp/mcp-client/src/connection.ts`](../packages/mcp/mcp-client/src/connection.ts)。

## MCP 结果如何进入 Session

MCP Server 返回的结果首先由官方 SDK 校验，再转换成 DSH 的规范工具结果：

```text
MCP Server 返回 CallToolResult
  → SDK 校验协议和可选输出 Schema
  → isError=true 转成失败的 DSH Tool Result
  → 保留原始 content 和 structuredContent
  → 转换模型可见的文本或图片内容
  → Agent Loop 写入 tool/result
  → 下一次模型请求读取结果
```

结果处理规则包括：

- 文本块按原顺序进入模型可见结果。
- Resource Link 转成包含名称和 URI 的文本。
- 支持的图片在模型支持图片并且 Attachment Store 可用时持久化并进入上下文。
- 图片无法接纳时显示明确的文本诊断，但程序调用者仍可读取原始值。
- Audio 和 Embedded Resource 当前只产生诊断文本，不进入模型富媒体上下文。
- MCP 返回 `isError: true` 时，DSH 把调用记录为失败，而不是伪装成成功文本。

实现位于 [`packages/mcp/mcp-client/src/tools.ts`](../packages/mcp/mcp-client/src/tools.ts)。Session 的通用工具记录流程位于 [`packages/core/agent-loop/src/tool-calls.ts`](../packages/core/agent-loop/src/tool-calls.ts)。

## Scope 和可见性

MCP Server 可以注册在全局 Context 或某个 Agent Scope 中：

- 全局注册的 Server 可以被继承它的 Agent 看见。
- Agent Scope 注册的 Server 只对该 Scope 可见。
- 同一个 Scope 内不能出现重复的 `serverName`。
- 不同 Agent Scope 可以复用相同 `serverName`，连接和工具互相隔离。
- 没有可见 MCP Server 时，不注册共享资源工具，也不加入 MCP Server Prompt。

工具和资源使用相同的 Scope 身份。资源调用会先按调用者 Agent 解析 `server`，找不到时在发送网络请求前失败。Scope 注册位于 [`packages/mcp/mcp-client/src/index.ts`](../packages/mcp/mcp-client/src/index.ts) 和 [`packages/mcp/mcp-resources/src/index.ts`](../packages/mcp/mcp-resources/src/index.ts)。

## 安全边界

MCP Server 是外部能力，应按不可信输入和有权限执行者对待。

- Server 提供的工具名称、说明、Schema、Instructions 和结果都来自外部。
- MCP Tool 会经过 DSH ToolRuntime 的可见性、Guard、事件和结果记录流程，但不会因为使用 MCP 自动获得 Bash 沙箱。
- stdio 子进程由 MCP SDK 启动；DSH 清理环境变量，但 Server 能做什么仍取决于操作系统权限、工作目录和显式传入的凭据。
- HTTP Server 在 DSH 进程之外运行，它的权限和数据处理由该服务自身负责。
- 只把必要的 Token 放进该 Server 的 `env` 或 HTTP `headers`，不要把整个宿主环境复制进去。
- Server Instructions 会进入 System Prompt，所以不应把未知 Server 的说明视为可信业务规则。
- Resource 内容和 Tool Result 可能包含外部文本，模型不应把返回内容当成新的系统指令。

工具调用是否需要人工审批取决于部署的 Tool Guard、Approval 和权限配置；MCP 协议本身不自动弹出审批框。

## MCP、Plugin、Tool 和 Skill 的区别

| 概念 | 作用 |
|---|---|
| MCP | 外部能力发现和调用的通信协议 |
| MCP Server | 通过 MCP 对外提供工具、资源或说明的进程/服务 |
| `dsh-mcp-client` | 连接一个 MCP Server 并把能力接入 DSH 的 Cordis Plugin |
| DSH Tool | 模型能够结构化调用的运行时函数；MCP Tool 接入后也是 DSH Tool |
| Skill | 告诉模型如何完成一类任务，可以指导模型组合原生或 MCP Tool |

MCP 负责“接进来”，ToolRuntime 负责“统一执行”，Skill 负责“教模型怎么用”。

## 一个具体例子

假设配置了名为 `memory` 的 MCP Server，它提供两个工具：

```text
remember
search
```

连接完成后，模型可能看到：

```text
mcp__memory__remember
mcp__memory__search
list_mcp_resources
list_mcp_resource_templates
read_mcp_resource
```

用户说“记住我喜欢无糖咖啡”时，模型可以调用 `mcp__memory__remember`。在新的 Session 中，用户询问偏好时，模型可以调用 `mcp__memory__search`。是否能够跨 Session 找回内容取决于 MCP Server 自己的持久化实现，不是 DSH Session 自动共享记忆。

项目提供了第三方记忆 Server 的配置与验证指南：[`docs/user/guide/mcp-memory.md`](../docs/user/guide/mcp-memory.md)。

## 常见误解

### “MCP 是模型插件系统”

不完全准确。MCP 是通信协议；DSH 的 Plugin 系统负责加载 `dsh-mcp-client`，MCP Server 再通过协议提供外部能力。

### “连接 MCP Server 后，它的数据都会进入上下文”

不会。工具 Schema 和非空 Server Instructions 会进入请求；⭐️ Resource 只有被显式读取后才进入工具结果和对话历史。

### “MCP Tool 绕过 DSH ToolRuntime”

不会。发现的 MCP Tool 会注册为普通 DSH Tool，继续经过 ToolRuntime 和 Agent Loop。

### “配置了 MCP Server，模型一定会调用它”
让工具变得可见；模型仍根据用户请求、System Prompt、工具名称和说明决定是否调用。

### “MCP Server 和 DSH 共用一个沙箱”

不会自动共用。stdio Server 是 MCP SDK 启动的外部进程，HTTP Server 更可能运行在独立环境中。Server 的权限需要单独配置和审计。

## 推荐阅读顺序

1. 阅读 MCP 子系统概览：[`docs/subsystems/mcp.md`](../docs/subsystems/mcp.md)。
2. 阅读 MCP Client 的配置和生命周期：[`packages/mcp/mcp-client/README.md`](../packages/mcp/mcp-client/README.md)。
3. 阅读插件入口：[`packages/mcp/mcp-client/src/index.ts`](../packages/mcp/mcp-client/src/index.ts)。
4. 阅读连接和重连状态机：[`packages/mcp/mcp-client/src/connection.ts`](../packages/mcp/mcp-client/src/connection.ts)。
5. 阅读工具发现与调用转换：[`packages/mcp/mcp-client/src/tools.ts`](../packages/mcp/mcp-client/src/tools.ts)。
6. 阅读 Resource 服务：[`packages/mcp/mcp-resources/src/index.ts`](../packages/mcp/mcp-resources/src/index.ts)。
7. 最后对照可运行的第三方记忆示例：[`docs/user/guide/mcp-memory.md`](../docs/user/guide/mcp-memory.md)。
