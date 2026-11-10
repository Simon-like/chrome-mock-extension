# ADR-0003 使用受约束的本地 MCP WebSocket 桥

> 类型：ADR
> 状态：Accepted
> 日期：2026-08-07
> 整理：2026-08-27
> Owner：项目维护者
> 关联：[PRD-0001](../../product/prds/PRD-0001-ai-collaboration-and-virtual-endpoints.md)、[MCP Server](../mcp-server.md)

## Context

AI 客户端需要读到扩展捕获的请求并写入规则。Chrome 扩展不能监听本地服务端口，而 MCP 客户端可以拉起 Node stdio 进程，因此需要一个本地进程桥。localhost 仍可被本机进程和网页尝试访问，真实请求数据还包含凭证、PII 和业务信息。

## Decision

由 Node MCP Server 通过 stdio 服务 AI 客户端，并在 `127.0.0.1` 上提供 WebSocket Server；扩展 Service Worker 作为客户端连接。连接同时校验 `chrome-extension://` Origin 与配对码。所有读数据在离开扩展前强制脱敏，并提供读侧开关与域名白名单。写操作翻译为核心 Command，复用统一校验、持久化和广播。

端口保持可配置但不以随机端口作为安全措施。域名白名单为空表示不限，UI 必须提示风险；真正不可关闭的防线是扩展侧脱敏。

## Alternatives considered

- 扩展直接作为 MCP Server：浏览器运行环境无法提供所需 stdio/监听能力。
- Node 主动连接扩展：扩展无法暴露可被 Node 直接连接的服务端。
- 只依赖随机端口：端口可被低成本扫描，且增加发现/协商复杂度，不能替代认证。
- 只在 Node 侧脱敏：敏感数据已经越过扩展安全边界，防线位置过晚。

## Consequences

- AI 可以读取近期请求、查看规则并通过统一命令修改 Mock。
- 配对码属于本机访问口令，不得提交到 Git。
- 脱敏只能降低凭证和常见 PII 泄漏风险，无法可靠识别姓名、组织、接口路径和所有业务数据。
- Service Worker 生命周期和多客户端连接需要心跳、重连和状态推导。

## Validation

安全校验、脱敏范围、真实浏览器验证和已知限制记录在 [MCP Server](../mcp-server.md)；自动化覆盖见 `tests/redact.test.ts` 与 `mcp-server/e2e.mjs`。
