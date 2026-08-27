# 知识扫盲：Chrome 插件核心概念

> 类型：Guide / Explanation
> 状态：Active
> Owner：项目维护者

> 面向：有前端经验、零插件经验
> 目标：读完这份，你能看懂我们后面所有的技术方案讨论
> 阅读方式：**第 1、2、3 章必读且要读懂**（尤其第 2 章），其余可以当手册按需查

---

## 0. 一个前置提醒

网上搜到的 Chrome 插件教程，**大量是 Manifest V2 时代的**，很多写法在今天已经完全不能用（比如 `background page`、`chrome.extension.*`、阻塞式 `webRequest`）。判断一篇教程是否过时，看两个特征：

- 有 `"manifest_version": 2` → 直接跳过
- 有 `"background": { "scripts": [...] }`（而不是 `"service_worker"`）→ 直接跳过

本文档全部基于 **Manifest V3**。

---

## 1. 心智模型：插件不是"一个程序"，是一群进程

前端最容易犯的错误，是把插件想象成一个网页应用。**它不是。**

一个 Chrome 插件是**几段跑在不同地方、彼此隔离、生命周期各不相同的 JS**。它们不共享变量、不共享作用域，只能靠**消息**通信。

```
┌─────────────────────────────────────────────────────────┐
│                        浏览器                             │
│                                                          │
│  ┌────────────────────┐                                  │
│  │  Service Worker    │  插件的"后台大脑"                  │
│  │  (background.js)   │  ⚠️ 会被杀死！没有 DOM！           │
│  └────────────────────┘                                  │
│           ↕ chrome.runtime 消息                           │
│  ┌──────────────────────────────────────────────┐        │
│  │              某个网页 Tab                      │        │
│  │  ┌────────────────────────────────────────┐  │        │
│  │  │  ISOLATED World（隔离世界）              │  │        │
│  │  │  content.js                             │  │        │
│  │  │  能用 chrome.* API，能读写 DOM           │  │        │
│  │  │  ❌ 但看不到页面的 JS 变量！              │  │        │
│  │  └────────────────────────────────────────┘  │        │
│  │           ↕ window.postMessage（唯一通道）     │        │
│  │  ┌────────────────────────────────────────┐  │        │
│  │  │  MAIN World（页面世界）                  │  │        │
│  │  │  injected.js  +  页面自己的所有 JS       │  │        │
│  │  │  ✅ 能改 window.fetch ← 我们干活的地方！   │  │        │
│  │  │  ❌ 但完全用不了 chrome.* API            │  │        │
│  │  └────────────────────────────────────────┘  │        │
│  └──────────────────────────────────────────────┘        │
│           ↕ chrome.runtime 消息                           │
│  ┌────────────────────┐  ┌──────────────────┐            │
│  │  Popup / Options   │  │  DevTools 面板    │            │
│  │  就是普通网页       │  │  F12 里的一个 tab │            │
│  │  关闭即销毁         │  │  F12 关了就没了   │            │
│  └────────────────────┘  └──────────────────┘            │
└─────────────────────────────────────────────────────────┘
```

**记住这一句**：这五块地方的代码，**没有任何一个变量是共享的**。想传数据，只能发消息。

---

## 2. 最重要的一章：两个 World

这一章是整个插件体系里**最反直觉**的部分，也是我们这个项目的技术核心。请务必读懂。

### 2.1 现象

你在 content script 里写：

```js
// content.js
console.log(window.jQuery);   // undefined —— 明明页面里有 jQuery！
window.fetch = myFakeFetch;   // 改了，但页面的 fetch 完全不受影响
```

**为什么？** 因为 content script 默认跑在 **ISOLATED world（隔离世界）**里。

Chrome 给 content script 单独造了一个 JS 执行环境。它和页面：

| | 共享吗 |
| --- | --- |
| **DOM 树** | ✅ 共享（同一个 document，你能读能改） |
| **JS 全局变量 / 原型链 / 内置对象** | ❌ **完全隔离**（两套 `window`，两个 `fetch`） |

这是**安全设计**：防止网页读到插件的权限，也防止网页篡改插件逻辑。

### 2.2 为什么这对我们是生死问题

我们的产品要做的事是：**替换掉页面的 `window.fetch` 和 `XMLHttpRequest`**。

在 ISOLATED world 里改 `window.fetch`，改的是插件自己那个副本，**页面根本不会走**。

