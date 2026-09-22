# SkillForge 学习笔记

本文保留原 `README.md` 中的个人学习内容。包的运行约定、配置和限制见 [`README.md`](README.md)。

## 1. 基础内容

1. `import { x }` 导入运行时值；`import type { X }` 只导入类型，编译后消失。
2. `interface` 表示对象结构，例如 `export interface SkillForgeConfig { disabled?: boolean }` 中的 `?` 表示可选字段。
3. `type` 可以声明联合类型和类型别名，例如 `type ValueType = 'number' | 'boolean'` 表示二选一。
4. `WeakMap` 以对象作为弱引用键，适合保存不应延长对象生命周期的关联状态。
5. 回调函数和箭头函数：`ctx.on('session/event', handler)` 注册监听器，`ctx.emit('session/event', event, session)` 触发事件。
6. `export type TurnCallRecord = z.infer<typeof turnCallRecord>` 中，`typeof` 获取变量的类型，`z.infer` 从 Zod schema 推导 TypeScript 类型。
7. `defineDomain` 定义数据域，`domainTable<string, SkillRecord>(skillRecord)` 定义主键类型、记录类型和运行时校验 schema。

### 关键词

- `mined`：挖掘。
- `injection`：注入。
- `constraint`：约束。

## 2. 项目架构

### `index.ts`：主要环节

`SkillForgeService` 是插件的应用服务，依赖 DSH 的 `storageDomain`、`tools` 和 `systemPrompt` 能力。配置分为功能开关、挖掘阈值、注入门槛、存储限制、人工控制和结果验证。

### `tracker.ts`：事件重建

把 `turn/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result` 和 `turn/end` 等细粒度 Session 事件重建为完整的 `TurnRecord`。

### `spec.ts`：持久化

- `trajectories`：每轮工具调用轨迹，是技能挖掘的输入。
- `failures`：分类后的失败样本。
- `rules`：从失败样本中提炼的规则。
- `skills`：挖掘和评分后的技能。
- `verifications`：后置条件验证失败记录。
- `injections`：哪些技能被注入 Prompt 的审计记录。
- `skill_revisions`：技能更新前的快照。

插件有三层状态：长期保存的 Durable Storage、保存工具参数模板的内存缓存，以及 `~/.dsh/storages/skillforge-events.jsonl` JSONL 镜像。

### `classifier.ts`、`distiller.ts` 和 `recovery.ts`：失败学习链

分类器使用确定性的关键词，不调用模型。主要类别包括参数错误、权限错误、场景不匹配、依赖缺失、运行时异常、限流、静默失败和计划失败。它优先分析工具错误文本；只有错误文本没有明显信号时才看 planner trace，避免上下文污染分类。

失败类型映射到恢复动作：参数错误建议修复参数后重试；限流或运行时异常建议按原参数重试；权限错误建议换工具；依赖缺失建议换工具或重新规划；未知错误建议停止并重新考虑。`tools/post-execute` 把建议作为额外的 `UserMessage` 上下文交给模型，而不是由插件自动执行重试。

### `profiler.ts`、`miner.ts` 和 `scoring.ts`：成功经验学习链

参数分析器从成功调用中学习每次都出现的 `requiredKeys`、常见默认值、数值范围、枚举或分类值、参数类型、样本数和置信度。

挖掘器从成功调用序列中寻找频繁的连续工具路径。同一路径达到 `minSupport` 后生成 `SkillRecord`。当前实现学习的是连续线性路径，不是任意分支 DAG；失败轨迹仍保存用于审计，但不会参加技能挖掘。

评分器结合成功置信度、延迟、token 成本、调用量和空闲衰减计算分数，并映射到技能生命周期状态。

### 在线工具调用前保护

保护器依次检查工具 JSON Schema 声明的必填参数、历史成功调用学到的必填参数，以及 JSON Schema 中的枚举约束。

### 后置条件验证

工具调用成功不等于任务真实完成。配置的后置条件在 turn 结束时检查，失败的 turn 保留审计记录，但不作为成功技能证据。

### 技能注入和隔离

系统提示词最多注入八条达到状态和跨会话门槛的技能。注入内容只包含去参数化的调用链，不包含历史参数。`skillOverrides` 可以固定技能状态，`skillRollback` 可以恢复历史版本并在配置存在期间冻结该技能，避免下一次挖掘覆盖恢复结果。
