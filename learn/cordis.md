# Cordis 这个是 DeepSeek Harness 的核心架构

export interface Context {
    ...
    root: this,
    events: EventService,       // 事件总线
    logger: LoggerService,      // 日志
    reflect: RefectService,     // 反射层
    registry: RegistryService,  // 注册表
}

ctx 本质就是 ReflectService 的代理
const self = new Proxy<this>(this, ReflectService.handler)

## 插件定义

声明三件事：
    1.自己是谁 2.需要什么服务 3.核心逻辑

    export const coffeePlugin = {
        name: 'coffee',
        inject: ['water', 'power'] as const,
        async apply(ctx: Context){       // 插件自我运行的逻辑
            ctx.effect(() => () => ctx.logger.info('撤场'))
            ctx.provide('sell', sell)    // 挂载服务
            return () => { /* 清理 */ }
        }
    }

    fiber：插件注册到 Context 后真正运行到对象。

    class Fiber {
        inject: string[],             // 门禁，需要启动的服务
        get state(): FiberState       // 生命周期状态机 DISPOSED/FAILED/ACTIVE/PENDING
        runtime: { callback }         // 流程
        _disposables: DisposableList  // 撤场清单
    }

## 插件之间的互相通知，协同干活

events

｜模式｜关键词｜语义｜
｜emit｜纯广播发完就走｜发送方发出后，不用等待任何返回值｜
｜waterfall｜逐层转包 next()｜每层拿到上层结果，调用next()交给下一层，最终回传最外层｜
｜parallel｜兵法，等待全部｜并发派发，等所用订阅方都处理完才继续｜
｜serial｜顺序，首个非空就停止｜按顺序逐个调用，首个非空值即停并回传｜
｜bail｜抢占｜谁先抢占谁赢｜

emit: DSH 大量广播 agent 的状态变化，工具注册表变动，提示词变化等
    发送方：ctx.emit('water/maintenance', '发了你一条信息')
    接收方：ctx.on('water/maintenance', (message) => ctx.logger.info('收到信息:' + message))

waterfall：  —————— 拼装系统提示词(各个插件经过 next() 追加改写section，context，tools、文件编辑/写入前的单槽位门禁)
    发送方： const rise = ctx.waterfall(
                'power/price-rise',
                '基础电费+10%'，
                (note) => '供电科公告：' + note
            )
    订阅方： ctx.on('power/price-rise', (note, next) =>
                const r = next()                // 先让内层/下游处理
                return r + '咖啡店 每杯转嫁 1 元'  // 再叠加改动，回传上层
            )

parallel：每一个订阅方都确认，基本不用
serial： turn 结束前放 serial， hook 插件订阅，只需要有任意的 hook 需要检查，就不停止。
    const vote = await ctx.serial('power/outage-vote', 3)  // 3个穿行处理
    ctx.on('power/outage-vote', (floor) => {
        ctx.logger.info('...信息内容')
        return '信息内容'
    })

## 插件理解

基础业务： 基础插件 AService BService CService
升级业务： 依赖于基础插件 inject 这部分