所以我们**必须**把 hook 代码送进 **MAIN world**。

### 2.3 怎么进 MAIN world

Chrome 111+ 支持直接在 manifest 里声明（这是最干净的方式，我们采用这个）：

```json
{
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["injected.js"],
      "run_at": "document_start",
      "world": "MAIN"          ← 关键
    }
  ]
}
```

> 老教程里常见的做法是「content script 创建一个 `<script>` 标签插进页面」。那是 Chrome 111 之前的变通方案，**有时序缺陷**（可能晚于页面脚本），我们不用。

### 2.4 代价：MAIN world 用不了 `chrome.*`

MAIN world 里的代码，本质上就是页面的一段普通 JS。**它没有任何插件权限**：

```js
// injected.js (MAIN world)
window.fetch = myHook;                    // ✅ 可以
chrome.runtime.sendMessage({...});        // ❌ chrome 是 undefined
chrome.storage.local.get(...);            // ❌ 同上
```

所以数据要传出来，只能靠 `window.postMessage`，让 ISOLATED world 的 content script 接住再转发：

```
MAIN world (injected.js)
    │  window.postMessage({ source: 'my-ext', data })
    ↓
ISOLATED world (content.js)
    │  window.addEventListener('message', ...) 收到
    │  chrome.runtime.sendMessage(data)  ← 这里才有 chrome API
    ↓
Service Worker (background.js)
```

**这条三段式链路，就是我们插件的主动脉。** 后面所有功能都跑在它上面。

> ⚠️ 安全注意：`window.postMessage` 是页面也能监听/伪造的。转发时必须校验 `event.source === window` 和自定义的 `source` 标记，且不能把敏感数据往下发。

### 2.5 `run_at` 时机：为什么必须是 `document_start`

这是第二个生死问题。

假设页面代码是这样：

```js
// 页面的 app.js
const myFetch = window.fetch;        // ← 页面把原始 fetch 存下来了
// ...过了一会儿
myFetch('/api/user');                // ← 走的是存下来的那个，不是 window.fetch
```

如果我们的 hook 在 `app.js` **之后**才执行，那 `myFetch` 已经指向原始版本，我们再改 `window.fetch` 也拦不住。

`run_at` 三个值：

| 值 | 时机 | 能否 hook 到 |
| --- | --- | --- |
| `document_start` | **DOM 构建之前，页面任何脚本之前** | ✅ 唯一可靠选择 |
| `document_end` | DOM 构建完成（DOMContentLoaded 前后） | ❌ 太晚了 |
| `document_idle`（默认） | 页面空闲时 | ❌ 更晚 |

**结论：`run_at: "document_start"` + `world: "MAIN"`，两个都不能少。**

---

## 3. 五个"地方"分别是什么

### 3.1 Service Worker（后台）

**是什么**：插件的后台大脑，负责协调、存数据、响应事件。

**三个必须知道的特点**：

1. **没有 DOM**。没有 `window`、`document`、`localStorage`、`alert`。想用 DOM 能力（比如解析 HTML、播音频、用 File System Access），要开 **Offscreen Document**（见 7.2）。
2. **会被杀死**。约 **30 秒无事件就终止**，有事件再重启。所以：
   ```js
   let count = 0;                    // ❌ 全局变量随时会丢
   chrome.runtime.onMessage.addListener(() => { count++; });
   // SW 被杀后重启，count 归零
   ```
   **所有状态必须存 `chrome.storage`**，不能存内存。
3. **事件监听必须同步注册在顶层**。SW 重启时会重新执行整个文件，如果监听器写在异步回调里，重启后可能来不及注册就丢事件：
   ```js
   // ✅ 正确
   chrome.runtime.onMessage.addListener(handler);

   // ❌ 错误
   chrome.storage.local.get('cfg', () => {
     chrome.runtime.onMessage.addListener(handler);   // 注册晚了
   });
   ```

> 我们项目的相关点：V2 要接 WebSocket 连本地 MCP Server。好消息是 **Chrome 116+ 起，WebSocket 收发消息会重置这个 30 秒计时器**，所以只要保持 20 秒心跳，连接就能一直活着。

### 3.2 Content Script（内容脚本）

跑在网页里的脚本，**默认 ISOLATED world**。

