# 架构总览与演进

> 类型：Architecture Overview
> 状态：Active
> 更新：2026-08-27

## 当前系统边界

```text
宿主页面 MAIN world
  └─ inject：hook fetch/XHR，匹配并生成 Mock 响应
        ↕ window.postMessage
content script：页面与扩展的隔离桥
        ↕ chrome.runtime
background service worker：状态、采集、广播、MCP 桥
        ↕ chrome.storage.local
popup / options / devtools：用户界面

AI 客户端
  ↕ MCP stdio
本地 Node MCP Server
  ↕ WebSocket 127.0.0.1
background service worker
```

核心业务逻辑位于 `src/core/**`，保持纯 TypeScript 和平台无关；共享协议位于 `src/shared/**`；Chrome、DOM、React 和 Node 的副作用留在各自 host。完整模块和消息流见[系统设计](./system-design.md)，MCP 的实现边界见 [MCP Server](./mcp-server.md)。

## 当前事实源

| 主题 | 权威文档 | 备注 |
| --- | --- | --- |
| 项目级不变量 | [全局约束](../governance/global-constraints.md) | 修改需同步评审 |
| 系统分层、Schema、消息流 | [系统设计](./system-design.md) | 原始 v1 设计；数据模型以 PRD-0002 与当前代码为准 |
| 项目/分组/规则/变体语义 | [PRD-0002](../product/prds/PRD-0002-information-architecture.md) | 已交付的产品定义 |
| 动态响应边界 | [SPIKE-0002](../experiments/SPIKE-0002-dynamic-response.md) | 目标站点或 CSP 变化需重验 |
| 模板精确语法 | [Mock 模板语法](../reference/mock-template-syntax.md) | 应与 `src/core/engine/mockjs.ts` 和测试同步 |
| MCP 架构与安全 | [MCP Server](./mcp-server.md)、[MCP v2 评审](./mcp-v2-review.md)、[ADR-0003](./decisions/ADR-0003-local-mcp-bridge-security.md) | 使用步骤另见 Guide |
| 工作台 UI 演进 | [PRD-0003](../product/prds/PRD-0003-workbench-usability.md)、[UI 设计评审](./workbench-ui-review.md) | 大范围布局与视觉修改需先评审 |

## 架构演进

| 阶段 | 变化 | 形成的长期决策 | 证据 |
| --- | --- | --- | --- |
| 2026-07 立项 | 比较 DNR、MAIN world hook、CDP 三条响应体 Mock 路线 | MAIN world hook 为主；产品面板补足可观测性 | [ADR-0001](./decisions/ADR-0001-interception-strategy.md) |
| 2026-07 Spike | 在真实站点验证注入时机、包装层和失败回退 | `MAIN + document_start`；引擎故障不破坏页面 | [SPIKE-0001](../experiments/SPIKE-0001-main-world-interception.md) |
| 2026-07 基线设计 | 拆出纯 core、Schema 迁移、Command 单写入通道、事件广播 | UI/扩展/MCP 共享规则语义 | [ADR-0002](./decisions/ADR-0002-core-and-command-boundaries.md) |
| 2026-08 信息架构 | 引入项目、分组和变体，迁移 v1 数据 | 产品概念与存储模型从初版演进 | [PRD-0002](../product/prds/PRD-0002-information-architecture.md) |
| 2026-08 动态能力 | 验证 `new Function`，同时实现无 eval 的模板子集 | 动态 JS 与 Mock 模板并存，按 CSP 降级 | [SPIKE-0002](../experiments/SPIKE-0002-dynamic-response.md) |
| 2026-08 AI 协同 | 增加本地 MCP Server 与 WebSocket bridge | 本地回环、Origin + 配对码、扩展侧强制脱敏 | [ADR-0003](./decisions/ADR-0003-local-mcp-bridge-security.md) |
| 2026-08 易用性修复 | 原子保存变体，区分请求快照与当前 Mock，增加 MCP 首轮上下文 | 先修正确性与语义；管理页布局和视觉分阶段评审 | [PRD-0003](../product/prds/PRD-0003-workbench-usability.md)、[MCP v2 评审](./mcp-v2-review.md) |

## 设计文档与 ADR 的关系

Design 描述“系统如何完整工作”，会随实现演进；ADR 描述“为什么做了一个长期重要选择”，接受后不重写历史。实现偏离 Design 时更新 Design 的偏差记录；推翻 ADR 时新增 ADR 并声明替代关系。
