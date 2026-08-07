# MCP Server

> 更新：2026-08-07
> 状态：**✅ 已完成**（18 项 e2e 全通）
> 相关：[02 号文档 §2.2](./02-需求补充：AI协同与虚拟接口.md)（L2 方案与安全清单）· [09 §4](./09-项目状态与交接.md)（A1–A4 架构预留）

这是这个项目最初的立项理由之一，也是它跟所有竞品拉开距离的地方。

---

## 1. 它解决什么

现有的 mock 工具全是 GUI —— **AI 看不见里面发生了什么**。
你让 AI 写完前端代码，打开页面没数据，接下来只能你自己去翻 Network 面板、
手抄 URL、手写 mock JSON，再回来告诉 AI「好了」。

接上 MCP 之后：

```
你：页面没数据，帮我 mock 一下

AI  → list_recent_requests(only_unmocked: true)
      看到 GET /api/goods/list 返回 404
    → get_request_detail
      确认前端在传 page / size / keyword
    → create_mock(kind: "virtual", body_type: "mockjs", ...)

你：刷新页面 → 有数据了
```

**你只说了一句话。** 没有手抄 URL，没有写 JSON，AI 也没有猜接口长什么样。

写侧（生成 mock 规则）AI 本来就会做，剪贴板导入也能凑合。
**真正没有替代品的是读侧** —— 让 AI 看到页面实际发了哪些请求。

---

## 2. 架构

```
  Claude Code / Cursor
        ↕  stdio（MCP 协议）
  mock-studio-mcp（Node 进程）      ← 同时是 WebSocket server
        ↕  WebSocket（127.0.0.1）
  Chrome 扩展 Service Worker（WS client）
        ↕  chrome.runtime
  注入层
```

**为什么是插件连服务端，不是反过来**：扩展里起不了 server。

**为什么 Node 侧能直接复用业务逻辑**：`mcp-server/tsconfig.json` 的 `rootDir` 指向上级目录，
直接编译 `../src/core` 的源码 —— 不走 npm 包依赖。这是 **A1（core 层零 chrome 依赖）
当年留的口子在兑现**。如果规则的增删改查逻辑写在 React 组件里，这里就得整个重写一遍。

**为什么写侧只有一条 `DISPATCH` 消息**：扩展里所有状态变更本来就只有
`dispatch(command)` 一个入口（**A3**）。MCP 的每个写工具在 Node 侧翻译成 Command 就行，
桥不需要为每个工具设计一条消息。校验、副作用、广播全在那一条路上，这边不重复实现。

| 文件 | 职责 |
| --- | --- |
| [`src/shared/bridge.ts`](../src/shared/bridge.ts) | 桥协议。**用相对导入**，两端都能直接 import |
| [`src/core/mcp/redact.ts`](../src/core/mcp/redact.ts) | 强制脱敏 + 域名白名单，纯函数 |
| [`src/hosts/background/mcpBridge.ts`](../src/hosts/background/mcpBridge.ts) | 扩展侧 WS client：握手、重连、心跳、翻译请求 |
| [`mcp-server/src/bridge.ts`](../mcp-server/src/bridge.ts) | WS server：三道安全校验、请求应答配对 |
| [`mcp-server/src/tools.ts`](../mcp-server/src/tools.ts) | 11 个 MCP 工具 |
| [`mcp-server/e2e.mjs`](../mcp-server/e2e.mjs) | 端到端冒烟，跑的是编译产物 |

---

## 3. 安全

localhost 上开一个端口，意味着**本机任何进程、以及任何网页里的 JS 都能尝试连它**。
三道校验缺一不可：

| # | 校验 | 挡住谁 |
| --- | --- | --- |
| 1 | 只监听 `127.0.0.1`（不是 `0.0.0.0`） | 局域网里的其他机器 |
| 2 | `Origin` 必须是 `chrome-extension://` | **所有网页** —— 网页发起的 WS 一定带自己的 http(s) Origin，且浏览器不允许 JS 伪造这个头 |
| 3 | 配对码（等长比较） | 本机上的其他进程（它们能随便伪造 Origin） |

任何一道没过都**带原因关闭**，不静默断开 —— 静默失败会让用户完全无从排查。
e2e 里第 2、3 道都有对应的用例钉着。

### 脱敏是不可关的那道线

```
扩展侧脱敏  →  出到 WS  →  MCP Server  →  AI
   ↑ 在这里
```

脱敏放在**扩展侧**而不是 MCP 侧：万一 WS 端口被别的进程连上，它拿到的也已经是脱敏过的。
**防线要设在数据离开之前。**

打码范围：`Authorization` / `Cookie` / `token` / `password` / `secret` / `signature` 等
键名（大小写、下划线、连字符、业务前缀都能命中），以及**看起来像凭证的值**
（JWT、32 位以上的十六进制串）—— 键名正常但值是 token 的情况同样打掉。
URL 查询参数和响应体都过一遍；非 JSON 文本也有兜底，不会因为「不是 JSON」就整段放行。

出给 AI 的每条记录带 `redacted` 标记，**让 AI 知道自己看到的不是全貌** ——
否则它可能基于「这个字段是空的」做出错误推断。