能力：读写 DOM ✅、用部分 `chrome.*` API ✅（`runtime`、`storage` 等）、读页面 JS 变量 ❌。

在我们项目里，它的角色很单纯：**做 MAIN world 和 Service Worker 之间的中继**。

### 3.3 Injected Script（MAIN world 脚本）

见第 2 章。**实际干活的地方**——所有 hook 逻辑都在这里。

### 3.4 Popup / Options（扩展页面）

就是**普通网页**，用 React 写就行，和你平时开发没区别。

唯一要注意：**Popup 一关就整个销毁**，里面的 state 全没。所以 Popup 只做展示和触发，真正的状态放 `chrome.storage` 或 SW。

### 3.5 DevTools 面板

在 F12 里加一个自己的 tab。需要两个文件：

```json
{ "devtools_page": "devtools.html" }
```

```js
// devtools.js —— 这个文件本身没有 UI，只负责"注册面板"
chrome.devtools.panels.create(
  'Mock',              // tab 名字
  'icon.png',
  'panel.html',        // 真正的面板 UI
  (panel) => {}
);
```

特殊能力：`chrome.devtools.network.onRequestFinished` —— **能拿到 Network 面板级别的请求信息**。

> 我们项目里，F5「实时请求面板」和 F6「Capture-to-Mock」就住在这里。
> 注意：DevTools 面板的生命周期跟着 F12，**F12 一关面板就销毁**，状态同样不能只放内存。

---

## 4. 通信：谁能和谁说话

| 从 → 到 | 方式 |
| --- | --- |
| MAIN world → Content Script | `window.postMessage` （唯一通道） |
| Content Script → MAIN world | `window.postMessage` |
| Content Script ↔ Service Worker | `chrome.runtime.sendMessage` / `onMessage` |
| Popup / Options ↔ Service Worker | `chrome.runtime.sendMessage` |
| Service Worker → 某个 Tab | `chrome.tabs.sendMessage(tabId, msg)` |
| DevTools 面板 ↔ Service Worker | `chrome.runtime.connect`（长连接 Port） |
| 任意 → 任意（持续通信） | `chrome.runtime.connect` 建 Port，双向长连 |

**两种消息模式**：

```js
// 一次性消息
chrome.runtime.sendMessage({ type: 'GET_RULES' }, (response) => { ... });

// 长连接（适合高频/双向，比如 DevTools 面板实时收请求流）
const port = chrome.runtime.connect({ name: 'devtools' });
port.postMessage({ type: 'SUBSCRIBE' });
port.onMessage.addListener((msg) => { ... });
```

> ⚠️ 一个经典坑：`onMessage` 里想异步返回结果，**必须 `return true`**，否则通道会立刻关闭：
> ```js
> chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
>   doAsyncThing().then(sendResponse);
>   return true;                          // ← 少了这行，sendResponse 永远发不出去
> });
> ```

---

## 5. manifest.json 逐字段

这是插件的"入口配置"，相当于 `package.json` + 路由表 + 权限申请书。

```jsonc
{
  "manifest_version": 3,              // 固定 3
  "name": "插件名",
  "version": "0.0.1",                 // 必须是数字和点，不能有 alpha/beta
  "description": "描述",
  "minimum_chrome_version": "116",    // 我们要用 WebSocket 保活，需要 116+

  // 权限：能用哪些 chrome.* API
  "permissions": ["storage", "scripting", "declarativeNetRequest"],

  // 主机权限：能对哪些网站动手（这个是敏感项，审核会看）
  "host_permissions": ["<all_urls>"],

  // 后台 Service Worker
  "background": {
    "service_worker": "background.js",
    "type": "module"                  // 想用 import 语法就加这个
  },

  // 注入到网页的脚本
  "content_scripts": [
    {
      "matches": ["<all_urls>"],      // 哪些页面注入
      "js": ["injected.js"],
      "run_at": "document_start",     // 时机
      "world": "MAIN",                // 世界
      "all_frames": true              // iframe 里也注入
    }
  ],

  // 点击插件图标
  "action": { "default_popup": "popup.html" },

  // 设置页
  "options_page": "options.html",

  // DevTools 面板
  "devtools_page": "devtools.html",

  // 快捷键
  "commands": {
    "toggle-mock": {
      "suggested_key": { "default": "Alt+M" },
      "description": "切换 Mock 总开关"
    }
  },

  // 允许网页访问的插件内资源
  "web_accessible_resources": [
    { "resources": ["injected.js"], "matches": ["<all_urls>"] }
  ]
}
```

