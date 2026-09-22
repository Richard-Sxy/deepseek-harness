# Sandbox 模块学习笔记

## 摘要

DeepSeek Harness 使用统一的沙箱策略和服务接口，但不依赖一个统一的第三方沙箱软件。`ctx.sandboxPolicy` 为每个 Session 解析文件写入策略，`ctx.sandbox` 再把受限进程交给 Linux、macOS、Windows 或远端环境中的具体实现。当前沙箱主要限制文件写入，不统一限制文件读取、网络访问或进程可见性，因此它不是容器或虚拟机级隔离。

## 核心结论

- 项目统一管理的是模式、工作区、审批流程和错误语义，不是底层沙箱程序。
- `read-only` 禁止受管能力写文件；`workspace-write` 只允许写 Session 工作区和后端允许的临时目录；`danger-full-access` 直接绕过沙箱。
- Bash、PowerShell 和持久终端通过操作系统级后端约束子进程；文件工具通过 Harness 进程内的路径检查约束写入。
- 受限模式找不到可用后端时返回 `SANDBOX_UNAVAILABLE`，不会静默改成无沙箱执行。
- Agent 可以对刚被拒绝的同一调用申请一次性、更宽的模式，但必须提供理由并通过审批；批准不会永久修改 Session 模式。

## 核心组件与源码入口

| 组件 | 责任 | 源码 |
|---|---|---|
| 沙箱公共类型和服务 | 定义 `SandboxMode`、执行策略、`ConfinedArgv`、执行完整性和 `SandboxProvider.confine()` | [`packages/sandbox/sandbox/src/index.ts`](../packages/sandbox/sandbox/src/index.ts) |
| 可写目录计算 | 统一计算工作区和平台临时目录，供文件围栏与平台 Profile 共用 | [`packages/sandbox/sandbox/src/roots.ts`](../packages/sandbox/sandbox/src/roots.ts) |
| 一次性提权 | 校验 `sandbox_permissions` 与 `justification`，限制只能升级到更宽模式，并连接审批服务 | [`packages/sandbox/sandbox/src/escalation.ts`](../packages/sandbox/sandbox/src/escalation.ts) |
| Session 策略解析 | 按“本次批准模式 → Session 覆盖 → 部署默认值”的顺序解析策略和工作区 | [`packages/sandbox/sandbox-policy/src/index.ts`](../packages/sandbox/sandbox-policy/src/index.ts) |
| Session 模式事件 | 定义和折叠持久化的 `sandbox/mode` 事件 | [`packages/sandbox/sandbox-policy/src/session-mode.ts`](../packages/sandbox/sandbox-policy/src/session-mode.ts) |
| 本地后端选择 | 按平台选择、探测和缓存 bwrap、Landlock、Seatbelt 或 Windows ACL 后端 | [`packages/sandbox/sandbox-local/src/index.ts`](../packages/sandbox/sandbox-local/src/index.ts) |
| 平台规则生成 | 生成 bwrap 参数、Landlock grants 和 Seatbelt SBPL Profile | [`packages/sandbox/sandbox-local/src/profiles.ts`](../packages/sandbox/sandbox-local/src/profiles.ts) |
| Windows 后端 | 使用 Restricted Token、SID 和 NTFS ACL 限制写入 | [`packages/sandbox/sandbox-windows-acl/src/index.ts`](../packages/sandbox/sandbox-windows-acl/src/index.ts) |
| Bash 执行器 | 调用 `ctx.sandbox.confine()` 包装 Bash argv，并分类拒绝与运行器故障 | [`packages/shell/bash-sandbox/src/index.ts`](../packages/shell/bash-sandbox/src/index.ts) |
| PowerShell 执行器 | Windows 上对应的受限 PowerShell 执行器 | [`packages/shell/pwsh-sandbox/src/index.ts`](../packages/shell/pwsh-sandbox/src/index.ts) |
| 文件系统围栏 | 在进程内检查写入目标是否位于允许目录 | [`packages/fs/fs-sandbox/src/index.ts`](../packages/fs/fs-sandbox/src/index.ts) |
| 路径包含检查 | 规范化目标并处理祖先目录、符号链接及路径身份 | [`packages/fs/fs-sandbox/src/containment.ts`](../packages/fs/fs-sandbox/src/containment.ts) |
| 持久终端 | 在创建终端时固定沙箱策略，并阻止终端存活期间降权 | [`packages/terminal/terminal-bash/src/index.ts`](../packages/terminal/terminal-bash/src/index.ts) |
| 用户审批 | 记录 `approval/asked` 和 `approval/decided`，返回一次性允许或拒绝结果 | [`packages/interaction/user-approval/src/index.ts`](../packages/interaction/user-approval/src/index.ts) |
| 权限预设 | 将沙箱模式和审批策略组合成用户可选预设 | [`packages/interaction/permission-presets/src/index.ts`](../packages/interaction/permission-presets/src/index.ts) |
| 默认产品配置 | 装配本地沙箱、策略、Shell、审批、预设和文件系统围栏 | [`packages/bundle/base/cordis.patch.yml`](../packages/bundle/base/cordis.patch.yml) |

