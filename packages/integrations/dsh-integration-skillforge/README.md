# 这边是对于这一个插件需要理解的基础
## 1.基础内容
    1.import { x }, import type { X } 只导入类型但是编译后消失
    2.interface 表示对象结构 export interface SkillForgeConfig{ disabled?: boolean } 这边是添加可选字段
    3.type 联合类型和类型别名
        type ValueType = | 'number' | 'boolean' 表示选择其中一个
    4.WeakMap
    5.回调函数和箭头函数
        this.ctx.on('session/event', (session, event) => {
            tracker.handleEvent(event)
        })
        ctx.on('session/event') 注册函数
        ctx.emit('session/event', event, session) 调用函数
## 2.项目架构
### 1.index.ts 主要环节
    SkillForgeService 是整个插件的应用服务，依赖DSH的能力：
        storageDomain：持久化轨迹、失败、近呢个等数据
        tools：读取工具定义
        systemPrompt: 把学习到的技能放到系统提示词当中
    配置分为几组：
        功能开关：
        挖掘阈值：
        注入门槛：
        存储限制：
        人工控制：
        结果验证：
### 2.tracker.ts 事件重建
    把细粒度的Session事件重建成一个完整的TurnRecord
    处理：
        turn/start,
        user/message,
        assistant/message,
        tool/call,
        tool/result,
        turn/end,
### 3.spec.ts 持久化
    trajectories: 每轮工具调用轨迹，技能挖掘的输入
    failures: 分类后失败样本
    rules: 从失败样本中提炼出来的规则
    skills: 挖掘和评分后的技能
    verification: 后置条件验证失败记录
    injections: 哪些技能被注入过 Prompt 的审计记录
    skill_version: 技能更新前的快照
    这边有三层状态：
        Durable Storage： 长期保存的七张表
        内存缓存： 工具参数模版 templateCache
        JSONL： ～/.dsh/storages/skillforge-events.jsonl
### 4.classifier.ts 失败学习链
    确定性的关键词分类器，不调用模型。
    主要类别包括：
        参数错误
        权限错误
        场景不匹配
        依赖缺失
        运行时异常
        限流
        静默失败
        计划失败
        优先分析工具错误文本；只有错误文本没有明显信号时，才看plannerTrace，避免上下文分类污染。
#### distiller.ts
#### recovery.ts
    失败类型映射为恢复动作：
        参数错误 -> 修复参数后重试
        限流/运行时异常 -> 原参数重试
        权限错误 -> 换工具
        依赖缺失 -> 换工具重新规划
        未知错误 -> 停止并重新考虑
    tools/post-execute会把生成的建议作为额外的 UserMessage 上下问交给模型，而不是由插件自动启动
### 5.profiler.ts 成功经验学习链
    从某个工具的成功调用中学习参数模板。
    会推导：
        哪些参数每次成功调用都出现，即requiredKeys
        常见默认值
        树枝范围和分数位范围
        枚举/分类值
        参数类型
        样本数和置信度
    计算策略：
#### miner.ts
    从成功调用序列中挖掘频繁工具链
        当同一路径达到minSupport后，就生成一条 SkillRecord。
        虽然注释称之为 DAG，当前实际上挖掘的是“连续线性工具路径”，不是任意分支DAG。
        后续失败轨迹仍然保存用于审计，但不会参加技能挖掘。
#### scoring.ts
    技能评分
### 在线工具调用前保护
    依次检查：
        1.工具自身 JSON Schema 声明对必填参数
        2.从历史成功调用中学出来的必填参数
        3.JSON Schema中枚举值约束
### 后置条件验证
    工具调用成功 ≠ 任务真的完成
### 技能注入和隔离
    系统提示词注入位于。
        注入前提前筛选，最多注入八条。
        但是注入的只是去参数化的调用链，不会把历史路径等注入 Prompt，以避免旧任务数据污染新任务。
        skill Override可以固定技能状态，skillRollback可以恢复历史版本，并把技能冻结在指定版本，避免下一次挖掘直接覆盖。
