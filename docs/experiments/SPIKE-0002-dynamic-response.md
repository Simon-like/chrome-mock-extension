# 动态响应 Spike

> 类型：Spike（SPIKE-0002）
> 状态：Concluded
> Owner：项目维护者
> 更新：2026-08-06
> 状态：**✅ Spike 通过，功能已落地**
> 前置文档：[2026-08-07 项目交接快照](../delivery/snapshots/2026-08-07-project-handoff.md) §5.1

**结论先行**：目标站点允许 `new Function`，动态响应已完整实现并接进引擎。
本文保留完整的推演过程 —— 换一个 CSP 更严的站点时，第 3 章的方法和第 5 章的分支依然要用。

---

## 1. 要回答的那一个问题

> **目标站点的 CSP 允不允许 `new Function`？**

不允许的话，整条「动态响应」方案在那个站点上不成立 —— 不是"体验差一点"，是**根本跑不了**。
所以先量，别先写。这跟当初做注入可行性 Spike 是同一个道理（[SPIKE-0001](./SPIKE-0001-main-world-interception.md)）。

---

## 2. 为什么只剩 `new Function` 这一条路

用户写的那段 JS 得在某个地方执行。三个候选，两个当场出局：

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| Service Worker 里执行 | ❌ 不成立 | `xhr.send()` 是**同步**方法。SW 在另一个进程，一次往返是异步的，同步方法等不了。这跟 05 §4.3 里「规则未就绪时只能 fail-open」是同一个物理约束 |
| 往页面插 `<script>` | ❌ 不成立 | 同样受 `script-src` 管，并且拿不到返回值 |
| MAIN world 里 `new Function` | ✅ 唯一可行 | 但受页面 CSP 的 `script-src 'unsafe-eval'` 管辖 —— **这就是要测的东西** |

注意扩展**自己**的注入脚本不受页面 CSP 限制（Chrome 把它当受信任来源注入），
但 `new Function` 是在**页面的 realm** 里编译代码，那一刻就归页面 CSP 管了。
所以"引擎注进去了"不等于"动态响应能用"，必须单独测。

---

## 3. 怎么测（3 分钟）

1. `npm run build`，在 `chrome://extensions` 加载 `dist/`
2. 打开要评估的站点，**刷新一次**（确保引擎已注入）
3. 点扩展图标 → 点 **「探测：本站能否用动态响应」**
4. 把结果记到下面第 5 章的表里

也可以在页面控制台直接跑：

```js
__MOCK_STUDIO__.probeDynamicSupport()
```

### ⚠️ 探测有副作用，别自动跑

被 CSP 拦下时浏览器会派发 `securitypolicyviolation`。站点若配了 `report-uri`，
**我们就往人家的监控里灌了一条告警**。所以探测：

- 不在页面启动时自动执行
- 在 `__MOCK_STUDIO__` 上是**方法**不是 getter —— 否则在控制台展开这个对象就会被无意触发
- 结果按页面缓存一次，不重复打点

### 顺带确认站点的 CSP

```js
document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content
```

响应头里的 CSP 得在 DevTools → Network → 文档请求 → Response Headers 里看
（`content-security-policy`）。找 `script-src` 里有没有 `'unsafe-eval'`。

---

## 4. 实现

| 位置 | 内容 |
| --- | --- |
| [`src/core/engine/dynamic.ts`](../../src/core/engine/dynamic.ts) | 能力探测 · 编译 · 受保护执行 · 上下文构造 · **运行时（编译缓存 + 熔断）**。纯函数，无 chrome/DOM 依赖 |
| [`src/core/engine/responder.ts`](../../src/core/engine/responder.ts) | `bodyType: 'dynamic'` 时现算 body，结果继续走外壳 |
| [`src/hosts/inject/index.ts`](../../src/hosts/inject/index.ts) | 持有页面级 runtime；探测入口；失败时 console 提示一次；收到新快照清熔断 |
| [`src/hosts/options/RuleEditor.tsx`](../../src/hosts/options/RuleEditor.tsx) | 静态 / 动态切换、三个代码模板 |
| [`src/ui/CodeEditor.tsx`](../../src/ui/CodeEditor.tsx) | JS 模式 + **不求值的语法校验**（见下） |
| [`src/hosts/devtools/PanelApp.tsx`](../../src/hosts/devtools/PanelApp.tsx) | 执行失败的请求标红、详情里显示错误与耗时 |
| [`tests/dynamic.test.ts`](../../tests/dynamic.test.ts) · [`tests/responder.test.ts`](../../tests/responder.test.ts) | 25 + 25 个测试 |

