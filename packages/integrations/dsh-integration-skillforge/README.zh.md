---
description: "面向配置或调试 DeepSeek Harness 集成的用户与维护者，说明进程内 SkillForge 学习、守卫、恢复和后置条件行为。"
kind: "package-reference"
---

# @deepseek-ai/dsh-integration-skillforge

[English](README.md) | 中文

## 概述

使用本包可以收集工具调用轨迹、提取反复成功的调用路径、阻止参数缺失或无效的调用，并向模型返回确定性的恢复或后置条件指导。它通过 `storageDomain` 保存派生记录，并为突然退出的 headless 进程保留同步 JSONL 镜像。该集成本身不发起外部网络调用，但命令后置条件可以运行本地 Bash。已发布的 profile 不会启用它，必须显式挂载。

## 目录

- [使用本包](#use-this-package)
- [多客户端进化](#multi-client-evolution)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在组合提供 `storageDomain`、`systemPrompt` 和 `tools` 后挂载 SkillForge；插件注册自己的 `ctx.skillforge` 服务，并在未禁用时打开 `skillforge` 存储领域。

### 何时选择它

当重复工具工作流应该形成可复用的调用路径提示，而且确定性的参数、失败与后置条件检查有价值时，选择 SkillForge。没有持久存储后端、不能接受同步文件系统镜像，或命令后置条件必须运行在没有 Bash 的宿主上时，不要选择它。

### 最小配置

下列配置行假定外围组合已挂载必需的存储、提示词与工具服务：

```yaml
- name: '@deepseek-ai/dsh-integration-skillforge'
  config:
    projectName: 'my-project'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `disabled` | `false` | 保留配置行，但跳过领域打开与所有监听器注册 |
| `projectName` | `dsh` | 与轨迹一起保存并用于隔离挖掘技能的场景标签 |
| `collectTrajectories` | `true` | 持久化已完成 turn，并运行摄取与挖掘 |
| `ruleGuard` | `true` | 拒绝缺少 schema 必填参数、学习所得必填参数或违反声明枚举的工具调用 |
| `recoveryHints` | `true` | 在失败工具结果上附加确定性分类与恢复指导 |
| `skillInjection` | `true` | 把可用的已学习路径加入系统提示词 |
| `postconditions` | `[]` | 在 turn 结束时评估的文件或命令检查 |
| `minSupport` | `2` | 生成挖掘技能所需的最少重复路径次数 |
| `minPathLength` | `2` | 挖掘考虑的最短连续成功调用路径 |
| `maxPathLength` | `5` | 挖掘考虑的最长连续成功调用路径 |
| `minSessionsForInjection` | `2` | 技能进入提示词前所需的不同 Session 证据数 |
| `maxStoredTrajectories` | `500` | 领域保留的最大轨迹数；最旧记录优先裁剪 |
| `minMiningIntervalMs` | `30000` | 两次主动挖掘之间的最短时间 |
| `skillOverrides` | `{}` | 评分后应用的技能名到生命周期状态固定值 |
| `maxRevisionsPerSkill` | `5` | 每个技能名保留的快照版本数 |
| `skillRollback` | `{}` | 挖掘前重新应用的技能名到恢复版本映射 |

每个后置条件提供 `kind`、`target`、`expected` 和 `message`。支持的 kind 为 `file_exists`、`file_contains`、`file_not_contains` 与 `command_output_contains`；最后一种以 15 秒超时运行 `bash -lc <target>`。`SkillForgeConfig` 当前是 TypeScript 接口而不是运行时 Schemastery schema，因此本表和 [`src/index.ts`](src/index.ts) 是受支持字段的参考。

### 从当前检出启动

安装根工作区依赖并提供模型凭据。下面的环境变量形式适合临时 shell；绝不要提交密钥：

```sh
pnpm install
export DEEPSEEK_API_KEY='<your-key>'
```

已提交的 [`examples/headless.patch.yml`](examples/headless.patch.yml) 会直接从当前源码检出挂载 SkillForge。它保留两次运行的支持度与跨 Session 门槛，设置独立场景名，并去掉 30 秒挖掘间隔，让简短演示可以立即挖掘。运行模型前先检查最终组合：

```sh
pnpm dsh --profile headless \
  --patch ./packages/integrations/dsh-integration-skillforge/examples/headless.patch.yml \
  --dump-config
```

最终组合行应包含 `id: integration-skillforge`，以及以 `packages/integrations/dsh-integration-skillforge/src/index.ts` 结尾的 `file://` URL。使用同一覆盖启动一个任务：

```sh
pnpm dsh --profile headless \
  --patch ./packages/integrations/dsh-integration-skillforge/examples/headless.patch.yml \
  "Inspect package.json and README.md, then summarize this package. Use at least two tools."
```

该命令创建一个持久化 Session，打印 Agent 结果，然后退出。SkillForge 没有独立端口或仪表盘；它的效果体现在工具行为、模型上下文、日志以及下述持久记录中。再次运行同一命令即可提供第二个 Session。当两次运行都含有同一条至少由两个工具调用组成的成功连续路径时，示例门槛允许这条路径在后续运行中成为提示词注入候选。

### 观察行为与持久化

JSON 存储后端把领域写入 `DSH_HOME`，默认位置为 `~/.dsh`。完成一次运行后，用以下命令检查领域与同步镜像：

```sh
sed -n '1,240p' "${DSH_HOME:-$HOME/.dsh}/storages/skillforge.json"
tail -n 20 "$HOME/.dsh/storages/skillforge-events.jsonl"
```

查看领域文档的 `tables` 对象。以下记录可以区分主要效果：

| 效果 | 可观察证据 |
|---|---|
| 完成 turn 收集 | `tables.trajectories` 增加记录，JSONL 镜像增加包含 `record` 的行 |
| 重复路径挖掘 | `tables.skills` 和 `tables.skill_revisions` 增加记录；镜像也增加 `type` 为 `skill` 或 `revision` 的行 |
| 学习路径注入 | `tables.injections` 记录向模型展示的技能名；下一个匹配请求收到“模型体验”中说明的学习工具调用 section |
| 无效参数守卫 | 日志包含 `skillforge: blocked ...`，模型收到以 `SkillForge precheck:` 开头的工具错误 |
| 失败工具恢复 | `tables.failures` 增加分类后的失败，模型可以收到以 `SkillForge classified ...` 开头的合成恢复消息 |
| 已配置后置条件失败 | `tables.verifications` 增加失败检查，日志包含 `skillforge: verification failed ...`，且该 turn 不计入成功路径证据 |

第一个进程退出后，再运行同一条 headless 命令即可验证重启行为。启动时会打开已有领域，并在注册收集器前回放镜像；能看到 info 日志时，非空回放会报告 `[skillforge] mirror replayed <n> turns into trajectories`。领域写入使用稳定的 turn 键，因此回放会修复缺失写入，而不会为同一 turn 创建第二条记录。

`DSH_HOME` 会改变 JSON 领域位置，但不会改变镜像位置：当前实现始终使用 `$HOME/.dsh/storages/skillforge-events.jsonl`。镜像既包含轨迹参数与结果，也包含挖掘所得技能记录，因此应把它视为可能敏感的应用数据，并实施宿主访问与保留控制。示例中的 `minMiningIntervalMs: 0` 仅用于观察；正常运行请使用 30 秒默认值或经过测量的部署值。

### 运行数据与生命周期

服务打开七张领域表：`trajectories`、`failures`、`rules`、`skills`、`verifications`、`injections` 和 `skill_revisions`。已完成的 turn 从 Session 事件重建。失败调用被分类并提炼为记录；通过验证的成功调用进入连续路径挖掘；评分决定挖掘技能为 `canary`、`active`、degraded 或 offline。插件 fiber 释放时，服务通过 Cordis effect 关闭已打开的领域。

插件还会把回放记录同步追加到 `~/.dsh/storages/skillforge-events.jsonl`。下次启动时，它在保留每个场景标签的情况下回放条目，修复短生命周期 headless 进程退出前可能未排空的领域写入。

-----

<a id="multi-client-evolution"></a>
## 多客户端进化

这个核心服务在同一进程的多个 Session 之间共享一个技能库，并使用不同 Session id 作为注入门槛。它不拥有经过认证的客户端身份、租户隔离或分布式多写入方协调。不要把 `minSessionsForInjection` 理解为证据来自独立客户端的证明。

需要带客户端归属的证据和隔离演化域时，使用配套的 [`@deepseek-ai/dsh-integration-skillforge-multiclient`](../dsh-integration-skillforge-multiclient/README.zh.md)。配套插件不会编辑本包的 `src/` 实现。它签入的 headless overlay 会保留此核心的收集、保护、恢复和验证，同时设置 `skillInjection: false`；之后由配套插件负责不同客户端晋级与按域过滤的路径注入。

已实现阶段协调一个 DSH 进程内的并发 Session，并通过独立的 `skillforge_multiclient` 领域持久化。生产客户端法定人数需要可信网关适配器绑定经过认证的客户端以及租户或团队身份；Session 作为客户端的回退仅用于可运行评测。跨进程与跨主机联邦不属于这一阶段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

运行时有两条学习路径。失败路径重建失败调用，应用确定性关键词分类器，保存证据并准备恢复指导。成功路径从成功调用分析参数，挖掘重复的连续调用窗口，计算置信度与成本分数，并只注入达到跨 Session 门槛的 `canary` 或 `active` 技能。

执行前守卫组合已注册工具 schema 与学习所得模板。schema 必填和学习所得必填参数都把缺少键或空字符串视为缺失；枚举检查使用已注册 schema。turn 结束时的后置条件在挖掘前评估，任何失败检查都会让该 turn 排除在成功证据之外，同时保留轨迹供审计。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务生命周期、监听器、存储、回放、守卫和模型上下文注入 |
| [`src/tracker.ts`](src/tracker.ts) | 把 Session 事件重建为完整 turn 记录 |
| [`src/classifier.ts`](src/classifier.ts) | 确定性失败分类 |
| [`src/distiller.ts`](src/distiller.ts) 和 [`src/recovery.ts`](src/recovery.ts) | 失败记录、修复步骤和恢复指导 |
| [`src/profiler.ts`](src/profiler.ts)、[`src/miner.ts`](src/miner.ts) 和 [`src/scoring.ts`](src/scoring.ts) | 参数模板、重复路径挖掘和生命周期评分 |
| [`src/verifier.ts`](src/verifier.ts) | 文件与 Bash 后置条件检查 |
| [`src/spec.ts`](src/spec.ts) | 带版本的领域声明与记录 schema |
| [`examples/headless.patch.yml`](examples/headless.patch.yml) | 用于文档化 headless 演示的源码检出覆盖 |
| — | 不发布运行时 invariant companion：该集成拥有一个服务实例及其私有缓存，持久记录校验由 `storageDomain` 负责 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具子系统](../../../docs/subsystems/tools.zh.md)——执行前拒绝与执行后上下文语义。
- [存储组](../../storage/README.zh.md)——持久记录使用的存储中枢、后端与领域形式。
- [系统提示词包](../../core/system-prompt/README.zh.md)——有序提示词 section 组装。
- [测试策略](../../../docs/testing.zh.md)——包级回归、Loader 组合和覆盖率要求。
- [保留的学习笔记](LEARNING_NOTES.md)——从包契约中分离保存的原始中文学习内容。
- [工程变更日志](CHANGELOG.md)——未编辑核心实现情况下完成的具体集成与验证变更。

-----

<a id="model-experience"></a>
## 模型体验

### 学习所得工具调用系统提示词 section

#### 模型看到什么

当至少一个可用技能达到 `minSessionsForInjection`，且可选运行时 scope 允许其场景时，模型会收到下面的 section，其中按置信度排列最多八个技能。不包含具体的历史参数值。

##### 学习所得路径 section

```markdown
Learned tool-call patterns from past successful sessions:
- <scenario>: <toolA> -> <toolB> (support=<count>, sessions=<count>, confidence=<percent>%).
Prefer these call chains for matching tasks; they skip re-planning.
```

#### Token 影响

没有技能符合条件时为零 token。否则，系统提示词增加固定标题和结尾，以及最多八行路径摘要；路径长度和名称使精确大小取决于数据。

#### KV Cache 影响

在 section 顺序 `550` 处替换：可用技能、证据数、置信度、scope 过滤或人工状态控制的变化会改变该系统提示词片段，并使从该片段起的复用失效。技能集合不变时文本稳定。

### 执行前拒绝结果

#### 模型看到什么

被拒绝的工具调用返回 `SkillForge precheck: <tool> ...` 原因，指出缺少的 schema 必填参数、学习所得必填参数或枚举违规，随后给出修复提示。通过全部检查的调用不会收到 SkillForge 文本。

#### Token 影响

仅在触发时出现，大小受相关参数名和枚举值限制。拒绝会用一个错误结果代替执行；成功调用不会增加文本。

#### KV Cache 影响

对下一次请求仅追加：拒绝结果位于已有可复用请求前缀之后。不同参数名或枚举值只改变新追加的结果。

### 恢复与后置条件上下文

#### 模型看到什么

工具结果失败后，模型可以收到合成用户消息，其中包含确定性失败类型、推荐恢复动作和修复步骤。turn 结束后置条件失败后，下一步可以收到合成用户消息，其中包含失败目标、预期条件和配置消息。

#### Token 影响

成功调用和通过验证的 turn 为零。每条触发消息取决于数据并保留在 Session 历史中；多个失败后置条件用换行符连接，供下一步使用。

#### KV Cache 影响

指导首次出现时仅追加，因此先前已发送的前缀仍可复用。文本保留到 Session 历史后，后续请求会重复相同历史文本，直至普通 Session 压缩或截断改变它。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制属于集成的当前行为，应当用于指导部署选择。

- **没有运行时配置 schema**——`SkillForgeConfig` 仅存在于 TypeScript，因此 Loader 配置不会在服务初始化前通过 Schemastery 规范化或拒绝。
- **线性路径而非通用 DAG**——挖掘考虑成功调用的连续窗口；它不学习分支、汇合或因果依赖。
- **进程全局镜像位置**——JSONL 镜像固定为 `~/.dsh/storages/skillforge-events.jsonl`，使用同步追加，且没有包所拥有的保留上限。
- **尽力而为的异步领域写入**——摄取与挖掘发起不等待完成的表操作，以便短生命周期 headless 进程退出；恢复依赖镜像回放，并不是跨七张表的事务提交。
- **依赖 Bash 的命令验证**——`command_output_contains` 最多阻塞事件路径 15 秒，并要求本地存在 `bash`；可移植组合应使用文件检查。
- **仅运行时场景 scope**——`setScopeScenarios` 接受不透明的实时 scope 对象，无法在 YAML 中声明；未注册 scope 会收到所有符合条件的场景。
- **仅手动组合**——没有已发布的 profile 或 bundle 启用该集成，因此部署必须提供它要求的三个服务并显式挂载配置行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

当前加固过程有意冻结核心实现。清单对齐、聚合构建注册、契约文档和回归测试可以在外围变化；学习、守卫、恢复、持久化或注入算法的变化需要独立决策与评测周期。

</details>
