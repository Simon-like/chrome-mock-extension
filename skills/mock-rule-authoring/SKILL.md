---
name: mock-rule-authoring
description: 为 Mock Studio 浏览器扩展生成 mock 规则 JSON。当用户说「帮我 mock 一个接口」「造一个列表接口的假数据」「把这个接口改成返回空数据/报错」「给这个接口加几种状态」时使用。生成的 JSON 由用户在扩展里「剪贴板导入」。
---

# 生成 Mock Studio 规则

> 对应 Schema v2。核心变化：一条规则持有**多个变体**，同一时刻生效一个。

## ⚠️ 先检查有没有 MCP

**如果当前会话里有 `mock-studio` 这组 MCP 工具**（`list_recent_requests`、
`create_mock` 等），**优先用它们，不要用本 Skill 生成 JSON**。

原因：MCP 能直接看到页面**实际发出的请求**，并把规则直接写进扩展 ——
不用用户手抄 URL，也不用复制粘贴。本 Skill 是没有 MCP 时的降级路径。

有 MCP 时的正确姿势：

```
list_recent_requests(only_unmocked: true)   ← 先看页面缺什么，别问用户要 URL
get_request_detail(id)                       ← 要对齐真实数据结构时
create_mock(...)                             ← 直接写进去
```

接入方式见 `docs/12-MCP-Server.md`。以下内容仅在**没有** MCP 时适用。

## 工作流程

1. 弄清两件事：
   - **接口存不存在**？决定 `kind`
     - 已存在，只改返回 → `"override"`
     - 后端还没做，凭空造 → `"virtual"`
     - 不确定就问一句，别猜
   - **要不要多个变体**？用户提到「正常/空/报错」「几种状态」「切换」就是要
2. 生成规则 JSON，输出到代码块里
3. 告诉用户：复制 → 扩展的规则管理页 → 点「剪贴板导入」

## 输出格式

可以输出单条规则、规则数组，或完整 store，扩展三种都支持。**优先单条或数组**。

```json
{
  "name": "商品列表",
  "enabled": true,
  "kind": "virtual",
  "projectId": null,
  "groupId": null,
  "match": {
    "urlMode": "contains",
    "url": "/api/goods/list",
    "methods": ["GET"],
    "hosts": []
  },
  "variants": [
    {
      "name": "正常",
      "response": {
        "status": 200,
        "headers": {},
        "bodyType": "static",
        "body": "{\n  \"list\": [],\n  \"total\": 0\n}",
        "shellTemplateId": null,
        "delayMs": 0
      }
    }
  ]
}
```

## 变体 —— 最重要的概念

**一条规则可以有多份响应，同一时刻只生效一个。** 用户在规则行上点一下就能切换，
不用改 body、也不用复制出多条规则。

```
规则「商品列表」  /api/goods/list
  ├── 正常      20 条数据      ← variants[0]，默认生效
  ├── 空数据    list: []
  ├── 报错      500
  └── 超长列表  200 条
```

**什么时候该生成多个变体**：

| 用户说 | 生成 |
| --- | --- |
| 「mock 一个商品列表」 | 1 个变体够了 |
| 「帮我造几种状态」「正常和空的都要」 | 多个变体 |
| 「测一下空状态 / 报错」且接口已有规则 | 多个变体，把「正常」放第一个 |
| 「加个超时的情况」 | 加变体，`behavior: "timeout"` |

**顺序有讲究**：`variants[0]` 是默认生效的那个，也是 UI 里「未被切走」的基准 ——
切到其他变体时规则行会高亮橙色提醒。所以**把最常用的那份放第一个**（通常是「正常」）。

`activeVariantIndex` 可选，缺省为 0。

## 字段规则（务必遵守）

| 字段 | 说明 |
| --- | --- |
| `id` / `meta` / 变体的 `id` | **不要生成**，由扩展自动补 |
| `body` | **必须是字符串**，不是对象。JSON 内容要转义。这样做是为了不丢大整数精度、支持非 JSON 内容 |
| `variants` | **至少一个**。空数组会被扩展补上一个默认变体 |
| `match.urlMode` | `contains`（推荐，最稳）/ `wildcard`（`*` 通配）/ `regex` |
| `match.url` | **只写 path，不要带 query**。带了 `?page=1` 用户翻页规则就失效了 |
| `match.methods` | 空数组 `[]` = 匹配所有方法 |
| `match.hosts` | 空数组 = 不限。**规则挂在项目下时留空** —— 项目已经绑定域名了 |
| `projectId` / `groupId` | 不知道就填 `null`，用户可以在界面上拖进去 |
| `bodyType` | `"static"`（body 是 JSON）/ `"mockjs"`（body 是数据模板）/ `"dynamic"`（body 是 JS 源码）。三者见下 |
| `delayMs` | 模拟慢网络，默认 0 |
| `behavior` | `"normal"`（默认）/ `"timeout"`（请求挂起）/ `"networkError"`（网络错误） |

