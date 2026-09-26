# SkillForge 学习

## 启动方式

    1. 加载：DSH 启动时读 ～/.dsh/profiles/<web|headess>cordis.patch.yml, insert 行让他偶为 Cordis 插件被加载， Service.init 打开存储域、注册全部监听器
    2. 事件驱动：
        session/event 验证判据，落地轨迹、挖掘
        session/pre-execute(每次工具调用前) -> 守卫拦截缺参
        session/post-execute(调用后) -> 失败分类、修复建议

## 与提示词交互位置

    在 dsh-interation-skillforg/src/index.ts 位置附近 registerPromptSection()
    this.ctx.systemPrompt.section({
        name: 'skillforge:skills',
        order: 550,
        text: (context) => this.skillsSectionText(context),
    })
    系统提示词 = [身份(-1000)][计划策略(500)][⭐️技能注入段(550)][团队策略(600)]...[工具说明(1000+)]
    另一个注入通道(不在 System Prompt): 验证失败的修复指引走 agent/pre-step,作为 user 角色消息附在下一条输入前
    system prompt 保持稳定不反复重写，这是所有 agent 的设计规律  后续关键注入主要靠