# MCP Server

> 类型：Design / Architecture Reference
> 状态：Implemented
> Owner：项目维护者
> 更新：2026-08-27
> 验证：**✅ 40 项 e2e 全通**
> 相关：[PRD-0001 §2.2](../product/prds/PRD-0001-ai-collaboration-and-virtual-endpoints.md)（L2 方案与安全清单）· [2026-08-07 交接快照 §4](../delivery/snapshots/2026-08-07-project-handoff.md)（A1–A4 架构预留）

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
| [`src/shared/bridge.ts`](../../src/shared/bridge.ts) | 桥协议。**用相对导入**，两端都能直接 import |
| [`src/core/mcp/redact.ts`](../../src/core/mcp/redact.ts) | 强制脱敏 + 域名白名单，纯函数 |
| [`src/hosts/background/mcpBridge.ts`](../../src/hosts/background/mcpBridge.ts) | 扩展侧 WS client：握手、重连、心跳、翻译请求 |
| [`mcp-server/src/bridge.ts`](../../mcp-server/src/bridge.ts) | WS server：三道安全校验、请求应答配对 |
| [`mcp-server/src/tools.ts`](../../mcp-server/src/tools.ts) | 13 个 MCP 工具 + 首轮上下文 + 冲突检测 |
| [`mcp-server/src/prompts.ts`](../../mcp-server/src/prompts.ts) | 3 条 Prompts —— 客户端不认 `instructions` 时的兜底入口 |
| [`mcp-server/e2e.mjs`](../../mcp-server/e2e.mjs) | 端到端冒烟，跑的是编译产物 |

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

打码范围分两路：

| 按什么识别 | 覆盖 |
| --- | --- |
| **键名**（含即命中，大小写/下划线/连字符/业务前缀都算） | `Authorization` `Cookie` `token` `password` `secret` `signature` `session` 等 |
| **值的形状** | JWT、32 位以上十六进制串、**邮箱、手机号、身份证号** |

值识别这一路是拿真实公司接口验出来后补的（见下方「真洞之二」）。
它的好处是不受字段名影响：`"contact": "a@b.com"` 照样抓得到，
而 `isMobile: true` 这种布尔字段完全不受影响 —— 如果把 `mobile` 加进键名表就会误伤它。

URL 查询参数和响应体都过一遍；非 JSON 文本也有兜底，不会因为「不是 JSON」就整段放行。

#### 脱敏拦不住什么

必须写清楚，否则用户会以为「开了脱敏就安全了」：

- **真实姓名、部门、职位** —— `"nick": "王海"` 这类值没有可识别的形状，
  只能靠键名，而键名千变万化。拦不住
- **接口路径本身** —— 内网系统的路径结构可能就是敏感信息
- **业务数据** —— 这正是 AI 需要看到才能生成贴合 mock 的东西，不可能打掉

所以涉密项目应当**关掉读侧**，或用域名白名单只放行测试环境。

出给 AI 的每条记录带 `redacted` 标记，**让 AI 知道自己看到的不是全貌** ——
否则它可能基于「这个字段是空的」做出错误推断。

> **真洞之一（测试抓的）**：第一版 `key: value` 只打掉冒号后的**第一个词**，
> 于是 `Authorization: Bearer eyJhbGci...` 打掉的是 "Bearer" 这个毫无价值的单词，
> 真 token 原样漏出去。现在改成「敏感键打掉整行剩余部分」，并留了回归用例。
> 这是最常见的 auth header 形态 —— 安全代码的测试要按安全代码的标准写。
>
> **真洞之二（真实数据抓的）**：接上真实公司接口后，第一次 `list_recent_requests`
> 就发现登录接口返回的 `email` / `nick` / `orgName` 原样出给了 AI ——
> 第一版只防「凭证类」键名，PII 完全没考虑。现已补上按值识别的邮箱/手机号/身份证。
>
> 两个洞的共同教训：**脱敏这种防线，光靠想是想不全的，必须拿真实数据跑一遍。**
> 单测能证明「我防的那些确实防住了」，证明不了「我没防的那些不重要」。

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
| `get_page_context` | Agent 首次调用：一次获得状态、关键异常/未 Mock 请求、相关规则和下一步建议 |
| `list_recent_requests` | 页面最近发了什么。`only_unmocked: true` 直接回答「缺哪个 mock」 |
| `get_request_detail` | 某条请求的完整响应体，用来对齐真实数据结构 |
| `list_rules` | 现有规则与变体 |
| `list_shell_templates` | 可用的响应外壳 |
| `get_status` | 总开关、生效规则数、读侧是否可用 |

