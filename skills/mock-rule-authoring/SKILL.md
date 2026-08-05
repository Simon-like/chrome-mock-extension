---
name: mock-rule-authoring
description: 为 Mock Studio 浏览器扩展生成 mock 规则 JSON。当用户说「帮我 mock 一个接口」「造一个列表接口的假数据」「把这个接口改成返回空数据/报错」时使用。生成的 JSON 由用户在扩展里「从剪贴板导入」。
---

# 生成 Mock Studio 规则

## 工作流程

1. 弄清用户要哪一种（这决定 `kind` 字段）：
   - **接口已存在，只改返回** → `kind: "override"`
   - **后端还没这个接口，凭空造** → `kind: "virtual"`
   - 不确定时问一句，别猜

2. 生成规则 JSON（格式见下），**输出到代码块里**

3. 告诉用户：复制这段 JSON → 扩展的规则管理页 → 点「从剪贴板导入」

## 输出格式

可以输出单条规则对象、规则数组，或完整 store 对象，扩展三种都支持。**优先输出单条或数组**，更简洁。

```json
{
  "name": "商品列表",
  "enabled": true,
  "groupId": null,
  "kind": "virtual",
  "match": {
    "urlMode": "contains",
    "url": "/api/goods/list",
    "methods": ["GET"],
    "hosts": []
  },
  "response": {
    "status": 200,
    "headers": {},
    "bodyType": "static",
    "body": "{\n  \"list\": [],\n  \"total\": 0\n}",
    "shellTemplateId": null,
    "delayMs": 0
  }
}
```

## 字段规则（务必遵守）

| 字段 | 说明 |
| --- | --- |
| `id` / `meta` | **不要生成**。由扩展自动补全 |
| `body` | **必须是字符串**，不是对象。JSON 内容需要转义。这样做是为了不丢大整数精度、支持非 JSON 内容 |
| `match.urlMode` | `contains`（推荐，最稳）/ `wildcard`（`*` 通配）/ `regex` |
| `match.url` | **只写 path，不要带 query**。带了 `?page=1` 的话用户翻页规则就失效了 |
| `match.methods` | 空数组 `[]` = 匹配所有方法 |
| `match.hosts` | 空数组 `[]` = 所有域名。不确定就留空 |
| `shellTemplateId` | 见下方「响应外壳」 |
| `delayMs` | 模拟慢网络，默认 0 |
| `bodyType` | 目前只支持 `"static"` |

## 响应外壳

用户公司的响应格式不统一。两种做法：

- **默认**：`shellTemplateId: null`，把完整响应写进 `body`
- **套壳**：`shellTemplateId` 填模板 id，`body` 只写业务数据部分

内置模板 id：

| id | 格式 |
| --- | --- |
| `shell-raw` | `__DATA__`（裸数据） |
| `shell-status-message-data` | `{"status":0,"message":"ok","data":__DATA__}` |
| `shell-code-data-message` | `{"code":0,"data":__DATA__,"message":"success"}` |
| `shell-success-result` | `{"success":true,"result":__DATA__}` |
| `shell-errno-errmsg` | `{"errno":0,"errmsg":"","data":__DATA__}` |

不确定用户用哪种壳时，**用 `null` 并把完整结构写进 body** —— 比猜错壳更安全。

## 假数据要写得像真的

- 中文场景用中文内容，不要 `foo` / `bar` / `test123`
- 列表默认 10 条左右，不要只给 1 条（看不出分页和滚动问题）
- id 用连续或有规律的值，时间戳用近期的真实时间
- 字段名跟着用户给的接口文档或前端代码走，**不要自己发明**

## 常见场景

**分页列表**（虚拟接口）
```json
{
  "name": "商品列表",
  "enabled": true, "groupId": null, "kind": "virtual",
  "match": { "urlMode": "contains", "url": "/api/goods/list", "methods": ["GET"], "hosts": [] },
  "response": {
    "status": 200, "headers": {}, "bodyType": "static", "shellTemplateId": null, "delayMs": 0,
    "body": "{\"list\":[{\"id\":1001,\"name\":\"深空灰保温杯\",\"price\":89.9,\"stock\":234},{\"id\":1002,\"name\":\"折叠雨伞\",\"price\":45,\"stock\":0}],\"total\":48,\"page\":1,\"pageSize\":20}"
  }
}
```

**改成空数据**（覆盖已有接口，测空状态）
```json
{
  "name": "商品列表-空数据",
  "enabled": true, "groupId": null, "kind": "override",
  "match": { "urlMode": "contains", "url": "/api/goods/list", "methods": ["GET"], "hosts": [] },
  "response": {
    "status": 200, "headers": {}, "bodyType": "static", "shellTemplateId": null, "delayMs": 0,
    "body": "{\"list\":[],\"total\":0}"
  }
}
```

**模拟报错**
```json
{
  "name": "下单接口-500",
  "enabled": true, "groupId": null, "kind": "override",
  "match": { "urlMode": "contains", "url": "/api/order/create", "methods": ["POST"], "hosts": [] },
  "response": {
    "status": 500, "headers": {}, "bodyType": "static", "shellTemplateId": null, "delayMs": 0,
    "body": "{\"message\":\"库存不足，下单失败\"}"
  }
}
```

## 一次生成多条

用户说「把整个商品模块 mock 掉」这类需求时，输出数组：

```json
[
  { "name": "列表", "...": "..." },
  { "name": "详情", "...": "..." }
]
```

注意顺序 —— **数组顺序即匹配优先级，从上往下第一条命中的生效**。所以把更具体的规则放前面，宽泛的放后面。