> **实现时踩到的真洞**：第一版 `key: value` 只打掉冒号后的**第一个词**，
> 于是 `Authorization: Bearer eyJhbGci...` 打掉的是 "Bearer" 这个毫无价值的单词，
> 真 token 原样漏出去。现在改成「敏感键打掉整行剩余部分」，并留了回归用例。
> 这是最常见的 auth header 形态 —— 安全代码的测试要按安全代码的标准写。

### 两处偏离 02 号文档，及理由

**端口不随机化**（02 §2.3 原写随机化）。随机端口扩展就发现不了，除非再造一套端口协商，
那反而多一个攻击面。**端口扫描是零成本的，靠端口猜不到来防守本来就是错觉** ——
安全靠配对码 + Origin 校验。

**白名单为空 = 不限**（02 §4.1 原写「白名单不可关」）。两个理由：
① 产品里已有「域名作用域」概念（项目的 hostScope），那里空数组就是不限 ——
同一个概念两套语义用户一定搞混，而**搞混安全设置比没有安全设置更糟**；
② 「不可关的白名单」在初始状态无解，默认放行等于没开、默认全禁则功能开箱即坏。
补偿：白名单为空且读侧开着时，设置页给显著警告。**真正不可关的那道线是脱敏，不是白名单。**

---

## 4. 怎么用

### 一次性设置

```bash
cd mcp-server && npm install && npm run build
```

扩展设置页（Options 右上角 **MCP** 按钮）→ 打开「启用 MCP 桥」→ 会自动生成配对码
→ 点「复制整段」拿到可直接粘贴的客户端配置：

```json
{
  "mcpServers": {
    "mock-studio": {
      "command": "node",
      "args": ["<绝对路径>/chrome-mock-extension/mcp-server/dist/mcp-server/src/index.js"],
      "env": { "MOCK_STUDIO_TOKEN": "……", "MOCK_STUDIO_PORT": "8787" }
    }
  }
}
```

粘进 Claude Code 的 `.mcp.json`（或 Cursor 的 MCP 配置），把 `<绝对路径>` 换成真实路径。

设置页里有实时连接状态，连上会显示「● 已连接」。

### 工具集

**读侧**（`readOnlyHint`）

| 工具 | 用途 |
| --- | --- |
| `list_recent_requests` | 页面最近发了什么。`only_unmocked: true` 直接回答「缺哪个 mock」 |
| `get_request_detail` | 某条请求的完整响应体，用来对齐真实数据结构 |
| `list_rules` | 现有规则与变体 |
| `list_shell_templates` | 可用的响应外壳 |
| `get_status` | 总开关、生效规则数、读侧是否可用 |

**写侧**

| 工具 | 用途 |
| --- | --- |
| `create_mock` | 新建规则。支持 `static` / `mockjs` / `dynamic` 三种 body |
| `update_mock` | 改当前生效变体的响应 |
| `toggle_mock` | 临时停用 |
| `delete_mock` | 删除（标了 `destructiveHint`） |
| `set_active_variant` | 切换变体 —— 测空态、测报错靠它 |
| `set_global_enabled` | 总开关（关掉时会提醒有几个虚拟接口会真的 404）|

工具描述里刻意写了**什么时候不该用它**（比如 `update_mock` 会说明它不新建变体、
想保留原数据应该另建），AI 靠这些描述做判断，写清楚比写全更重要。

---

## 5. 已知限制

| 限制 | 说明 |
| --- | --- |
| 规则改动不影响已发出的请求 | 每个写工具的返回都提醒「让用户刷新页面」。这是拦截式方案的固有特性，不是 bug |
| 请求流是环形缓冲 | 默认 200 条，早的会被挤掉。`get_request_detail` 找不到 id 时会明说 |
| 只有单个扩展连接 | 后连的会顶掉先连的。多浏览器 profile 同时用要换端口 |
| 不推送请求流 | 刻意的：推的话每个页面请求都要过一次 WS，而 AI 只在被问到时才需要看。拉模式还顺带避免了「AI 没在看时也在传敏感数据」 |
| MCP 客户端可能留下僵尸进程 | 表现为下次启动 `EADDRINUSE`。错误信息里已经写了怎么办；`pkill -f mcp-server/dist` 可清 |

---

## 6. 验证

```bash
cd mcp-server && npm run e2e
```

用一个**假扩展**（带正确 Origin 和配对码的 WS client）冒充 Chrome 侧，
不用真开浏览器就能验证整条链路。18 项覆盖：工具集完整性、未连接时的报错可操作性、
错误配对码被拒、网页 Origin 被拒、读侧四个工具、写侧闭环（含「落到扩展的确实是一条
`CREATE_RULE` 命令」这条对 A3 的断言）。

> 这个脚本自己先把自己坑过一次：第一版断言失败时直接 `process.exit(1)`，
> 子进程没被杀，端口一直占着，下一次跑报的是个跟本次改动无关的错。
> 正好说明 `EADDRINUSE` 那条提示是有必要的。

**还没做**：真实浏览器里的端到端（装扩展 → 开桥 → 在真页面上跑一轮）。
假扩展验证的是协议和安全，验证不了 Chrome 的 WebSocket 行为、SW 生命周期、
以及 `chrome.alarms` 兜底重连是否真的管用。见 09 §7 技术债。