**写侧**

| 工具 | 用途 |
| --- | --- |
| `create_mock` | 新建规则。三种 body 类型、自定义响应头、`behavior`（超时/断网）、**一次建多个变体** |
| `add_variant` | 给已有规则追加一份响应（不覆盖原来的）|
| `update_mock` | 改某个变体的响应（默认改当前生效的）。只覆盖显式传入的字段 |
| `toggle_mock` | 临时停用 |
| `delete_mock` | 删除（标了 `destructiveHint`） |
| `set_active_variant` | 切换变体 —— 测空态、测报错靠它 |
| `set_global_enabled` | 总开关（关掉时会提醒有几个虚拟接口会真的 404）|

工具描述里刻意写了**什么时候不该用它**（比如 `update_mock` 会说明它是覆盖、
想保留原数据该用 `add_variant`），AI 靠这些描述做判断，写清楚比写全更重要。

**工具能表达的东西不能比 UI 少。** 第一版漏了 `headers` 和 `behavior`，
于是「模拟请求超时」「模拟断网」这类最常见的测试场景 AI 根本做不到，
只能让用户自己去点 —— 那 MCP 就白做了一半。

多 Agent、首轮效率和免绝对路径配置的后续取舍见 [MCP v2 架构评审](./mcp-v2-review.md)。

### 冲突检测

AI 建规则时看不到列表，很容易造出「建了但永远不生效」的规则 ——
而这种最难查：它就在那儿、开着、看起来没问题，就是不命中。
所以 `create_mock` 建完立刻回答三个问题：

| 检测 | 提示 |
| --- | --- |
| 新规则被上面某条更宽泛的规则遮蔽 | ⚠️ 指出是被谁挡住的，并说明「列表顺序即优先级」 |
| 新规则会遮蔽已有规则 | ⚠️ 列出哪几条将不再生效 |
| 同一 URL 已有规则 | ⚠️ 建议改用 `update_mock` / `add_variant` |
| 没限定方法或域名 | 💡 提醒生效范围比预期大 |

判定直接复用 core 里 UI 用的那份 `findShadowedRules`，**不重写一套** ——
两套判定迟早会不一致，那比没有检测更糟。无冲突时一句废话都不说。

---

## 5. 已知限制

| 限制 | 说明 |
| --- | --- |
| 规则改动不影响已发出的请求 | 每个写工具的返回都提醒「让用户刷新页面」。这是拦截式方案的固有特性，不是 bug |
| 请求流是环形缓冲 | 默认 200 条，早的会被挤掉。`get_request_detail` 找不到 id 时会明说 |
| 只有单个扩展连接 | 后连的会顶掉先连的（旧连接收到 4004 并显式关闭）。多浏览器 profile 同时用要换端口 |
| 不推送请求流 | 刻意的：推的话每个页面请求都要过一次 WS，而 AI 只在被问到时才需要看。拉模式还顺带避免了「AI 没在看时也在传敏感数据」 |
| MCP 客户端可能留下僵尸进程 | 表现为下次启动 `EADDRINUSE`。错误信息里已经写了怎么办；`pkill -f mcp-server/dist` 可清 |

---

## 5.5 多个 AI 工具怎么共用（Hub / Peer）

MCP Server 是被客户端 spawn 的 stdio 子进程 —— **开几个 AI 工具就有几个进程**，
但扩展只能连一个端口。第一版的结果是第二个进程 `EADDRINUSE` 直接退出，
Claude Code 和 JoyCode 不能同时用。

现在改成**抢端口选举**：

