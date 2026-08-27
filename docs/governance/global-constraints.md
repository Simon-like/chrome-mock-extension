# 全局约束

> 类型：Governance / Constraint Registry
> 状态：Active
> 更新：2026-08-27
> Owner：项目维护者
> 变更规则：修改任何一条都必须说明原因；涉及架构或安全边界时同时新增 ADR。

这些约束是项目级“不变量”。它们来自已实现架构、真实站点 Spike、安全验证和现有产品定位。功能 PRD 与技术方案默认继承本页，不应重复定义另一套。

## G-01 本地优先与零账号

- Mock 规则和捕获数据默认保存在本机，不依赖云端账号体系。
- 不得在没有明确产品决策和安全评审的情况下上传真实请求、响应或规则。

## G-02 拦截能力边界

- 响应体 Mock 的主路径是 MAIN world 中 hook `fetch` / `XMLHttpRequest`。
- 注入必须保持 `world: "MAIN"` 与 `run_at: "document_start"`；改变任一项前必须重新做真实站点 Spike。
- 该路径不是浏览器真实网络层；产品自己的请求面板承担 Mock 可观测性，不能假设 Chrome Network 面板会显示改写后的响应。

来源：[ADR-0001](../architecture/decisions/ADR-0001-interception-strategy.md)、[SPIKE-0001](../experiments/SPIKE-0001-main-world-interception.md)。

## G-03 Core 可移植性

- `src/core/**` 不得依赖 `chrome.*`、DOM 或 React。
- 规则匹配、迁移、校验和命令处理保持为可在扩展与 Node/MCP 两侧复用的纯 TypeScript 逻辑。
- 平台适配和副作用留在 `src/hosts/**`。

来源：[ADR-0002](../architecture/decisions/ADR-0002-core-and-command-boundaries.md)。

## G-04 状态写入单通道

- 所有规则状态变更统一表达为 Command，并走 reducer/dispatch 路径。
- UI、导入和 MCP 不得各自实现一套校验、持久化或副作用。
- 存储 Schema 必须有显式版本；不兼容变更通过迁移处理，不能让旧数据静默失效。

来源：[系统设计](../architecture/system-design.md)、[ADR-0002](../architecture/decisions/ADR-0002-core-and-command-boundaries.md)。

## G-05 引擎失败隔离

- 插件异常不得破坏宿主页面原本的 `fetch` / XHR 行为；无法安全 Mock 时应回退真实请求。
- 正则匹配必须在执行前阻止已知危险模式，不能依赖执行超时作为 ReDoS 防线。
- 引擎健康检查必须验证行为，不能仅比较函数引用。

来源：[2026-08-07 项目交接快照 §6](../delivery/snapshots/2026-08-07-project-handoff.md#6-不能踩的坑)。

## G-06 动态响应与 CSP

- 动态 JS 只在目标站点允许 `new Function` 时使用；探测必须由用户显式触发，因为它会执行代码并可能产生副作用。
- 语法检查不执行用户代码；运行时失败应可诊断并回退。
- CSP 不允许动态执行时，Mock 模板仍应可用，两者是互补能力。

来源：[SPIKE-0002](../experiments/SPIKE-0002-dynamic-response.md)、[Mock 模板语法](../reference/mock-template-syntax.md)。

## G-07 MCP 本地桥安全边界

- WebSocket Server 只监听 `127.0.0.1`。
- 浏览器连接必须校验 `chrome-extension://` Origin 和配对码。
- 请求数据离开扩展进程前必须强制脱敏；脱敏不能提供“已完全安全”的承诺。
- 读侧开关与域名白名单必须保留；白名单为空表示不限域名，并在 UI 中给出风险提示。
- MCP 写操作复用核心 Command 通道；不得绕开校验和冲突检测。

来源：[ADR-0003](../architecture/decisions/ADR-0003-local-mcp-bridge-security.md)、[MCP Server](../architecture/mcp-server.md)。

## G-08 UI 语义一致性

- 复选框表达“选择对象”，开关表达“启用/停用状态”，两者不得混用。
- 虚拟接口与覆盖式 Mock 必须可区分；关闭 Mock 后可能真实 404 的风险要对用户可见。
- 项目、分组、规则、变体的概念以 [PRD-0002](../product/prds/PRD-0002-information-architecture.md) 为准。

## G-09 文档与实现一致性

- 精确行为优先由自动化测试约束；文档不得声明未经验证的“已完成”。
- 带日期的路线图和交接是历史快照，不能作为当前状态的唯一证据。
- 移动或重命名文档时必须同步修复 README、源码注释、测试注释和 Skill 中的路径。