## 三种响应体怎么选

| 需求 | bodyType |
| --- | --- |
| 数据固定不变 | `static` —— **默认选它**，可读性最好 |
| 要一批看起来像真的数据（列表、假名字假价格） | `mockjs` |
| 几份固定数据来回切 | 还是 `static`，但建**多个变体** |
| 响应要随请求参数变（翻页、查详情、搜索） | `dynamic` |

不确定时选 `static`。用户看得懂的固定 JSON，比一个要读两遍才明白的模板有用。

## Mock 模板（`bodyType: "mockjs"`）

`body` 存一份**带规则的 JSON 字符串**：

```json
{
  "status": 200, "headers": {}, "bodyType": "mockjs",
  "shellTemplateId": null, "delayMs": 0,
  "body": "{\"list|10\":[{\"id|+1\":1001,\"name\":\"@ctitle(2,4)\",\"price|10-999.2\":1,\"status\":\"@pick(待付款,已发货,已完成)\"}],\"total|40-60\":1}"
}
```

键上的规则：

| 写法 | 效果 |
| --- | --- |
| `"list\|10"` + 数组值 | 重复 10 次 |
| `"list\|1-5"` + 数组值 | 重复随机 1~5 次 |
| `"id\|+1"` + 数字值 | 逐项递增（首项用写的初值） |
| `"age\|18-60"` + 数字值 | 范围内随机整数 |
| `"price\|10-99.2"` + 数字值 | 范围内随机浮点，2 位小数 |
| `"ok\|1"` + 布尔值 | 随机真假 |

常用占位符：`@cname` `@ctitle(n,m)` `@cword` `@city` `@province` ·
`@name` `@title` `@word` · `@natural(min,max)` `@integer` `@float` `@id` `@guid` `@increment` ·
`@email` `@url` `@ip` `@phone` · `@date` `@datetime` `@now` `@timestamp` ·
`@boolean` `@color` `@string` · `@pick(a,b,c)` `@range(a,b)`

注意：

- **模板必须是合法 JSON**（记得转义引号）
- 整个值就是一个占位符时**保留原始类型**：`"id": "@natural"` 得到数字，不是字符串
- **枚举字段用 `@pick`**，别用 `@string`
- 单数组上限 1000 项；没实现正则生成、函数模板、`Mock.Random.extend`
- 完整语法见 `docs/11-Mock模板语法.md`

## 动态响应（`bodyType: "dynamic"`）

需要「响应随请求参数变化」时用 —— 翻页、按 id 查详情、搜索。
此时 `body` 存的是**一段 JS 源码字符串**，不是 JSON：

```json
{
  "status": 200, "headers": {}, "bodyType": "dynamic",
  "shellTemplateId": null, "delayMs": 0,
  "body": "(req) => ({ list: Array.from({ length: Number(req.query.size) || 10 }, (_, i) => ({ id: (Number(req.query.page) - 1) * 10 + i + 1 })), total: 48 })"
}
```

写的时候注意：

| 事项 | 说明 |
| --- | --- |
| 两种写法都行 | `(req) => ({...})` 表达式，或直接 `return {...};` 函数体 |
| `req` 有什么 | `url` · `method` · `host` · `path` · `query` |
| `query` 的值是**字符串** | URL 里没有类型。要算数就 `Number(req.query.page)` |
| 不能返回 Promise | XHR 的 `send()` 是同步的，等不了异步结果 |
| 不能用 `fetch` / `setTimeout` 等异步 | 同上。要延迟用 `delayMs` 字段 |
| 保持简短 | 每个匹配到的请求都会执行一次，超过 50ms 会被标记为「偏慢」 |

**什么时候【不要】用动态**：数据固定不变时用 `static`，可读性好得多。
「几份固定数据来回切」用**变体**，不要用 `if` 在动态代码里分支。

## 响应外壳

用户公司的响应格式不统一。三种做法：

- **默认**：`shellTemplateId: null`，把完整响应写进 `body`
- **套壳**：填模板 id，`body` 只写业务数据部分
- **继承**：填 `null` 时，扩展会自动回落到分组 → 项目的默认外壳