```
  进程 A ── bind(8787) 成功 ──→ HUB ←── WebSocket ── Chrome 扩展
                                 ↑
  进程 B ── bind 失败 ──→ PEER ──┘   把工具调用转发给 Hub
  进程 C ── bind 失败 ──→ PEER ──┘
```

对上层（`tools.ts`）完全透明：`HubBridge` 和 `PeerBridge` 实现同一个 `BridgeTransport`。

**Hub 退出时**（它的 AI 客户端关了）：peer 的连接断开 → 重新参与抢端口 →
谁抢到谁当新 Hub。扩展本来就在退避重连，会自动连到新 Hub 上。
用户什么都不用做。

握手时的 `role` 字段区分两类对端。安全上：
- `extension` 必须带 `chrome-extension://` 的 Origin
- `peer` **不能**带 Origin（带了说明是网页在冒充 peer 绕过 Origin 检查）
- 两者都要过配对码

### 连接生命周期：两个真实的坑

**① 旧连接从不关闭。** 第一版接受新扩展连接时只写了 `this.client = ws`，
没关掉上一条。于是扩展每重连一次就在服务端漏一个 socket，堆成一片半开连接 ——
用户看到的「占用很多端口」就是这么来的。现在新连接会用 `4004 SUPERSEDED`
显式关掉旧的。

**② 心跳只发不验。** 第一版扩展每 20 秒单向发一条消息保活 SW，服务端不回。
问题在于**半开 socket 上 `send()` 只是写进本地缓冲区，不会抛错也不触发 onclose** ——
于是两端都永远显示「已连接」，而对端早就退出了。

现在是双向的：

| 谁 | 做什么 | 超时后 |
| --- | --- | --- |
| Hub | 每 20s 发 `PING`，等 `pong` | 10s 没等到 → `terminate()` 这条连接 |
| 扩展 | 记录最后一次收到消息的时刻 | 60s 没收到任何东西 → 主动断开重连 |

用 `terminate` 而不是 `close`：对端已经不在了，四次挥手等不到回应，
`close` 会让 socket 卡在 CLOSING 直到 TCP 超时 —— 那正是半开连接堆积的来源。

设置页的「已连接」也不再是一旦点亮就不灭的灯，它带上了「距上次通信多久」，
静默超过 45 秒显示「疑似断开，正在重连…」。**状态是算出来的，不是存下来的。**

---

## 6. 验证

```bash
cd mcp-server && npm run e2e
```

用一个**假扩展**（带正确 Origin 和配对码的 WS client）冒充 Chrome 侧，
不用真开浏览器就能验证整条链路。40 项覆盖：工具集完整性、单调用页面上下文、未连接时的报错可操作性、
错误配对码被拒、网页 Origin 被拒、读侧四个工具、写侧闭环（含「落到扩展的确实是一条
`CREATE_RULE` 命令」这条对 A3 的断言）、多变体 / headers / behavior 的传达、四类冲突检测、
**两个 MCP 客户端共用一个扩展**（peer 转发、读写落到同一处）、新扩展连接顶掉旧连接、
以及「让 AI 知道该用这套工具」的三层保险确实送到了客户端（instructions / 工具描述 / prompts）。

假扩展会**真的把新规则存进去**，否则「建完再读一次 state」的冲突检测永远看不到它 ——
测试替身太假就测不出东西。

> 这个脚本自己先把自己坑过一次：第一版断言失败时直接 `process.exit(1)`，
> 子进程没被杀，端口一直占着，下一次跑报的是个跟本次改动无关的错。
> 正好说明 `EADDRINUSE` 那条提示是有必要的。

### 真实浏览器验证 ✅ 2026-08-07

真实 Chrome 扩展成功连上桥，`get_status` / `list_recent_requests` 都拿到了真实数据。
Chrome 的 WebSocket 行为、Origin 头、配对码校验、SW 应答，全部走通。

**仍未验**：SW 被回收后 `chrome.alarms` 兜底重连 —— 得等浏览器真的回收它才看得到，
没法主动触发。

这次真实验证的直接产出就是「真洞之二」：假扩展喂的是我自己造的干净数据，
永远不会暴露 PII 这个盲区。**假数据测不出你没想到的东西。**