---

## 6. 权限模型

分两类，**审核和用户看到的提示语完全不同**：

| 类型 | 例子 | 说明 |
| --- | --- | --- |
| `permissions` | `storage`, `scripting`, `tabs` | 能用哪些 API |
| `host_permissions` | `<all_urls>`, `https://*.foo.com/*` | 能对哪些网站动手 |
| `optional_permissions` | 同上，但运行时才申请 | **上架友好**：安装时不吓人，用到时再弹窗 |

**实践建议**：`<all_urls>` 会让安装提示变成「读取和更改您在所有网站上的数据」，很多用户看到就劝退，审核也更严。

> 我们项目的策略：**默认只申请必要权限，域名走 `optional_host_permissions` 运行时申请**。用户在插件里加一个域名，才动态申请那个域名的权限。这既友好又安全。

```js
// 运行时申请
chrome.permissions.request({ origins: ['https://your-company.com/*'] }, (granted) => {
  if (granted) { /* ... */ }
});
```

---

## 7. 几个必须知道的机制

### 7.1 存储

| API | 容量 | 特点 |
| --- | --- | --- |
| `chrome.storage.local` | ~10MB（可申请 unlimitedStorage） | **我们主要用这个** |
| `chrome.storage.sync` | ~100KB，单项 8KB | 跟 Google 账号同步，太小，不适合存 mock 数据 |
| `chrome.storage.session` | ~10MB | 只在浏览器本次会话，SW 重启也还在，适合放临时状态 |

全部是**异步**的，全部支持 `onChanged` 监听：

```js
chrome.storage.local.onChanged.addListener((changes) => { ... });
```

> 我们项目：规则存 `local`，抓到的请求流存 `session`（不需要持久化，且量大）。

### 7.2 Offscreen Document（MV3 的逃生舱）

Service Worker 没有 DOM。当你确实需要 DOM 能力时，可以创建一个**看不见的页面**：

```js
chrome.offscreen.createDocument({
  url: 'offscreen.html',
  reasons: ['DOM_PARSER'],
  justification: '需要解析 HTML'
});
```

> 我们项目：如果 V2 的 WebSocket 长连在 SW 里不稳，就把连接搬到 offscreen document 里——**它不受 SW 30 秒生命周期限制**。

### 7.3 declarativeNetRequest（声明式网络请求）

MV3 里改网络请求的官方途径。**声明规则，浏览器执行**，你的 JS 不参与。

```js
chrome.declarativeNetRequest.updateDynamicRules({
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'X-Debug', operation: 'set', value: '1' }]
    },
    condition: { urlFilter: '/api/', resourceTypes: ['xmlhttprequest'] }
  }],
  removeRuleIds: [1]
});
```

**能做**：改请求头/响应头、阻断、重定向。
**不能做**：❌ **改响应体**。

> 这就是第 01 号文档里技术路线选型的全部原因。我们只用它改 header 和做重定向，响应体交给 MAIN world hook。

### 7.4 MV2 → MV3 的关键变化（避免被老教程带偏）

| MV2 | MV3 |
| --- | --- |
| `background.page` / `scripts`（常驻） | `service_worker`（会被杀） |
| 阻塞式 `webRequest`（能改响应） | `declarativeNetRequest`（**改不了响应体**） |
| `chrome.extension.*` | `chrome.runtime.*` / `chrome.action.*` |
| 可以 `eval` / 远程代码 | **禁止**，所有代码必须打包在插件内 |
| 回调风格 | 大部分 API 支持 Promise 了 |

---

## 8. 调试：每类脚本的 console 在哪

这是新手最容易卡住的地方——**打了 log 找不到在哪看**。

| 要调试什么 | 怎么打开 |
| --- | --- |
| **Service Worker** | `chrome://extensions` → 找到插件 → 点「Service Worker」链接 |
| **Content Script（ISOLATED）** | 网页的 F12 → Console → **左上角下拉框切到插件名**（默认是 `top`，不切换看不到！） |
| **MAIN world 注入脚本** | 网页的 F12 → Console → 保持 `top`（它就是页面上下文） |
| **Popup** | 右键插件图标 → 「审查弹出内容」 |
| **Options 页** | 打开设置页后直接 F12 |
| **DevTools 面板** | **对 F12 窗口再按一次 F12**（调试 DevTools 的 DevTools） |