## 三种模式

| 模式 | 文件写入行为 | 是否调用 `ctx.sandbox` |
|---|---|---|
| `read-only` | 受管能力不能修改文件；POSIX 后端保留 `/dev/null` 等运行所需的最小写入点 | 是 |
| `workspace-write` | 允许写 Session 工作区和后端承诺的临时目录 | 是 |
| `danger-full-access` | 使用宿主进程原有权限，不限制写入 | 否 |

模式只声明文件效果，不声明网络限制或统一的进程可见性限制。`read-only` 也不是数据保密模式：文件读取通常仍然可用。

## 普通命令的执行流程

```text
模型调用 bash/pwsh 工具
  → 工具取得当前 Agent 和 Session
  → ctx.sandboxPolicy.resolve({ session })
  → danger-full-access：直接执行原始 argv
  → 受限模式：ctx.sandbox.confine(argv, policy)
  → 平台后端生成新的受限 argv
  → ctx.subprocess 启动进程
  → 执行器分类普通失败、策略拒绝或沙箱运行器故障
  → 工具把结果和提权提示返回模型
```

Bash 工具读取 `sandbox_permissions` 和 `justification` 的入口位于 [`packages/shell/tool-bash/src/index.ts`](../packages/shell/tool-bash/src/index.ts)。PowerShell 对应入口位于 [`packages/shell/tool-pwsh/src/index.ts`](../packages/shell/tool-pwsh/src/index.ts)。

## 文件工具的执行流程

文件工具不会为写入操作启动子进程，因此不经过 bwrap、Landlock 或 Seatbelt。`dsh-fs-sandbox` 在 Harness 进程内执行以下检查：

1. 解析本次调用的 Session 策略。
2. `read-only` 直接抛出 `FS_SANDBOX_DENIED`。
3. `workspace-write` 在写入前重新规范化目标路径。
4. 目标必须位于工作区或允许的临时目录中。
5. 使用重新解析后的目标执行写入，降低符号链接被替换带来的风险。

文件工具共享的一次性提权适配位于 [`packages/fs/tool-fs/src/sandbox.ts`](../packages/fs/tool-fs/src/sandbox.ts)。这个检查是可信代码中的路径围栏，不是内核安全边界；它缩小但不能完全消除路径解析到系统调用之间的竞态。

## 平台实现

| 平台 | 选择顺序 | 主要行为 | 完整性 |
|---|---|---|---|
| Linux | bwrap → Landlock | bwrap 使用只读根挂载、私有 PID namespace、独立 `/proc`，并按模式绑定工作区；Landlock 使用内核文件访问规则 | bwrap 为 `full`；Landlock 取决于内核 ABI，可能为 `partial` |
| macOS | Seatbelt | 通过 `sandbox-exec` 加载 SBPL，默认允许操作但拒绝未列入允许目录的文件写入 | `full`，但依赖已弃用的系统工具 |
| Windows | Restricted Token + NTFS ACL | 工作区使用稳定写入 SID，Session 临时目录使用独立可撤销权限 | `partial` |
| SSH | 远端本地后端 | 本地把策略交给远端 Helper，远端再选择自身平台后端 | 继承远端后端结果 |

