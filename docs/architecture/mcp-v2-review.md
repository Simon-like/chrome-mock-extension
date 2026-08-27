# MCP v2 架构评审：多 Agent、首轮效率与接入简化

> 类型：Architecture Review
> 状态：Proposed
> 更新：2026-08-27
> 依赖：[MCP Server](./mcp-server.md)、[ADR-0003](./decisions/ADR-0003-local-mcp-bridge-security.md)

## 结论

当前架构已经能让多个 MCP 客户端进程同时使用同一个扩展：第一个进程成为 Hub，其他进程作为 Peer 转发；扩展侧所有写操作仍经过单一 Command 通道。因此本轮不重写传输层，先解决两个投入产出比最高的问题：

1. 用 `get_page_context` 将 Agent 的首次理解从多次试探压缩为一次调用。
2. 下一阶段把 Server 打包成稳定 CLI，并提供显式安装器，消除绝对路径、手动构建和复制配置。

只有当实际使用证明“每个客户端一个 stdio 进程”的生命周期成本成为主要瓶颈时，才评审常驻的 Streamable HTTP daemon。

## 当前并发模型

```text
Agent Host A ─ stdio ─ MCP 进程 A（Hub）──┐
Agent Host B ─ stdio ─ MCP 进程 B（Peer）─┼─ WebSocket ─ Extension SW ─ Command reducer
Agent Host C ─ stdio ─ MCP 进程 C（Peer）─┘
```

- 同一个 AI Host 可以维护多个 MCP client；不同 AI 工具则各自启动 stdio Server。MCP 官方架构也将 Host、Client、Server 分层，Host 可创建多个 Client 实例。[MCP Architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture)
- Hub/Peer 解决多个本地 Server 抢占同一端口的问题；Hub 退出后 Peer 会重新选举。
- 扩展 Service Worker 是持久化状态的唯一写入口，写请求会按消息到达顺序执行，避免存储层并发覆盖。
- 当前保证的是“安全落盘”，不是“业务事务隔离”。两个 Agent 同时改同一条规则时，仍是后到写入覆盖先到结果。

### 后续并发增强

若真实协作出现覆盖冲突，再增加两项，不提前复杂化本轮：

- 在规则上引入 `revision`，写工具支持 `expected_revision`，冲突时返回最新摘要而不是静默覆盖。
- 在桥请求中附带可选 `clientId` / `agentId`，用于审计与冲突提示；不得把它当认证凭据。

## Agent 为什么理解慢

原流程通常需要依次调用 `get_status`、`list_recent_requests`、`list_rules`，再决定是否取详情。问题不在模型不会用工具，而在任务上下文被拆成了多个低层查询：每次往返都要重新判断，而且完整响应体过早进入上下文。

本轮新增的 `get_page_context` 并发读取状态与请求，返回：

- 总开关、读侧状态、脱敏状态；
- 最近未 Mock 或异常请求的短摘要；
- 与 URL 相关的规则和当前变体；
- 明确的下一步建议。

完整 body 仍由 `get_request_detail` 按需读取。这样常见的“页面没数据”只需一次首轮调用，同时避免把大 JSON 塞入每个 Agent 的上下文。

### 工具设计约束

- Server instructions 只说明触发场景和推荐调用顺序，不重复整份工具手册。
- 工具名、描述和输出字段保持稳定、短小、可预测；MCP 工具定义本身支持 description、输入/输出 schema 与行为 annotations。[MCP Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- Prompts 继续作为客户端不注入 instructions 时的人工入口；大篇幅领域材料后续可考虑 Resources。MCP 将 prompts、resources、tools 分别定位为用户、应用、模型控制的能力。[MCP Server primitives](https://modelcontextprotocol.io/specification/2025-06-18/server/index)
- 详情按需获取；列表返回摘要和稳定 ID，禁止用全量响应体充当“方便”。

## 连接配置方案评估

| 方案 | 用户体验 | 多客户端 | 成本 / 风险 | 决策 |
| --- | --- | --- | --- | --- |
| 发布 CLI：`npx -y mock-studio-mcp` | 不再填写编译产物绝对路径，也不需手动 build | 保留现有 Hub/Peer | 需要发布、版本与离线策略 | **下一步首选** |
| `mock-studio mcp install` 本地安装器 | 自动探测并写入各客户端配置，可附带诊断 | 同上 | 客户端配置格式不同；写外部配置必须由用户显式执行 | **P1 跟进** |
| 常驻 Streamable HTTP daemon | 一个进程服务多个客户端，只配置 URL | 原生共享进程 | 安装、守护、端口、授权与升级明显更复杂 | **按数据决定** |
| Chrome Native Messaging | 浏览器侧连接稳定 | 仍需向 MCP 客户端暴露 Server | 各 OS host manifest 和安装成本高 | 不推荐 |
| 托管远端 Server | 客户端配置简单 | 天然并发 | 破坏本地优先边界，浏览数据与认证风险显著增加 | 不采用 |

MCP 当前标准传输包含 stdio 与 Streamable HTTP：stdio 由客户端启动子进程；Streamable HTTP 是独立 Server，可处理多个客户端连接。[MCP Transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) 当前 token 通过 stdio 子进程环境变量传入，符合 stdio 凭据应从环境获取的边界；若迁移 HTTP，则需单独实现 MCP 授权流程。[MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

## 推荐演进顺序

### P0：本轮已完成

- 增加 `get_page_context`，作为不明确页面问题的首选入口。
- instructions 固化成“上下文 → 必要详情 → 写操作”的调用顺序。
- e2e 覆盖单调用上下文与两个 MCP 客户端共享扩展。

### P1：接入零摩擦

- 发布带版本的可执行 CLI，扩展复制出的配置不再含仓库绝对路径。
- 增加 `doctor`：检查 Node 版本、端口、token、扩展握手和客户端进程残留。
- 增加由用户显式运行的安装器适配器；写配置前预览 diff，并保留备份。

### P2：协作可观测

- 记录客户端标识和最近工具调用摘要。
- 以 `revision` 提供同规则并发写冲突提示。
- 统计首轮调用数、上下文大小和成功建规则时间，验证优化是否有效。

### P3：有证据再换传输

当 stdio 进程数、Hub 选举或客户端配置维护成为可测量的主要问题，再做 Streamable HTTP daemon Spike；评审必须同时覆盖 daemon 生命周期、本地授权、旧客户端兼容和回滚。
