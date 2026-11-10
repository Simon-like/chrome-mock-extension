# ADR-0002 使用纯 Core 与 Command 单写入通道

> 类型：ADR
> 状态：Accepted
> 日期：2026-07-27
> 整理：2026-08-27
> Owner：项目维护者
> 关联：[系统设计](../system-design.md)、[PRD-0001](../../product/prds/PRD-0001-ai-collaboration-and-virtual-endpoints.md)

## Context

同一套规则需要被注入引擎、Options/DevTools UI、导入流程和未来的 AI/MCP 写侧使用。若规则逻辑依附 React 组件或 Chrome API，Node 侧无法复用；若每个入口直接改 storage，会产生不同校验和副作用。

## Decision

把规则匹配、响应生成、Schema 校验/迁移和 Command reducer 放在不依赖 Chrome、DOM、React 的 `src/core/**`。所有状态变更表达为 Command 并通过统一 dispatch 路径执行；host 层负责持久化、平台消息和广播。Schema 使用显式版本与迁移函数。

## Alternatives considered

- UI 组件直接读写 storage：初期简单，但多入口后无法保证一致性，也难以测试。
- 为 MCP 单独复制规则逻辑：交付快但会形成两套语义和安全边界。
- 把 core 发布为独立 npm 包：目前带来不必要的版本与发布成本，直接源码复用已满足单仓库需求。

## Consequences

- Core 可以在 Vitest 和 MCP Node 构建中复用，架构边界可测试。
- 新写入口必须先定义/复用 Command，不能绕过 reducer。
- Chrome 和 Node 两侧需要维持清晰的桥协议与编译配置。
- 数据模型变化必须同时考虑 migration、command types 和各 host 的兼容。

## Validation

`tests/reducer.test.ts`、`tests/migrate.test.ts`、`tests/groups.test.ts` 与 `mcp-server/e2e.mjs` 验证主要边界；MCP 复用结果见 [MCP Server](../mcp-server.md)。
