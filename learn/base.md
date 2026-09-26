# DeepSeek Harness 基础知识学习

## 基础名词

Session -> Turn(为了响应一次用户输入的所有工作) -> Step(步骤，可能是调用一个或多个工具)
turn/end 位置触发 SkillForge 去统一落地轨迹。

级联：一个插件受到影响之后，依赖他的插件也会受影响。

微内核：
    只含有 进程调度、内存管理、进程间通信(IPC)，对于文件系统、网络、驱动、模块通信都是外部用户态服务
    seL4只有1万行代码，但是Linux有千万行代码

### Cordis微内核：

        Context + Service + Fiber + 事件总线
        Context: 微内核当中的"IPC + 进程表"
        Service: 提供注册、依赖注入、配置继承的标准协议
        Fiber: 服务挂在fiber上，fiber写在服务自动清理

    Cordis的context是插件站在当前作用域，访问哪些服务、事件和资源的运行环境
    服务解析逻辑在 ReflectService.handler.get 里面解析

    所有功能都是服务：
        ctx.llm LLM适配
        ctx.tokenMeter token估算
        ctx.sessions 会话管理
        ctx.sessionProjections 投影
        CompactionEngine: 压缩
        toolResultPruner: 裁切

    模块间通过事件协作：
        ctx.on('agent/pre-step', ...) 触发事件
        ctx.waterfall('compaction/summary-error', ...) 
        waterfall按照监听器注册顺序依次注入，没过监听器通过 next() 调用下游，形成嵌套调用栈；用于拦截、改写、否决、恢复的拓展点

  #### 这边是作用域的构建逻辑

    插件拿到的这个 ctx，在查找服务时所出的位置和范围。
        假设有一个根上下文，提供  logger 和 tools。插件 A 创建子上下
    文，并为 tools 建立独立作用域：
        const childCtx = ctx.isolate("tools")
        await childCtx.plugin(ToolsProvider)  // 这边 ToolsProvider相当于是一个class， constructor(ctx: Context){ super(ctx, "tools") } 从 Service 中构造新的作用域
        那么在 childCtx 下运行的插件，仍可以访问继承来的 logger，但是他查找 tools 时会进入这个独立作用域，可以使用另一套 tools 实现

  #### 热插拔原理

    消费者依赖服务名"tools",但是不写死提供者类，所以能做到卸载就的提供者和挂载新的提供者，作用域把这次替换限制在制定的插件群里面。
    插件群：
        把一组插件放到同一颗子树下，可以一起加载、写在，也可以为这组插件设置独立的服务域。
    HMR：
        Hot Module  发现代码改了并触发替换
    Loader：
        读取 cordis.yml 等配置，把配置装载成正在运行的插件树
    子树：
        一个组节点，加上它下面挂载的所有插件，一组插件删除了另一组不受影响

## 对话格式

{
    "model": "deepseek-v4-flash",
    "stream": true,
    "system": "You are a AI agent powered by DeepSeek Harness\n\n
        [计划策略 section, order=500]\n\n
        [⭐️技能注入段, order=550]\n\n
        [base 工具指引， order=1000]
        [read 工具直营， order=1100]\n\n
    ",
    "messages": [
        {
            "role": "user",
            "content": [{ "type": "text", "text":
            "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n
            Current DSH file policy: danger-full-acess...\n\n
            "
            }],
            "source": { "kind": "plugin", "plugin": "@deepseek-ai/dsh-system-prompt", "from": "snapshot" }
        },
        // 这边是模型发起(tool-call)
        {
            "role": "assistant",
            "content": [
                {
                    "type": "reasoning",
                    "text": "The user asks to use todo_write to record a single todo 'observe the switch'",
                },
                {
                    "type": "tool-call",
                    "id": "call_00_UMfIATnWwwCBBh46ORVb5102",
                    "name": "todo_write",
                    "arguments": "{{\"todos\": [{\"content\": \"observe the switch\", \"status\": \"pending\"}]}}"
                }
            ],
            "source": { "kind": "model", "provider": "...", "model" }
        },
        // 这边是工具回答(tool-result)
        {
            "role": "user",
            "content": [
                {
                    "type": "tool-result",
                    "toolCalled": "call_00_UMfIATnWwwCBBh46ORVb5102",
                    "content": [
                        { "type": "text", "text": "Updated todo list: 1 pending, 0 in progress, 0 completed." }
                    ],
                    "isError": false
                }
            ],
            "source": { "kind": "tool", "callId": "call_00_..." }
        }
    ]
    "tools": [
        { "name": "bash", "description": "...", "parameters": { ... } },
        { "name": "read", "description": "...", "parameters": { ... } },
    ]
}

## Session:

    结构：
    -- 工作目录：/project/demo
    -- 沙箱模式： workspace-write
        -- 第一轮
            用户： 帮我查看项目
            模型调用
            bash 工具调用
            模型回答
        -- 第二轮
            用户： 继续修改代码
            文件工具调用
            模型回答

    sequence number 会话事件日志里面的单调递增位置编号
    event 事件对应值
    会话日志：
        seq=0 event{type: 'user/message', ...}
        seq=1 event{type: 'assistant/message', ...}
        ...
    
    Session -> SessionEvent[]
               SurfaceManager implements SessionSurface -> nodes: SessionSeq[] 这个就是我们说的节点
                                                           repalceGeneration: number
                                                           contentGeneration: number 

## Provider 这只是一个概念 这边添加一些其他术语

    一个普通的 JS 函数，只是被约定用来干“按需供货”这个活，任何被框架到点拉取的函数都叫 provider。
    有别于静态字符串，静态字符串在插件加载那一刻确定内容，但是每次模型步组装提示词时现算，能反应最新状态，能按上下文区分
    就是一个 你不 push 内容，只是一个随叫随到的合同，框架在组装时刻 pull 。

  ### 这边补充一些其他的专业术语
  冻结： 没有人回头修改的普通字符串，没有任何 freeze() 调用， 没有 Object.freeze调用

  投影： 一个函数，输入组装好的上下文，输出“适合放进消息流的形态”
    this.runtimeContext.project(joinContextSections(sections), sections)

  遮蔽： system-prompt/index.ts:176/255
    同名时谁说了算的优先级
  瀑布：
    中间件链，一层一层传下去，每层调用 next()
  排水：storage-domain/domain.ts:111
    关门前把已经在排队的队列处理完，不再接受新的
  水位线：session/types.ts:60
    我处理到哪里了的序号

## sandbox(只有三种权限)：
    read-only 只读文件，但是禁止受管工具修改文件
    workspace-write 可以读取文件，但是只允许写入当前 Session 的工作目录和指定临时目录
    danger-full-access 不进行文件写入限制，使用主进程的完整权限
这边做晋升只能用bash去晋升，通过提示词晋升的话，通过调用工具触发 Cordis 的 waterfall 事件，进行审批

## CI/CD
    CI 每次提交代码，自动检查有没有问题
    CD 检查通过后，自动发布到用户能用