SSH 适配器入口位于 [`packages/ssh/sandbox-ssh/src/index.ts`](../packages/ssh/sandbox-ssh/src/index.ts)。容器和 microVM 不作为 `sandbox-local` 的后端；需要独立执行环境时，应整体替换文件系统、子进程和沙箱 Provider。

## 一次性提权与权限预设

权限预设把两个独立设置组合起来：

| 预设 | 沙箱模式 | 审批策略 |
|---|---|---|
| `read-only` | `read-only` | `ask` |
| `workspace-write` | `workspace-write` | `ask` |
| `danger-full-access` | `danger-full-access` | `never` |

当前基础 Bundle 默认使用 `process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`。当默认值不是 `danger-full-access` 时，审批策略为 `ask`；相关配置位于 [`packages/bundle/base/cordis.patch.yml`](../packages/bundle/base/cordis.patch.yml)。

一次性提权流程如下：

```text
受限调用被拒绝
  → Agent 使用相同调用参数重试
  → 同时提交 sandbox_permissions 和 justification
  → 校验请求模式必须严格宽于当前模式
  → ctx.approval.request() 询问用户或自动化审批方
  → allowed-once：只为这一次调用传入显式模式
  → rejected/unavailable：调用不执行
```

Session 的长期模式切换与一次性批准不同。长期切换写入 `sandbox/mode` 事件；一次性批准只参与当前调用的策略解析。

## 持久终端

持久终端在打开时解析一次策略，并让交互式 Shell 在这个限制下持续运行。只要所属 Agent 仍有终端正在创建或存活，系统就拒绝修改其有效沙箱模式，防止高权限终端在 Session 降权后继续运行。

核心实现位于 [`packages/terminal/terminal-bash/src/index.ts`](../packages/terminal/terminal-bash/src/index.ts)。

## 子 Agent

进程内子 Agent 不会自动获得独立容器。它拥有独立 Session 和 Cordis Scope，但仍使用同一个执行环境中的 Provider。创建子 Agent 时，委派逻辑把父 Agent 的沙箱模式写入子 Session，并把子 Session 的审批策略固定为 `never`；Auto 和 Full Access 的预设身份按委派规则记录。

权限派生入口位于 [`packages/subagent/subagent/src/child-agent.ts`](../packages/subagent/subagent/src/child-agent.ts)。因此，Agent 隔离的主要单位是 Session 策略和工作区，而不是每个 Agent 一个操作系统容器。

## 安全边界和限制

- 文件读取通常不受限制；`read-only` 的含义是禁止写入，不是禁止读取。
- 网络访问不属于 `SandboxMode`，Web 工具和受限 Shell 的网络能力需要其他策略控制。
- 进程可见性取决于后端；bwrap 使用私有 PID namespace，但其他后端没有相同保证。
- Windows 后端需要保留部分环境权限，并受到 NTFS 硬链接语义影响，所以明确报告 `partial`。
- 旧 Landlock ABI 不能控制所有文件访问类别，也可能报告 `partial`。
- macOS 后端依赖 Apple 已弃用但当前仍提供的 `sandbox-exec`。
- 文件工具的进程内路径检查不是针对恶意宿主进程的内核边界。
- `danger-full-access` 是无约束执行，不是一个更宽松的沙箱 Profile。

## 推荐阅读顺序

1. 从公共类型开始：[`packages/sandbox/sandbox/src/index.ts`](../packages/sandbox/sandbox/src/index.ts)。
2. 阅读每次调用如何解析策略：[`packages/sandbox/sandbox-policy/src/index.ts`](../packages/sandbox/sandbox-policy/src/index.ts)。
3. 阅读平台选择和 argv 包装：[`packages/sandbox/sandbox-local/src/index.ts`](../packages/sandbox/sandbox-local/src/index.ts)。
4. 对照一个消费者：[`packages/shell/bash-sandbox/src/index.ts`](../packages/shell/bash-sandbox/src/index.ts)。
5. 阅读提权如何连接工具和审批：[`packages/sandbox/sandbox/src/escalation.ts`](../packages/sandbox/sandbox/src/escalation.ts)。
6. 最后比较文件围栏和进程隔离：[`packages/fs/fs-sandbox/src/index.ts`](../packages/fs/fs-sandbox/src/index.ts)。
