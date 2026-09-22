---
description: "可选 DeepSeek Harness 集成的包映射；这些集成把现有能力 seam 组合为更高层行为。"
kind: "package-group"
---

# integrations/：可选组合集成

[English](README.md) | 中文

## 概述

`integrations/` 组包含可选插件，它们把现有 Harness 服务组合为更高层行为，而不修改 agent loop。这些包由部署显式挂载，不在基础 bundle 中启用。加入组合前，请打开对应包 README，检查它要求的服务、模型可见效果、持久化行为和运行限制。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

该组目前包含两个集成。

| 包 | 提供什么 |
|---|---|
| [`dsh-integration-skillforge/`](dsh-integration-skillforge/) | 学习重复出现的成功工具路径、保护参数，并返回失败或后置条件指导 |
| [`dsh-integration-skillforge-multiclient/`](dsh-integration-skillforge-multiclient/) | 在不修改 SkillForge 核心的前提下，协调带客户端归属的路径证据、隔离的演化域、持久晋级和按域过滤的注入 |

-----

<a id="related-documentation"></a>
## 相关文档

- [架构](../../docs/architecture.zh.md)——扩展点，以及新行为应由插件承载的规则。
- [工具子系统](../../docs/subsystems/tools.zh.md)——集成使用的执行 waterfall。
- [存储组](../storage/README.zh.md)——持久非会话存储与领域记录。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
