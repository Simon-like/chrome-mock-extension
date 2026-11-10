# ADR-0001 以 MAIN world hook 作为响应体 Mock 主路径

> 类型：ADR
> 状态：Accepted
> 日期：2026-07-27
> 整理：2026-08-27
> Owner：项目维护者
> 关联：[市场与产品调研](../../product/discovery/market-and-product-research.md)、[SPIKE-0001](../../experiments/SPIKE-0001-main-world-interception.md)

## Context

Manifest V3 的 declarativeNetRequest 不能直接修改响应体；`chrome.debugger`/CDP 能覆盖真实网络层，但会出现调试提示、与 DevTools 争用并增加性能和权限成本。产品核心需求同时包含动态响应和后端尚不存在的虚拟接口。

## Decision

响应体 Mock 以在宿主页面 MAIN world、`document_start` 时注入并 hook `fetch`/`XMLHttpRequest` 为主路径。DNR 只承担更适合网络规则的能力；CDP 不作为默认实现。由于 Mock 不经过真实网络层，插件自己的请求面板承担命中和返回内容的可观测性。

## Alternatives considered

- 仅 DNR：副作用小且 Network 面板正常，但不能满足动态响应体和虚拟接口。
- `chrome.debugger` + CDP：网络层能力完整，但用户可见副作用、DevTools 互斥和性能成本不适合作为默认路径。

## Consequences

- 能读取请求上下文并生成静态、模板或动态响应，也能直接响应不存在的接口。
- 主要覆盖 fetch/XHR，不自然覆盖图片、beacon、WebSocket、SSE 等请求类型。
- 注入时机和失败隔离成为硬约束；引擎异常必须回退真实请求。
- Chrome Network 面板不应被当作 Mock 结果的权威观察入口。

## Validation

真实站点验证与边界记录在 [SPIKE-0001](../../experiments/SPIKE-0001-main-world-interception.md)；匹配与响应行为由 `tests/inject.test.ts`、`tests/matcher.test.ts` 和 `tests/responder.test.ts` 约束。
