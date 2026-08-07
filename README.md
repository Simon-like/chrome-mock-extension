<div align="center">

# Mock Studio

**AI 可编程的本地 Mock 运行时**

在浏览器里拦截并伪造接口响应 —— 不写代码、不改项目、不用登录

[快速开始](#快速开始) · [核心用法](#核心用法) · [架构](#架构) · [文档](#文档)

</div>

---

## 这是什么

一个 Chrome 扩展，让前端在开发时可以随手把任意接口的返回改掉，或者凭空造一个后端还没做的接口。

它想解决两件很具体的烦心事：

**Mock 数据不该进业务代码。** 让 AI 或自己在项目里写 mock，要加 `if/else`、要记得删、容易误提交，切换真假数据还得改代码重启。

**配 Mock 不该那么麻烦。** 大多数 mock 平台和插件的默认路径是「新建规则 → 手抄 URL → 手写整个 JSON」。但前端 90% 的真实需求其实是：*这个接口已经通了，我只想把 `data.list` 改成空数组看看空状态。*

所以 Mock Studio 的主路径反过来：**从你眼前这个真实请求开始**。

---

## 它和别的 Mock 工具有什么不同

| | 常见做法 | Mock Studio |
| --- | --- | --- |
| **起步方式** | 空白表单，手填 URL 和 JSON | DevTools 里点一下真实请求，响应自动填好 |
| **数据归属** | 要登录、规则存云端 | 全部本地，永不上传，共享靠导出 JSON |
| **新增接口** | 多数只能改已有接口 | 支持凭空造接口（后端还没写也能开工） |
| **AI 协作** | 只有给人点的 GUI，AI 看不见里面发生了什么 | **MCP Server**：AI 直接看页面实际发了哪些请求、直接写规则 |
| **响应格式** | 全局配一次 | 模板库 + 规则级选择，还能从真实响应自动识别 |

---

## 快速开始

```bash
git clone git@github.com:Simon-like/chrome-mock-extension.git
cd chrome-mock-extension
npm install
npm run build
```

装进 Chrome：

1. 打开 `chrome://extensions`
2. 开启右上角 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择 **`dist/`** 目录 ← 注意是 `dist/`，不是项目根目录
4. **刷新你要调试的页面** —— 拦截脚本只在页面加载时注入

想确认装好没有：用浏览器打开项目里的 `testbed/index.html`，点「检查引擎」。

> **要求 Chrome 116+**（`world: "MAIN"` 与 WebSocket 保活所需）

---

## 核心用法

### 从真实请求创建 Mock

这是最省事的路径，也是这个工具的主张所在。

```
F12 → Mock 面板 → 看到实时请求流
  → 找到目标请求，点「转为 Mock」
  → 真实响应已经填在右侧编辑器里了
  → 改几个字段，或点「空数据 / 500 / 401 / 慢 3 秒」预设
  → 保存 → 刷新页面 → 生效
```

匹配条件默认只取 URL 的 **path 部分**，丢掉 `?page=1&t=169...`。
这样翻页、带时间戳防缓存的接口都能持续命中 —— 符合绝大多数场景的意图。

### 新建虚拟接口（后端还没做）

点扩展图标 → 「管理规则」 → 「+ 新建规则」 → 类型选 **「新建虚拟接口」**。

因为拦截发生在 `fetch` / `XHR` **被调用的那一刻**，真实请求从未发出，所以：

- 不会 404
- 不触发 CORS 预检
- 后端接口不存在、甚至域名解析不了都没关系

> 虚拟接口在列表里有橙色 **虚拟** 标记。**停用它页面请求会真的失败**，
> 而覆盖式规则停用只是回到真实数据 —— 风险不同，所以要显著区分。

### 让 AI 帮你写规则

项目自带一个 Claude Code Skill，装好之后可以直接用自然语言让 AI 生成规则。

#### 1. 安装 Skill

复制到 Claude Code 的 skills 目录，任选一种：

```bash
# 全局可用（所有项目）
mkdir -p ~/.claude/skills && cp -r skills/mock-rule-authoring ~/.claude/skills/
```

```bash
# 只在某个项目里可用 —— 在你的前端项目根目录执行
mkdir -p .claude/skills && cp -r ~/path/to/chrome-mock-extension/skills/mock-rule-authoring .claude/skills/
```

装好后在 Claude Code 里输入 `/mock-rule-authoring` 应该能看到它。
也可以不打斜杠命令 —— 说到「帮我 mock 一个接口」时它会自动触发。

#### 2. 用自然语言描述

```
帮我 mock 一个商品列表接口 /api/goods/list，10 条数据带分页
```

```
给 /api/order/detail 加三种状态：正常、订单不存在、服务端报错
```

```
我要测空状态和加载态，帮 /api/message/list 造两个变体
```

把接口文档或前端的 TypeScript 类型直接贴给它，生成的字段会更贴合：

```
按这个类型给我造 10 条假数据：
interface Goods { id: number; name: string; price: number; stock: number }
```

#### 3. 导入

AI 会输出一段 JSON。复制它，然后在扩展的**规则管理页**点 **「剪贴板导入」**。

> Skill 里写了完整的 Schema 约定，包括什么时候该生成多个变体、
> `variants[0]` 为什么要放最常用的那份、空数据变体为什么要保持和正常变体
> 一样的结构。详见 [`SKILL.md`](./skills/mock-rule-authoring/SKILL.md)。

#### 导入的容错

Skill 生成的 JSON 会经过结构自愈，以下非标准写法也能被接受：

| AI 可能写成 | 自动处理 |
| --- | --- |
| `response` 而不是 `variants` | 包成单个「默认」变体 |
| `body` 写成对象 | 转成字符串 |
| 缺 `enabled` / `headers` / `delayMs` | 用默认值补齐 |

所以即使 AI 记错了格式，多半也能导进去。

### 让 AI 直接操作（MCP）

上面那套要你复制 JSON、点导入。**接上 MCP 之后这些都不用了。**

```
你：页面没数据，帮我 mock 一下

AI  → list_recent_requests(only_unmocked: true)
      看到 GET /api/goods/list 返回 404
    → get_request_detail
      确认前端在传 page / size / keyword
    → create_mock(kind: "virtual", body_type: "mockjs", ...)

你：刷新页面 → 有数据了
```

你只说了一句话。没有手抄 URL，没有写 JSON，AI 也没有猜接口长什么样。

**读侧才是关键**。写规则 AI 本来就会，剪贴板导入也能凑合；
真正没有替代品的是**让 AI 看到页面实际发了哪些请求** —— 这是 GUI 工具给不了的。

```bash
cd mcp-server && npm install && npm run build
```

然后在规则管理页点右上角 **MCP** → 开启 → 复制那段客户端配置，粘进 Claude Code 的
`.mcp.json`。配对码会自动生成。

> **安全**：只监听 `127.0.0.1`；`Origin` 必须是 `chrome-extension://`（挡掉所有网页）；
> 配对码挡掉本机其他进程。出给 AI 的数据**强制脱敏且不可关闭** ——
> token / cookie / 密码等一律打码，脱敏发生在**扩展侧**（数据离开之前），
> 所以就算端口被别的进程连上，拿到的也已经是打过码的。
>
> 完整说明见 [12 MCP Server](./docs/12-MCP-Server.md)。

---

## 功能

**规则与匹配**

- 三种 URL 匹配模式：包含 / 通配符 / 正则，可叠加 Method 过滤
- 列表顺序即优先级（先到先得），支持上下调整
- 覆盖已有接口 / 新建虚拟接口两种类型
- 单条开关 + 全局总开关 + `Alt+M` 快捷键

**变体 —— 同一接口的多份响应**

一条规则可以有多份响应，规则行上点一下就切换，不用改 body 也不用复制规则：

```
商品列表  /api/goods/list
  ├── ● 正常      20 条数据
  ├── ○ 空数据    list: []
  ├── ○ 报错      500
  └── ○ 超长列表  200 条
```

切到非默认变体时徽标会变橙色 —— 扫一眼列表就知道哪些接口被切走了。

**项目与分组**

- **项目**：按系统划分，**绑定域名**（白/黑名单，支持 `*.jdpay.com` 通配）
- **分组**：业务模块归拢，可折叠；组头的开关批量启用/停用组内规则，三态显示
- 两层都可选 —— 不建项目也能直接用
- 归组支持拖拽和下拉；点「选择」进入选择态后可批量删除/启停/移动

> 控件语义全项目统一：**☑ 复选框 = 选中这一行，●— 开关 = 它开着**。
> 两种形态不混用，所以选择态下启停开关照样能点。

**响应构造**

- 自定义状态码、响应头、响应体
- **动态响应**：写一段 JS，按请求参数现算 —— 翻页、按 id 查详情、搜索终于能测了

  ```js
  (req) => ({
    list: Array.from({ length: Number(req.query.size) || 10 }, (_, i) => ({
      id: (Number(req.query.page) - 1) * 10 + i + 1,
    })),
    total: 48,
  })
  ```

- **Mock 模板**：一行造一批看起来像真的数据

  ```json
  { "list|10": [{ "id|+1": 1001, "name": "@ctitle", "price|10-999.2": 1 }] }
  ```

  自研子集，没引 Mock.js —— 注入脚本每个页面都加载，Mock.js 要 20KB（gzip），
  这份只要 6KB。而且**模板不需要 eval**，CSP 禁了 `unsafe-eval` 的站点上
  动态 JS 用不了、模板还能用。语法见 [11 Mock 模板语法](./docs/11-Mock模板语法.md)。

  两者出错都不会静默：响应体里带 `__mockStudioError__`，DevTools 面板标红，
  控制台提示一次，同一条规则连错 3 次自动熔断。
- CodeMirror 编辑器：JSON / JS 双模式、语法高亮、折叠、实时校验、格式化
- 三种响应体一键切换，各自配好起手模板
- 场景预设：空数据 / 500 / 401 / 慢 3 秒
- 响应外壳模板库（`{status,message,data}` 等），支持自定义，Capture 时自动识别

**观测与诊断**

- DevTools 面板实时请求流，被 Mock 的请求高亮标记
- 命中次数统计
- 规则遮蔽检测

**其他**

- 面板宽度可拖拽调整（双击重置，方向键微调）
- 删除项目/分组时可选择「保留内容」或「一并删除」
- 规则导入 / 导出 JSON，剪贴板导入
- 全部数据存本地，不联网

<details>
<summary><b>为什么要做命中次数和遮蔽检测</b></summary>

<br>

这两个不是统计癖，是**针对性的诊断功能**。

注入式 Mock 有个先天缺陷：**改动不会出现在 Chrome 的 Network 面板里**（我们在 JS 层就把请求截了，根本没走网络层）。所以规则不生效时，第一个疑问永远是「是我写错了，还是插件坏了」。

- **命中次数 = 0** → 规则没匹配上，是你的 URL 条件写错了
- **命中次数 > 0 但页面没变** → 匹配是对的，问题在响应内容或结构

两种情况排查方向完全不同。

遮蔽检测则是「先到先得」策略唯一的坑：一条规则可能因为被上面某条更宽泛的规则拦截，永远不会命中。UI 会直接告诉你「可能被上方的 XX 遮蔽」。

</details>

### 尚未实现

场景（批量切换变体的快照）· 改请求头/请求体 · 录制模式 · HAR 导入 ·
GraphQL 按 operationName 匹配

优先级与技术前提见 [09 项目状态与交接](./docs/09-项目状态与交接.md#5-下一步)。

---

## 架构

```
src/
├── core/          ★ 纯 TypeScript，零 chrome / DOM 依赖
│   ├── types.ts       规则数据模型（系统地基）
│   ├── engine/        matcher · responder · shell · normalize
│   │                  dynamic（跑 JS）· mockjs（展开模板）· bodygen（缓存+熔断）
│   ├── mcp/           出给 AI 的数据脱敏（不可关的那道线）
│   ├── command/       Command 定义 + reducer（纯函数）
│   ├── store/         默认值 · 版本迁移 · 校验
│   └── capture/       Capture-to-Mock 转换
│
├── hosts/         各执行环境的适配层
│   ├── inject/        MAIN world 拦截引擎 ← 实际干活的地方
│   ├── content/       ISOLATED 中继站
│   ├── background/    Service Worker（唯一状态持有者）
│   ├── popup/         轻量控制面板
│   ├── options/       规则管理
│   └── devtools/      Mock 面板
│
├── shared/        插件内部通信约定（含 MCP 桥协议）
└── ui/            跨页面复用的 React 组件

mcp-server/        ★ 独立 Node 进程：stdio 接 MCP 客户端，WebSocket 接扩展
└── src/           直接编译 ../src/core 复用业务逻辑，不走 npm 依赖
```

### core 层的铁律

> **不允许出现 `chrome.`、`window.`、`document.`**

三个具体理由，不是为了代码整洁这种虚的：

1. **同一份匹配逻辑要跑在两个地方** —— Service Worker 和 MAIN world 都需要它
2. **MCP Server 是 Node 进程**，那里没有 `chrome` 对象 —— 它现在直接编译 `src/core` 复用 matcher/reducer，这条铁律已经兑现了
3. **纯函数可以脱离浏览器测试** —— 不用启动 Chrome，不用 mock chrome API

### 数据流

```
                    ┌──────────────┐
   dispatch(cmd) ──→│  SW: 唯一状态 │──→ storage.local
                    │    持有者     │
                    └──────┬───────┘
                           │ 变更广播
              ┌────────────┼────────────┐
              ↓            ↓            ↓
          Popup      DevTools 面板   各 Tab 的引擎
```

所有状态变更（UI 点击、Capture 转规则、**AI 通过 MCP 下发**）都走**同一个 `dispatch(Command)` 入口**。
单一入口 = 单一真相 = 单一 bug 面。

---

## 三条不可退让的技术约束

这三条都是**实测踩出来的**，改动相关代码前请先读对应文档。

<table>
<tr><td width="30"><b>1</b></td><td>

### `world: "MAIN"` + `run_at: "document_start"` 缺一不可

Content script 默认跑在 **ISOLATED world**，和页面的 JS 环境完全隔离 ——
在那里改 `window.fetch` 改的是插件自己的副本，**页面根本不会走**。

而如果晚于页面脚本执行，页面可能已经把原始 `fetch` 存进变量了，再改 `window.fetch` 也没用。

→ [知识扫盲 §2](./docs/03-知识扫盲：Chrome插件核心概念.md)

</td></tr>
<tr><td><b>2</b></td><td>

### 注入脚本必须打成同步 IIFE

CRXJS 默认会把 content script 包成 loader，内部用**动态 `import()`** 加载真正的代码。
动态 import 是异步的 —— hook 安装被推迟到模块加载之后，**页面早期请求会漏拦，且时序随机难以复现**。

→ 所以注入脚本走 [`vite.inject.config.ts`](./vite.inject.config.ts) 单独打成 IIFE，
构建后由 [`build/injectContentScriptPlugin.ts`](./build/injectContentScriptPlugin.ts) 补进 manifest。

</td></tr>
<tr><td><b>3</b></td><td>

### 引擎健康判断必须用行为，不能用引用相等

实测发现：目标站点的监控 / APM SDK 会在我们**之后**再包一层 `fetch`，
导致 `window.fetch !== 我们的函数`。但我们仍在调用链**最底层**，mock 照常生效。

```js
window.fetch === ourFetch              // ❌ 会误报
observedCount + mockedCount > 0        // ✅ 正确
```

→ [Spike 验证结论 §2](./docs/04-Spike验证结论.md)

</td></tr>
</table>

---

## 开发

```bash
npm run dev            # 开发模式：UI 热更新 + 注入脚本自动重建
npm run build          # 完整构建（类型检查 + 注入脚本 + 主构建）
npm test               # 266 个单元测试
npm run typecheck      # 只做类型检查
```

**扩展只需加载一次。** Chrome 记住的是 `dist/` 这个目录，不是文件快照 ——
之后改代码不用再点「加载已解压的扩展程序」。

跑 `npm run dev` 之后：

| 改动位置 | 需要的操作 |
| --- | --- |
| Popup / Options / DevTools 面板 / `src/ui/` | **什么都不用做**（HMR 热替换） |
| `src/hosts/inject/`、`src/hosts/content/` | 刷新目标页面 |
| `src/hosts/background/`、`manifest.config.ts` | `chrome://extensions` 点刷新 ↻ |

一句话：**UI 改动零操作，页面脚本刷页面，后台脚本刷扩展。**

完整说明见 [06 开发工作流](./docs/06-开发工作流.md)。

### 测试

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `tests/matcher.test.ts` | 31 | 三种匹配模式边界、ReDoS 防护、host / method 过滤 |
| `tests/groups.test.ts` | 34 | 项目、分组、域名通配、批量操作、删除策略、外壳继承链 |
| `tests/responder.test.ts` | 25 | 响应构造、外壳套用与识别、Capture-to-Mock 转换、动态响应集成 |
| `tests/reducer.test.ts` | 17 | 所有 Command 的行为与纯函数性 |
| `tests/variants.test.ts` | 16 | **变体**：切换、增删、深拷贝、生效态回落 |
| `tests/migrate.test.ts` | 18 | **v1→v2 迁移**、结构自愈、新增设置项的补齐 |
| `tests/inject.test.ts` | 20 | **注入层**：fetch / XHR 拦截、fail-open、延迟、健壮性 |
| `tests/dynamic.test.ts` | 16 | **动态响应**：两种写法编译、执行降级、序列化边界 |
| `tests/mockjs.test.ts` | 39 | **Mock 模板**：数量/递增/浮点规则、占位符、护栏、确定性 |
| `tests/bodygen.test.ts` | 15 | **生成运行时**：编译缓存、连错熔断、报告去重 |
| `tests/redact.test.ts` | 32 | **脱敏**（安全边界）：敏感键识别、JWT、URL / 响应体、白名单通配 |

另有 **18 项 MCP 端到端**（`cd mcp-server && npm run e2e`）：用假扩展冒充 Chrome 侧，
验证握手、Origin/配对码拒绝、读侧四个工具、写侧闭环。跑的是编译产物。

注入层测试跑在 happy-dom 里真实执行 hook 逻辑 —— 伪造 XHR 响应是全项目最容易写错的地方
（原型上的只读 getter、事件派发时序），手工验证成本高且容易漏边界。

<details>
<summary><b>引擎代码的健壮性要求比 UI 高一个数量级</b></summary>

<br>

`matcher` 跑在**用户的每一个请求**上，任何异常或卡顿都会直接毁掉整个页面。所以有三条铁律：

1. **永远不抛异常** —— 用户写了个非法正则，不 catch 的话整个 hook 崩溃，页面所有请求全挂
2. **永远不阻塞** —— 正则有三道 ReDoS 防线：静态检测嵌套量词事前拒绝、截断超长输入、耗时兜底拉黑
3. **纯函数，零副作用**

第 2 条是被测试逼出来的：最初的设计是「测量耗时超预算就拉黑」，但测试跑出来发现
`(a+)+$` 匹配 40 个 a 需要 **42 秒** —— 而耗时检查发生在正则**跑完之后**，第一次的卡死根本拦不住。
加上事前静态检测后，同样的恶意正则 5ms 内返回。

</details>

---

## 排错

| 现象 | 原因 / 解法 |
| --- | --- |
| 测试页显示「未检测到引擎」 | 装扩展后没刷新页面；或 `dist/inject.js` 缺失，跑 `npm run build` |
| 规则命中次数一直是 0 | URL 匹配条件写错了。用 DevTools 面板对照真实请求的 URL |
| 命中了但页面数据没变 | 响应体内容或结构不对，比如外壳套错了 |
| 早期请求没被拦截 | 规则下发前的请求会 fail-open 放行，刷新页面即可 |
| 改了代码不生效 | 改 `src/hosts/inject/` 需要重新 build + 刷新扩展 + 刷新页面 |
| 某条规则永不命中 | 看是否有「被上方规则遮蔽」的警告 —— 匹配是先到先得 |

各类脚本的 console 分别在哪看：[知识扫盲 §8](./docs/03-知识扫盲：Chrome插件核心概念.md)

---

## 文档

这个项目的文档是**先于代码**写的，记录了每个决策的来龙去脉。按顺序读能看到完整的思考过程。

| | 内容 |
| --- | --- |
| [01 市场调研与产品报告](./docs/01-市场调研与产品报告.md) | 竞品盘点、三条技术路线的取舍、产品定位与差异化 |
| [02 需求补充](./docs/02-需求补充：AI协同与虚拟接口.md) | AI 协同三级方案、虚拟接口、为 MCP 做的架构预留 |
| [03 知识扫盲](./docs/03-知识扫盲：Chrome插件核心概念.md) | Chrome 插件核心概念，零基础可读 |
| [04 Spike 验证结论](./docs/04-Spike验证结论.md) | 真实站点上的可行性验证结果 |
| [05 技术方案设计](./docs/05-技术方案设计.md) | 数据模型、分层、消息协议，**每个决策都讲了为什么** |
| [06 开发工作流](./docs/06-开发工作流.md) | 热更新流程、各处 console 在哪看、构建管线为何这样设计 |
| [07 下阶段规划](./docs/07-下阶段规划.md) | 优先级排序与技术债（部分内容已被 08、09 更新） |
| [08 信息架构重构 PRD](./docs/08-信息架构重构PRD.md) | **项目 / 分组 / 变体的权威定义**，v1→v2 迁移方案 |
| [**09 项目状态与交接**](./docs/09-项目状态与交接.md) | **当前进度、下一步、不能踩的坑** —— 接手先读这份 |

`spike/` 目录保留了最初的可行性验证代码，是一个不依赖任何构建工具的最小插件，
适合对照 03 号文档理解 Chrome 插件的运行机制。

---

## 技术栈

React 18 · TypeScript · Vite · CRXJS · CodeMirror 6 · Vitest · Manifest V3

---

<div align="center">
<sub>个人学习项目 · 从零开始的 Chrome 扩展开发实践</sub>
</div>
