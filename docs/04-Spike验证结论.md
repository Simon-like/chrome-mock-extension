# Spike 可行性验证 · 结论

> 日期：2026-07-27
> 环境：你司真实业务站点
> 结论：**方案可行 ✓**（技术路线不变，进入技术方案设计）

---

## 1. 结论

「MAIN world 注入 hook」这条主路线在你司站点上**验证通过**。核心证据：

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| 注入时机足够早 | ✅ | `scriptCountAtInstall: 0`、`readyState: "loading"` —— 注入排在页面所有脚本之前 |
| hook 到 fetch | ✅ | 观测到 37 次真实 fetch |
| hook 到 XHR（axios） | ✅ | 观测到 36 次真实 XHR |
| **真的改掉响应**（生死线） | ✅ | fetch 与 XHR 的 mock 都返回 `__mocked_by__: "spike"` |
| MAIN→ISOLATED→SW 链路 | ✅ | 统计数据能从页面传到 Service Worker 并展示 |

---

## 2. 一个重要发现：你司站点存在「请求包装层」

自检最初把结果误报为「hook 被覆盖」，排查后确认是**误报**，但暴露了一个真实且重要的站点特征。

### 现象

- 我们注入最早（`scriptCountAtInstall: 0`）
- 但测试时 `window.fetch !== 我们的hook`、`XHR.prototype.send !== 我们的send`
- 然而 mock 依然生效（返回了 spike 数据）、37+36 次真实请求依然被我们观测到

### 解释

你司站点上有代码（**几乎可以确定是监控/APM/埋点 SDK**，如 Sentry / DataDog / 听云 / 阿里 ARMS 之类）在我们**之后**包裹了 `fetch` 和 `XMLHttpRequest.prototype.send` 来统计请求耗时。调用链变成：

```
页面业务代码
   → 监控SDK的包装（最外层，后注入）
      → 我们的 hook（最底层，最早注入）
         → mock 命中则返回假数据 / 否则发真实请求
```

因为我们注入最早，**处于调用链最底层**，所有请求最终都会穿过我们 —— 所以 mock 照常生效。这其实是**最理想的位置**。

### 为什么这是好消息而非坏消息

| | 说明 |
| --- | --- |
| ✅ mock 生效 | 已用真实请求验证 |
| ✅ 位置最优 | 后来的包装只能包在我们外面，并把请求委托给我们 |
| ✅ 稳定前提明确 | 只要守住 `document_start` + `world: MAIN`，我们永远最早、永远在最底层 |

---

## 3. 对正式产品的影响

### 3.1 引擎设计要点（写进技术方案）

| # | 要点 | 原因 |
| --- | --- | --- |
| E1 | **必须 `run_at: document_start` + `world: MAIN`**，不可退让 | 这是「排在最底层」的唯一保证；晚一步就可能被别的包装抢到下面 |
| E2 | hook 后把 `fetch.toString()` 伪装成原生 | 有些监控/风控 SDK 会检测 fetch 是否被篡改；伪装可降低被识别的概率（Spike 已做） |
| E3 | 兼容「被包裹」场景，不要假设 `window.fetch` 恒等于我们的引用 | 别用结构判断（引用相等）来判断 hook 是否有效，要用行为判断 |
| E4 | F5 实时请求面板的「hook 健康度」指示，判据是"mock 是否生效"而非"是否最外层" | 否则会像 Spike 一样误报 |

### 3.2 自检逻辑的教训（已在 Spike 修正）

原自检用 `window.fetch === ourFetch`（结构相等）判断 hook 是否在位，这是**错的**。正确判据是行为——发一个测试请求，看 mock 有没有生效。已修正 `spike/popup.js` 与 `spike/injected.js`，重跑应显示：

```
结论：方案可行 ✓
（站点存在请求包装层，已确认不影响 mock）
```

### 3.3 仍需留意的边界（非阻塞，记入风险台账）

| 边界 | 说明 | 处理时机 |
| --- | --- | --- |
| Web Worker / Service Worker 内发起的请求 | content script 不注入 worker，hook 不到 | 已知限制，V2 视需要再说 |
| 若某 SDK 的包装**不委托**原始函数 | 理论上会阻断，但这类 SDK 会让页面自身请求也失败，现实中极少 | 观察，暂不处理 |
| 若站点改为在我们**之前**注入包装（不太可能，我们在 document_start） | 会翻转调用链顺序 | 靠 E1 守住时机即可规避 |

---

## 4. 下一步

Spike 使命完成，可以在 `chrome://extensions` 移除。进入 **《05-技术方案设计》**：

1. 规则数据模型（Schema，含 `schemaVersion`）
2. core 模块分层（A1–A4 架构预留的落地）
3. 消息协议 / 命令协议
4. 目录结构与构建配置（Vite + CRXJS + TS）
5. 把 E1–E4 写进引擎模块设计

---

## 附：可选的确认动作

若想确认到底是哪个 SDK 包裹了请求（满足好奇 + 为 E2 收集特征），在你司站点 Console 里跑：

```js
window.fetch.toString().slice(0, 300)
XMLHttpRequest.prototype.send.toString().slice(0, 300)
```

如果看到的不是 `[native code]`、也不是我们的代码，那段源码往往能透露 SDK 名字。**这一步纯属可选，不影响结论。**