内置模板 id：

| id | 格式 |
| --- | --- |
| `shell-raw` | `__DATA__`（裸数据） |
| `shell-status-message-data` | `{"status":0,"message":"ok","data":__DATA__}` |
| `shell-code-data-message` | `{"code":0,"data":__DATA__,"message":"success"}` |
| `shell-success-result` | `{"success":true,"result":__DATA__}` |
| `shell-errno-errmsg` | `{"errno":0,"errmsg":"","data":__DATA__}` |

不确定时**用 `null` 并把完整结构写进 body** —— 比猜错壳安全。

## 假数据要写得像真的

- 中文场景用中文内容，不要 `foo` / `bar` / `test123`
- 列表默认 10 条左右，不要只给 1 条（看不出分页和滚动问题）
- id 用连续或有规律的值，时间戳用近期的真实时间
- 字段名跟着用户给的接口文档或前端代码走，**不要自己发明**
- 生成「空数据」变体时，**保持和正常变体一样的结构**，只把数组清空、数字归零 ——
  直接给 `{}` 会让前端解构报错

## 常见场景

**带多个变体的列表接口**（最典型的用法）

```json
{
  "name": "商品列表",
  "enabled": true,
  "kind": "virtual",
  "projectId": null,
  "groupId": null,
  "match": { "urlMode": "contains", "url": "/api/goods/list", "methods": ["GET"], "hosts": [] },
  "variants": [
    {
      "name": "正常",
      "response": {
        "status": 200, "headers": {}, "bodyType": "static",
        "shellTemplateId": null, "delayMs": 0,
        "body": "{\"list\":[{\"id\":1001,\"name\":\"深空灰保温杯\",\"price\":89.9,\"stock\":234},{\"id\":1002,\"name\":\"折叠雨伞\",\"price\":45,\"stock\":0}],\"total\":48,\"page\":1,\"pageSize\":20}"
      }
    },
    {
      "name": "空数据",
      "response": {
        "status": 200, "headers": {}, "bodyType": "static",
        "shellTemplateId": null, "delayMs": 0,
        "body": "{\"list\":[],\"total\":0,\"page\":1,\"pageSize\":20}"
      }
    },
    {
      "name": "报错",
      "response": {
        "status": 500, "headers": {}, "bodyType": "static",
        "shellTemplateId": null, "delayMs": 0,
        "body": "{\"message\":\"服务暂时不可用\"}"
      }
    },
    {
      "name": "慢 3 秒",
      "response": {
        "status": 200, "headers": {}, "bodyType": "static",
        "shellTemplateId": null, "delayMs": 3000,
        "body": "{\"list\":[],\"total\":0}"
      }
    }
  ]
}
```

**单变体 · 覆盖已有接口**

```json
{
  "name": "下单接口-库存不足",
  "enabled": true,
  "kind": "override",
  "projectId": null,
  "groupId": null,
  "match": { "urlMode": "contains", "url": "/api/order/create", "methods": ["POST"], "hosts": [] },
  "variants": [
    {
      "name": "库存不足",
      "response": {
        "status": 500, "headers": {}, "bodyType": "static",
        "shellTemplateId": null, "delayMs": 0,
        "body": "{\"message\":\"库存不足，下单失败\"}"
      }
    }
  ]
}
```

**超时**（用 behavior，不是超大 delayMs）

```json
{
  "name": "超时",
  "response": {
    "status": 200, "headers": {}, "bodyType": "static",
    "shellTemplateId": null, "delayMs": 0,
    "behavior": "timeout",
    "body": "{}"
  }
}
```

## 一次生成多条

「把整个商品模块 mock 掉」这类需求，输出数组：

```json
[
  { "name": "商品列表", "...": "..." },
  { "name": "商品详情", "...": "..." }
]
```

**数组顺序即匹配优先级，从上往下第一条命中的生效。** 所以把更具体的规则放前面、
宽泛的放后面。比如 `/api/goods/detail` 要排在 `/api/goods` 前面，
否则永远命中不到 —— 扩展界面会提示「被上方规则遮蔽」。

## 容错说明

扩展的导入流程有结构自愈，以下写法虽然不标准但能被接受：

- 用 `response` 而不是 `variants` → 自动包成单个「默认」变体
- `body` 写成了对象 → 自动 `JSON.stringify` 转成字符串
- 缺 `enabled` / `headers` / `delayMs` 等字段 → 用默认值补齐

但**不要依赖这些**，按标准格式生成更可靠。
