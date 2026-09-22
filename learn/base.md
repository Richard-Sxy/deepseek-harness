# DeepSeek Harness 基础知识学习

## 基础名词

微内核：
    只含有 进程调度、内存管理、进程间通信(IPC)，对于文件系统、网络、驱动、模块通信都是外部用户态服务
    seL4只有1万行代码，但是Linux有千万行代码
### Cordis微内核：
        Context + Service + Fiber + 事件总线
        Context: 微内核当中的"IPC + 进程表"
        Service: 提供注册、依赖注入、配置继承的标准协议
        Fiber: 服务挂在fiber上，fiber写在服务自动清理
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
        waterfall按照监听器注册顺序依次注入，美国监听器通过 next() 调用下游，形成嵌套调用栈；用于拦截、改写、否决、恢复的拓展点

Session:

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


sandbox(只有三种权限)：
    read-only 只读文件，但是禁止受管工具修改文件
    workspace-write 可以读取文件，但是只允许写入当前 Session 的工作目录和指定临时目录
    danger-full-access 不进行文件写入限制，使用主进程的完整权限
这边做晋升只能用bash去晋升，通过提示词晋升的话，通过调用工具触发 Cordis 的 waterfall 事件，进行审批