**改了代码怎么生效**：

| 改了什么 | 操作 |
| --- | --- |
| content script / 注入脚本 | `chrome://extensions` 点刷新 ↻ → **再刷新网页** |
| Service Worker | 点刷新 ↻ |
| Popup / Options | 重新打开即可 |
| **manifest.json** | 必须点刷新 ↻ |

> 用 Vite + CRXJS 会有 HMR，能省掉大部分手动刷新。但**注入脚本的改动基本都要刷页面**，这个躲不掉。

---

## 9. 常见坑清单

| 坑 | 症状 | 解法 |
| --- | --- | --- |
| 忘了 `world: "MAIN"` | hook 了 fetch 但页面完全不受影响 | 见 2.2 |
| 忘了 `document_start` | 有些请求拦得到，有些拦不到（时序随机） | 见 2.5 |
| SW 里用全局变量存状态 | 过一会儿数据就没了 | 全部存 `chrome.storage` |
| `onMessage` 异步没 `return true` | `sendResponse` 不生效，回调不触发 | 见第 4 章 |
| 在 SW 里用 `document` / `localStorage` | 报错 undefined | 用 `chrome.storage`；需要 DOM 就开 offscreen |
| Content Script 的 console 看不到 | 以为代码没跑 | F12 左上角切上下文 |
| 改了代码不生效 | 一直在调试旧代码 | 见第 8 章刷新规则 |
| `<all_urls>` 导致审核慢/用户劝退 | 上架被卡 | 用 `optional_host_permissions` |
| iframe 里的请求拦不到 | 部分请求漏网 | `all_frames: true` |

---

## 10. 映射到我们的项目

现在回头看 MVP 的功能，你应该能看懂每一块住在哪了：

| 功能 | 住在哪 | 用到的知识 |
| --- | --- | --- |
| F1 拦截引擎 | **MAIN world** | 第 2 章全部 |
| 规则下发给引擎 | SW → content → MAIN，`postMessage` | 第 4 章 |
| F2/F3 规则匹配与响应 | MAIN world（执行）+ core 模块（逻辑） | — |
| F4 开关 | Popup + `chrome.commands` 快捷键 | 3.4 / 第 5 章 |
| F5 实时请求面板 | **DevTools 面板** | 3.5 |
| F6 Capture-to-Mock | DevTools 面板 + core | 3.5 |
| F7 持久化 | `chrome.storage.local` | 7.1 |
| F8 导入导出 | Options 页 | 3.4 |
| F22 虚拟接口 | MAIN world（拦下就不发真实请求） | 第 2 章 |
| L0 AI Skill | 纯文件，不在插件里 | — |
| V2 MCP 长连 | SW 的 WebSocket（或 offscreen 兜底） | 3.1 / 7.2 |

---

## 11. 官方文档索引（需要时查）

| 主题 | 链接 |
| --- | --- |
| 插件总入口 | https://developer.chrome.com/docs/extensions |
| Manifest V3 字段参考 | https://developer.chrome.com/docs/extensions/reference/manifest |
| Content Scripts | https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts |
| Service Worker 生命周期 | https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle |
| 消息通信 | https://developer.chrome.com/docs/extensions/develop/concepts/messaging |
| declarativeNetRequest | https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest |
| DevTools 扩展 | https://developer.chrome.com/docs/extensions/reference/api/devtools |
| Offscreen Document | https://developer.chrome.com/docs/extensions/reference/api/offscreen |
| SW 里用 WebSocket | https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets |

---

## 12. 自测：读完这份你应该能回答

1. 为什么在 content script 里 `window.fetch = xxx` 拦不到页面请求？
2. `world: "MAIN"` 和 `run_at: "document_start"` 分别解决什么问题？少一个会怎样？
3. MAIN world 里为什么不能直接 `chrome.runtime.sendMessage`？数据怎么传出来？
4. Service Worker 里能不能用全局变量存 mock 规则？为什么？
5. `declarativeNetRequest` 为什么不能作为我们的主路线？
6. content script 的 `console.log` 在哪看？
7. 我们的「虚拟接口」为什么不会触发 CORS 预检失败？

> 答不上来的题回去看对应章节。**第 1、2、4 题答不上来，先别开始写代码。**