### 写法：两种都支持

用户两种都会写，只认一种然后报语法错误很不友好：

```js
// 写法一：表达式
(req) => ({ list: [], total: 0 })

// 写法二：直接写函数体
return { list: [], total: 0 };
```

### 上下文 `req`

```ts
{ url, method, host, path, query }
```

`query` 的值**一律是字符串**（URL 里本来就没有类型），要算数自己 `Number()`。
不做自动类型推断 —— `?page=007` 该是 7 还是 "007"，猜错比不猜更难查。

### 编辑器里怎么验语法（不求值）

MV3 扩展页面禁用 `eval`，所以**不能**靠「试着编译一下」来验语法，也做不了预览。
改用 CodeMirror 的 Lezer 语法树：解析器遇到语法错误会插入 error 节点，
数一数就知道有没有错、在第几行。纯静态分析，不执行任何代码。

宁可漏报也不误报 —— 误报会让人以为自己写错了，去改本来正确的代码。

### 三道防线

| 防线 | 拦什么 | 在哪 |
| --- | --- | --- |
| 语法树校验 | 写的时候就括号没配上 | 编辑器（保存前） |
| try/catch + 序列化保护 | 运行时抛异常、返回 Promise、循环引用 | `runDynamicBody` |
| 熔断（连错 3 次） | 同一条规则反复失败，别再浪费每个请求 | `createDynamicRuntime` |

熔断按「规则 + 变体」隔离 —— 同一条规则的不同变体是不同的代码，
一个变体写错了不该把另一个也拖下水。用户改完规则保存，新快照到达时自动清零恢复。

失败时返回 `{"__mockStudioError__": "..."}` 而**不是**静默的 `{}` ——
静默返回空对象的话，页面会「正常」渲染出空列表，开发者得排查半天
才发现是自己那段 mock JS 写错了。

### 关于"超时保护"的诚实说明

09 号文档 §5.1 写的是"包 try/catch + 超时保护"。try/catch 做到了；
**超时做不到**，得说清楚：

同线程内没有任何 API 能中断一段同步的死循环。所谓超时只能是**事后**测量 ——
这次卡了，下次别再跑。这跟 ReDoS 那道防线是同一个教训（09 §6.4）：
事后测量拦不住第一次，**所以第一次的代价必须可接受**。

这里可接受的理由是：用户代码跑在 MAIN world，死循环的爆炸半径等同于
页面自己的脚本写了死循环，而且只影响开发者本人正在调试的页面 —— 不像 ReDoS
那样会卡死一个本来完全正常的线上站点。

已实现：耗时预算 `DYNAMIC_BUDGET_MS = 50` + `slow` 标记（面板里提示"偏慢"）+ 熔断。

---

## 5. 实测结论

**目标站点探测通过 —— 允许 `new Function`，走「全部允许」分支，功能已实现。**

再评估新站点时补一行：

| 站点 | 日期 | 探测结果 | 备注 |
| --- | --- | --- | --- |
| 目标站点 | 2026-08-06 | ✅ 允许 | 走「全部允许」分支 |

### 三种结局分别怎么走

- **全部允许** ← 当前所在分支。已按 §4 完整实现
- **全部禁止** → 动态响应对该站点无价值，降级去做 P1 的 Mock.js 假数据（那条路只需模板解析，不需要 eval）
- **部分禁止** → 功能保留，但必须：编辑器里对禁用站点显式提示、运行时回落、请求面板标红。**不能静默失败** —— 用户会以为是自己 JS 写错了，查半天

**遇到禁用站点时目前会怎样**：`new Function` 抛 EvalError → 编译失败 →
返回 `__mockStudioError__` 载荷 + 面板标红 + 控制台提示一次 + 连错 3 次后熔断。
也就是说「不静默失败」这条已经满足了，只是错误信息说的是编译失败而非 CSP。
真遇到再把 CSP 探测结果接进这条提示即可（`probeEvalSupport` 已经现成）。

---

## 6. 顺带记一笔

Manifest V3 扩展**自己的页面**（popup/options/devtools）里是彻底禁用 `eval` 的，
这是平台强制的，改不了。所以哪怕将来想在 options 页做「动态响应预览」，
也只能把源码发到 MAIN world 去跑，不能在编辑器里就地求值。
