---
description: "面向 SkillForge 部署的多客户端证据协调、演化域隔离、持久化与运行说明。"
kind: "package-reference"
---

# @deepseek-ai/dsh-integration-skillforge-multiclient

[English](README.md) | 中文

## 概述

当多个客户端或 Session 应向同一个 SkillForge 演化池贡献成功工具路径证据、同时又不能跨租户共享结果时，使用这个配套插件。它不修改 `dsh-integration-skillforge/src/`，把客户端绑定和共享证据存入独立领域，仅在配置的不同客户端数、不同 Session 数和支持度门槛全部通过后晋级路径，并且只向当前 Session 所属演化域注入符合条件的路径。

## 目录

- [使用这个包](#use-this-package)
- [客户端身份与隔离](#client-identity-and-isolation)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

在组合已经提供 `storageDomain` 和 `systemPrompt` 之后挂载本插件。签入的示例还会挂载经过评测的 SkillForge 核心，并关闭其自身路径注入；这样核心继续收集轨迹、保护调用和返回恢复指导，而本包负责跨客户端晋级与注入。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-integration-skillforge-multiclient'
  config:
    defaultScope: 'my-team'
    unboundSessionPolicy: 'session-client'
    minClients: 2
    minSessions: 2
    minSupport: 2
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultScope` | `shared` | Session 回退策略分配的演化域 |
| `unboundSessionPolicy` | `session-client` | 把每个未绑定 Session 当作一个演示客户端；可信适配器必须绑定每个 Session 时使用 `exclude` |
| `minClients` | `2` | 一条路径符合条件前所需的不同客户端身份数 |
| `minSessions` | `2` | 一条路径符合条件前所需的不同 Session 数 |
| `minSupport` | `2` | 一条路径符合条件前所需的成功观察总数 |
| `minPathLength` | `2` | 作为证据存储的最短连续成功工具路径 |
| `maxPathLength` | `5` | 作为证据存储的最长连续成功工具路径 |
| `maxEvidencePerScope` | `2000` | 每个演化域按最旧优先淘汰的证据保留上限 |
| `maxSkillsPerScope` | `16` | 每个域保留并注入的最高排名合格路径数 |
| `maxInjectionsPerScope` | `1000` | 每个域按最旧优先淘汰的提示词注入审计保留上限 |
| `maxTrackedSessions` | `256` | 淘汰最旧项前保留的实时 Session 轮次跟踪器数 |

Schemastery 配置会拒绝非正整数限制。服务构造还会拒绝小于 `minPathLength` 的 `maxPathLength`。随部署变化的门槛与保留上限均可配置，而不是固定在学习路径中。

### 从当前检出运行

安装依赖并提供模型密钥，不要提交密钥：

```sh
pnpm install
export DEEPSEEK_API_KEY='<your-key>'
```

运行前先检查组合后的源码检出配置：

```sh
pnpm dsh --profile headless \
  --patch ./packages/integrations/dsh-integration-skillforge-multiclient/examples/headless.patch.yml \
  --dump-config
```

把同一个可重复任务运行两次。示例把每个新的 headless Session 当作一个回退客户端，因此两个成功 Session 可以满足三个默认演示门槛：

```sh
pnpm dsh --profile headless \
  --patch ./packages/integrations/dsh-integration-skillforge-multiclient/examples/headless.patch.yml \
  "Inspect package.json and README.md, then summarize this package. Use at least two tools."
```

第三次运行时，新 Session 可以收到 `demo-team` 中符合条件的路径。原始 SkillForge 配置行设置了 `skillInjection: false`，避免在同一个提示词中同时显示核心的 Session 门槛提示与本包的客户端门槛提示。

### 观察持久化与效果

JSON 后端默认使用 `~/.dsh`。每次运行后检查多客户端领域：

```sh
sed -n '1,260p' "${DSH_HOME:-$HOME/.dsh}/storages/skillforge_multiclient.json"
```

文档包含四张表：

| 表 | 要查找的证据 |
|---|---|
| `bindings` | Session 到客户端、Session 到域的分配，包括来源是显式绑定还是 Session 回退 |
| `evidence` | 带客户端、Session、轮次和域归属的成功连续路径 |
| `skills` | 当前通过所有配置晋级门槛的路径 |
| `injections` | 向模型展示合格路径时产生的逐 Session 审计记录 |

当 `injections` 新增记录时，第三次运行就展示了模型可见效果。本包没有独立仪表盘；持久 JSON 是当前运维视图，公共 `snapshot(scopeId)` 方法向未来的 Host 或 Web 展示器提供相同的聚合计数，同时不会暴露其他域的记录。

### 持久化与重启行为

服务以 schema 版本 1 打开 `skillforge_multiclient` 领域，并在排队工作清空后关闭它。`session/flush` 也会等待操作队列，并报告保留的后台持久化失败。使用相同 `DSH_HOME` 重启时，会从选定存储后端重新加载绑定、证据、合格技能和注入审计；启动会在监听器激活前重新应用当前保留与晋级设置。这个配套插件不使用 JSONL 镜像。

证据键按 Session、轮次、窗口起点和窗口长度保持稳定，因此重放同一个观察只会覆盖记录，不会增加支持度。域重建在服务拥有的单一操作队列上执行：交错的 Session 事件无法看到只应用了一半的裁剪或晋级。保留策略按时间戳和记录 id 确定性地删除最旧证据，然后重新计算该域完整的合格集合。

-----

<a id="client-identity-and-isolation"></a>
## 客户端身份与隔离

`session-client` 是可立即使用的演示策略，不是经过认证的多客户端身份系统。一个浏览器或 API 客户端可以创建多个 Session，因此需要独立客户端法定人数的生产部署应设置 `unboundSessionPolicy: exclude`，并在第一轮之前绑定经过认证的客户端身份。

可信网关或组合适配器使用品牌化身份调用服务 API：

```ts
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  EvolutionClientId,
  EvolutionScopeId,
} from '@deepseek-ai/dsh-integration-skillforge-multiclient'

await ctx.skillforgeMulticlient.bindSession(SessionId(sessionId), {
  clientId: EvolutionClientId(authenticatedClientId),
  scopeId: EvolutionScopeId(tenantOrTeamId),
})
```

相同绑定是幂等的。只有在该 Session 尚未贡献证据时，已存储的回退绑定才能被显式绑定替换。任何冲突的显式绑定，或者已经存在证据后的重新绑定，都会明确失败；这可以防止晋级计数开始后证据在租户之间移动。

提示词提供器要求装配绑定到 Agent，并同步解析其 Session 绑定。没有 Agent 的诊断装配不会收到多客户端路径。绑定后的 Agent 只会看到 `scopeId` 与自身绑定完全相等的技能，晋级也只在同一个域内计算客户端和 Session。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

收集器跟踪 `turn/start`、有序 `tool/call` 事件、关联的 `tool/result` 结果和 `turn/end`。只有已完成、并且每个已观察调用都有成功结果的轮次会贡献证据。对于每个接受的轮次，服务存储长度介于 `minPathLength` 与 `maxPathLength` 之间的所有连续路径；历史参数和结果内容被有意排除。

晋级先在单个域内按完全相同的工具名序列聚合证据，再检查总支持度、不同客户端数和不同 Session 数。合格路径按客户端数、Session 数、支持度和确定性签名排序。重建会替换该域的完整派生技能集，因此裁剪或更严格的门槛不会留下仍在发布的陈旧路径。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务 API、Session 收集器、串行持久化、晋级、域过滤与提示词注入 |
| [`src/spec.ts`](src/spec.ts) | 绑定、证据、合格技能和注入审计的版本化 zod schema |
| [`tests/multiclient.spec.ts`](tests/multiclient.spec.ts) | 不同客户端法定人数、域隔离、不可变重绑定、回退身份和提示词行为 |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | 通过真实 Cordis Loader 组合激活默认导出 |
| [`examples/headless.patch.yml`](examples/headless.patch.yml) | 可运行的核心加协调器 headless 组合 |
| — | 不发布运行时 invariant 配套：单个服务拥有领域、操作队列、跟踪器和提示词注册；存储领域负责验证持久记录 |

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 合格的跨客户端路径

#### 模型看到什么

当当前 Agent 存在绑定，并且至少一条路径在完全相同的域中符合条件时，系统提示词包含：

```markdown
Cross-client tool-call patterns verified in this evolution scope:
- <toolA> -> <toolB> (clients=<count>, sessions=<count>, support=<count>).
Use these de-parameterized paths only when they fit the current task; choose arguments from current context.
```

这里只包含工具名和聚合计数。客户端 id、Session id、域 id、参数、结果和历史任务文本都不会进入此段。

#### Token 影响

未绑定 Agent、空域以及没有 Agent 的诊断装配为零 token。其他情况下，此段包含一个标题、最多 `maxSkillsPerScope` 行路径摘要和一行指令结尾。

#### KV Cache 影响

此段位于基础 SkillForge 段之后，顺序为 `551`。合格状态、排序或计数变化会修改文本，并使从此段开始的缓存复用失效；域状态相同时重复装配会产生稳定文本。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **单进程和单个存储领域写入方**——操作队列协调同一个 DSH 进程内的并发 Session。它不是分布式锁，JSON 后端不能由多个写入方共享。
- **回退身份就是 Session 身份**——默认值便于 headless 评测，但不能证明观察来自不同的人、设备或账户。生产法定人数应使用显式认证绑定。
- **没有已发布的 Web 身份适配器**——服务 API 已可供网关适配器使用，但当前 Web 客户端不会向本包提供经过认证的客户端或租户 id。在挂载这样的适配器之前，Web Session 使用配置的回退策略或被排除。
- **没有内置仪表盘**——持久 JSON 和 `snapshot(scopeId)` 暴露运维状态，但本包不增加客户端 UI。未来 UI 必须消费经过域授权的 Host 投影，而不是在浏览器中读取所有领域记录。
- **仅线性路径**——证据表示连续工具名序列，不表示分支、参数、因果依赖、成功质量或通用 DAG。
- **没有跨主机联邦**——多个 worker 需要外部协调器，或具有明确多写入方事务、幂等证据摄取和租户感知授权的存储后端；本包有意止于稳定的同进程阶段。
- **模型可见快照夹具延期**——精确提示词输出由包行为测试固定。仓库录制 Session 用例仍需要一个确定性 profile 路径，能在回放前预置这个非 Session 存储领域。

-----

<a id="further-exploration"></a>
## 进一步探索

- [基础 SkillForge 集成](../dsh-integration-skillforge/README.zh.md)——经过评测的核心收集、保护、恢复、评分与持久化。
- [架构](../../../docs/architecture.zh.md)——插件扩展点，以及新行为保持在 agent loop 外部的规则。
- [存储组](../../storage/README.zh.md)——存储后端与领域持久化。
- [测试策略](../../../docs/testing.zh.md)——行为、Loader 组合和模型可见快照要求。
- [工程变更日志](CHANGELOG.md)——本次实现的具体文件、兼容性决定与验证。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本包是第一阶段的同进程多客户端实现。保留基础 SkillForge 源码及其评测结果。把经过认证的 Web 或 API 适配器作为独立的 `bindSession` 提供方加入；只有在明确设计事务存储与授权后才加入跨进程协调。

</details>
