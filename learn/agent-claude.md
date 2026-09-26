# Agent.md 和 Claude.md 深度解析

整体进入提示词当中这一段
const entered = decision.messages.toSliced(lastClaimedIndex + 1, 0, desired)
return { ...decision, messages: entered }
这里 disired 就是包含 AGENTS.md 内容的那条 user/message, 被插进本 step 的 messages，然后作为 agent/pre-step 的返回值交给 agent-loop 去派生请求。




## Agent.md 整个项目有多个，但是按照层级深入而递减

目录越深，指令越具体，优先级越高。所以规则被放到“谁负责谁维护”这一层，不是全塞进根文件。

### Agent.md 解读 (根文件)

在修改 packages/ 文件之前，请先阅读 docs/architecture.md；文档相关请遵守 docs/AGENTS.md

仓库布局：
    packages/  主要仓库位置
    vendor/
    python/   Python SDK/运行时
    native/
    benchmarks/  性能门禁
    .agents/     Agent工作流/笔记
    docs/        文档
    website/     VitePress 文档投影

命令：pnpm 等
宿主沙箱失败：
    如果失败，请以最小范围的宿主提权、原样重试。
    要求提供沙箱证据，绝不绕过测试失败或者产品沙箱。

本地运行相关检查：
    绝不要提交或推送默认跑全套，或重复已经通过的检查。
    CI拥有穷尽覆盖和平台矩阵；仅在明确要求、CI诊断或不可约多仓库级变更时，才在本地排练全部。

密钥/.env
    真实 API 测试等等

约定

### Agent.md 解读 (packages/AGENTS.md)

Agent Harness 包：
    插件怎么写：Service包，默认导出一个类； 函数插件具名导出name/inject/Config/apply，不要默认导出
    拿服务用 ctx.get() 可选服务用ctx.get('名字') ctx.名字只给声明过的注入
    测试要动真格 产品可见的插件必须有一个真组合测试  要通过Loader和app/process启动测试专用的 cordis.yml
        只 mock 外部服务或随机输入，断言模型可见/持久化/用户可见的输出
        测试专用的开关不能进发布默认值
    设计原则
        一个异步操作，一个生命周期控制器
        为所有当前消费者设计服务 ...
    文件和命名
        src/types 只放类型，不放运行时代码
        测试放 tests/,不放 src/__tests__/
    一句话总结
        插件导出别混用，可选服务用ctx.get、产品可见插件要有真组合测试、设计要有当前需求支撑、文件放对位置、README和代码一起更新。

### Agent.md 解读 (docs/ scripts/ vendor/ ...)

docs:
    文档分两类
        tutorial 和 reference
    一句话总结
        每个事实只有一个家，，文档分教程和参考；只写当前状态；每段一行；代码块要能变易；中英配对一起改；字数有预算；别写重复、历史、状态标注、推理过程、段落墙和强调膨胀

### Agent.md 解读 (packages/web packages/client ...)
    packages/web
        一句话总结
            带凭据的 Web 请求不允许跟重定向，遇到就失败；测试要证明重定向目标没被碰，且所有相关 provider 都开了这个策略。
            重定向：服务器让你去另一个地址
            不许跟重定向：收到这种指令直接报错，不自动去新的地址