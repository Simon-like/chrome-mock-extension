# 浏览器 Mock 插件 · 市场调研与产品报告

> 类型：Discovery
> 状态：Historical Reference（产品范围已由后续 PRD 演进）
> Owner：项目维护者
> 版本：v1（评审稿）
> 日期：2026-07-24
> 原始状态：基础功能已评审通过；**范围后来扩充，见 [PRD-0001](../prds/PRD-0001-ai-collaboration-and-virtual-endpoints.md)**
>
> ⚠️ 本文第 4.1 节定位、4.3 节非目标、第 5 章功能清单已被 02 号文档修订，以 02 号为准。

---

## 0. 一页速览（TL;DR）

- **市场结论**：这个赛道已经很拥挤，但**没有一个产品同时做到「零配置起步 + 本地优先 + 前端友好的 Mock 语义」**。头部产品（Requestly）功能强但重、要登录、核心能力逐步付费化；轻量产品（Tweak / Ajax Interceptor / Mokku）好上手但能力天花板明显。
- **技术结论**：Manifest V3 下**没有任何一条路线能既改响应体、又零副作用**。三条路线各有硬伤，产品形态本质上是由技术路线决定的（详见第 3 章）。这是本项目最重要的设计决策。
- **产品结论**：建议做「**Capture-to-Mock**」——从 DevTools 里抓到的真实请求，一键变成可编辑的 Mock，而不是让用户从空白表单手填 URL。这是所有竞品都做得不够好的一个点，也正好命中你「配置繁琐」的痛点。
- **对你的学习价值**：这个项目会自然覆盖 Chrome 插件 90% 的核心知识点（MV3、Service Worker、Content Script、MAIN world 注入、DevTools 面板扩展、storage、消息通信、declarativeNetRequest、打包发布），是一个「难度合适、不过度」的入门终局项目。

---

## 1. 调研背景与你的真实痛点

### 1.1 现状描述

| 现有方案 | 问题 |
| --- | --- |
| 让 AI 在本地代码里写 mock 数据 | **侵入业务代码**：要加 if/else、要记得删、容易误提交；切换真假数据要改代码重启；多人协作时 mock 代码互相冲突 |
| 公司提供的 Mock 网站 | **配置繁琐**：新建一个接口要填一堆字段；**不灵活**：难以按参数/场景返回不同数据；要切环境、改代理，改一次 mock 要跳出 IDE 走一遍平台流程 |

### 1.2 提炼出的核心痛点（后续所有功能都要回答这几条）

| 编号 | 痛点 | 说明 |
| --- | --- | --- |
| P1 | **侵入性** | Mock 不应该进入业务代码仓库 |
| P2 | **起步成本高** | 「我想 mock 眼前这个接口」到「mock 生效」之间的步骤太多，尤其是手抄 URL / 手填 method / 手写完整 JSON |
| P3 | **不够动态** | 只能返回固定 JSON，不能根据请求参数（分页、id、关键词）动态返回 |
| P4 | **场景能力缺失** | 慢网络、超时、500、401 过期、空列表、超长列表——这些前端最常要测的边界，没有一键预设 |
| P5 | **开关成本** | 真假数据来回切要点很多下；一组相关接口没法整体开关 |
| P6 | **共享困难** | 想把一套 mock 给同事 / 给自己的另一台机器，路径不顺畅 |

---

## 2. 竞品盘点

### 2.1 竞品全景表

> 评分/用户数为公开渠道（Chrome Web Store、厂商站点、第三方对比文章）采集的近似值，仅用于判断量级，非精确数据。

| 产品 | 类型 | 量级 | 技术路线 | 核心能力 | 定价 |
| --- | --- | --- | --- | --- | --- |
| **Requestly** | 插件 + Web + 桌面 | ~200k 开发者，评分 4.3（1.2k 评价） | DNR + 注入 + 云端 | 规则引擎（重定向/改 header/改响应/注入脚本/阻断）、GraphQL、录制回放、HAR 导入、团队协作 | Free / $8 / $15 / $23 per member/月 |
| **Tweak** | 插件 | 60k+ 用户，评分 4.65（203 评价） | 注入为主 | 改响应体/header/状态码/请求体、延迟、规则导入导出 | 免费为主，有付费档 |
| **ModHeader** | 插件 | 评分 3.2（1.1k 评价） | DNR | **主打改 Header**，响应体能力弱 | 免费带广告 + 付费解锁 |
| **Mokku** | 插件（DevTools 面板） | 评分 3.4（77 评价） | 注入 | DevTools 内建 Mock、改状态码/header/body | 免费带广告 |
| **Mockiato** | 插件（DevTools 面板） | 开源 | DevTools + 注入 | Mock 分组、延迟模拟、环境 profile、本地存储不上云 | 免费开源 |
| **Ajax Interceptor Tools / ajax-tools** | 插件（国内社区流行） | ~4k 用户，评分 4.4 | MAIN world 注入 + DNR 补充 | 正则匹配、JSON/JS 两种编辑模式、**内置 Mock.js**、DevTools 面板、配置导入导出、画中画 | 免费开源 |
| **XSwitch** | 插件 | 国内前端常用 | DNR 重定向 | **URL 重定向**（线上资源指向本地），配置即一段 JSON | 免费 |
| **ModResponse** | 插件 | — | `chrome.debugger` (CDP) | 真网络层拦截、录制真实响应后回放 | 付费为主 |
| **OhMyMock** | 插件 | 开源 | `chrome.debugger` | 先录后放：第一次缓存真实响应，之后回放 | 免费开源 |
| **Mockoon** | 桌面 App（**非插件**，对照组） | 开源知名 | 本地 HTTP Server | 完整 Mock Server、离线、模板引擎、CLI | 免费开源 |

### 2.2 产品特点总结（横向提炼）

**A. 大家都有的「基础盘」——这是入场门槛，我们必须全覆盖**

1. 按 URL 匹配请求（字符串包含 / 通配符 / 正则）
2. 按 HTTP Method 过滤
3. 自定义响应体（JSON 编辑器）
4. 自定义状态码
5. 自定义响应头
6. 单条规则开关 + 全局总开关
7. 规则的导入 / 导出（JSON 文件）

**B. 拉开差距的「进阶能力」**

| 能力 | 谁在做 | 价值 |
| --- | --- | --- |
| 动态响应（用 JS 函数、拿到 request 参数再生成） | Requestly、Ajax Interceptor Tools | ★★★★★ 直击 P3 |
| 内置假数据生成（Mock.js / faker） | Ajax Interceptor Tools | ★★★★☆ 直击 P2 |
| 延迟 / 超时模拟 | Tweak、Mockiato | ★★★★☆ 直击 P4 |
| 录制真实响应 → 一键转 Mock | ModResponse、OhMyMock、Requestly | ★★★★★ 直击 P2 |
| DevTools 面板集成（在 Network 旁边操作） | Mokku、Mockiato、Ajax Interceptor Tools | ★★★★☆ 直击 P2/P5 |
| 规则分组 / 场景切换（一组 mock 整体开关） | Mockiato（profile）、Requestly（workspace） | ★★★★☆ 直击 P5 |
| 团队共享 / 云同步 | Requestly | ★★★☆☆ 直击 P6，但要账号体系 |
| GraphQL 支持（按 operationName 匹配） | Requestly | ★★★☆☆ 看你司是否用 |
| URL 重定向到本地文件 | XSwitch、Requestly | ★★★☆☆ 另一类场景 |

**C. 用户抱怨集中在哪里（差评关键词）**

1. **付费墙**——核心能力（团队、规则数、高级匹配）逐步收费，是几乎所有商业化产品的通病
2. **广告**——ModHeader、Mokku 被明确吐槽插件内置广告
3. **要登录/上云**——公司内网接口数据敏感，很多人不敢用需要账号的工具
4. **每个接口都要手动配一遍**——Mokku 被点名，正是 P2
5. **UI 不直观 / 学习成本高**——功能越全的越明显（ModHeader）
6. **改了不在 Network 面板显示**——注入式方案的通病，容易让人误以为没生效（Ajax Interceptor Tools 官方说明里明确写了这一点）

**D. 一个关键的市场空白**

> 没有一个产品把「**抓包 → 一键转 Mock → 就地改几个字段**」这条主路径做顺。
> 大部分产品的默认路径仍然是「新建规则 → 手填 URL → 手写整个 JSON」。
> 而前端 90% 的真实需求是：**这个接口已经通了，我只想把 `data.list` 改成空数组看看空状态**。

这就是我们的切入点。

---

## 3. 技术路线调研（决定产品能力边界，必须先定）

Manifest V3 之后，插件改响应体只有三条路，**没有一条是完美的**：

### 路线 A：`chrome.declarativeNetRequest`（声明式网络请求）

- **能做**：阻断请求、重定向 URL、改请求头/响应头、按域名/资源类型/method 匹配
- **不能做**：**改响应体**（这是 MV3 明确的能力缺口）
- **变通**：重定向到 `data:application/json,...` 或插件内置的静态文件，可以伪造出一个响应体
- **代价**：只能是**静态**内容（拿不到请求参数）；data URL 有长度限制；跨域场景下 CORS 头需要额外处理
- **优点**：**零性能损耗、无副作用、不打扰用户、Network 面板正常显示**

### 路线 B：MAIN world 注入脚本，Hook `fetch` / `XMLHttpRequest`

- **能做**：几乎全部——动态生成、拿到完整 request、跑任意 JS、用 Mock.js
- **不能做**：拦截非 JS 发起的请求（`<img>`、`sendBeacon`、WebSocket、SSE 需另做）
- **代价 1**：**不走真实网络层，Chrome Network 面板看不到改动**（用户体验上的大坑，必须靠 UI 补偿）
- **代价 2**：**注入时机竞态**——必须在页面任何脚本之前执行（`run_at: document_start` + `world: "MAIN"`），否则页面已经缓存了原始 `fetch` 引用就 hook 不到
- **代价 3**：某些库（axios 早期用 XHR、部分 SDK 自带 fetch polyfill）需要额外适配
- **优点**：能力最强、无任何用户可见副作用

### 路线 C：`chrome.debugger` + CDP `Fetch.requestPaused`

- **能做**：真·网络层拦截，改响应体、Network 面板可见、覆盖所有请求类型
- **代价 1**：浏览器顶部常驻黄条 **「XX 正在调试此浏览器」**，且会出现在所有标签页
- **代价 2**：**与 DevTools 互斥**——用户打开 F12 会抢占调试会话
- **代价 3**：性能开销明显（每个请求都要暂停等待）
- 结论：只适合作为「高级模式」可选开关，不能作为默认

### 3.1 推荐路线：**B 为主 + A 为辅，C 作为 V2 可选**

| 场景 | 用哪条路 |
| --- | --- |
| 改响应体（核心场景，占 90%） | **B** 注入 hook |
| 改请求头 / 响应头 | **A** DNR |
| 阻断请求 / 重定向到本地 | **A** DNR |
| 延迟模拟 | **B**（注入层 `await sleep`） |
| 非 XHR/fetch 的请求（图片、beacon） | **A**，或 V2 的 **C** |

**必须在 UI 上补偿路线 B 的「Network 面板看不到」问题**：在插件自己的面板里做一个「被 Mock 的请求列表」，实时显示哪些请求被拦截了、命中了哪条规则、返回了什么。这本身就是一个差异化功能。

---

## 4. 产品定位与差异化

### 4.1 一句话定位

> **一个不需要登录、不写代码、从「抓到的真实请求」一键起步的前端 Mock 插件。**

### 4.2 三条差异化主张

| # | 主张 | 对应痛点 | 竞品做得如何 |
| --- | --- | --- | --- |
| D1 | **Capture-to-Mock**：主路径是「从实时请求列表里点一下 → 真实响应自动填进编辑器 → 改几个字段 → 生效」，而非从空白表单开始 | P2 | 只有付费产品部分实现，且路径不短 |
| D2 | **本地优先，零账号**：所有数据存在本地，永不上传；共享靠导出 JSON 文件 | P6 + 数据安全顾虑 | 头部产品都在推云端 |
| D3 | **场景化预设**：一键套用「空数据 / 超长列表 / 500 错误 / 401 过期 / 慢 3 秒 / 请求超时」等前端高频边界场景 | P4 | 基本没人做成一键预设 |
| D4 | **AI-Native**：Mock 规则是 AI 的一等公民，AI 既能读到页面实际发生的请求，也能直接写规则（详见 02 号文档） | P2 + P3 | **无人涉足**——现有工具全是给人用的 GUI |

### 4.3 明确的非目标（V1 不做，避免范围失控）

- ❌ 团队协作、云同步、账号体系
- ❌ 完整的 API Client（不做 Postman）
- ❌ WebSocket / SSE / gRPC mock
- ❌ 移动端抓包
- ❌ 商业化 / 付费墙

---

## 5. 功能清单

### 5.1 MVP（第一个能自己天天用的版本）

| ID | 功能 | 说明 | 验收标准 |
| --- | --- | --- | --- |
| F1 | 请求拦截引擎 | MAIN world 注入，hook `fetch` + `XHR` | 在你司业务站点上，能稳定拦截到 axios 和原生 fetch 发出的请求 |
| F2 | 规则匹配 | URL 关键字包含 / 通配符 `*` / 正则，三选一；可选 Method 过滤 | 三种模式各有测试用例通过 |
| F3 | 静态响应 Mock | JSON 编辑器，改响应体 + 状态码 | 页面拿到的是 mock 内容，格式错误有即时提示 |
| F4 | 规则列表与开关 | 单条开关 + 全局总开关（含快捷键） | 关掉总开关后所有请求恢复真实 |
| F5 | **实时请求面板** | DevTools 面板显示本页请求流，标记哪些被 Mock 命中 | 能看到「命中规则名」和「实际返回内容」 |
| F6 | **Capture-to-Mock** | 请求面板里任意一条 → 「转为 Mock」→ 自动填入 URL/Method/真实响应体 | 从看到请求到 Mock 生效 ≤ 3 次点击 |
| F7 | 数据持久化 | `chrome.storage.local` | 重启浏览器规则不丢 |
| F8 | 导入 / 导出 | 全量规则 JSON 文件 | 导出的文件能在另一台机器完整导入 |

### 5.2 V1（把「好用」做出来）

| ID | 功能 | 说明 |
| --- | --- | --- |
| F9 | **动态响应** | 响应体支持写成 JS 函数 `(req) => {...}`，可读取 query/body/params |
| F10 | **假数据生成** | 内置 Mock.js 或 faker 语法，`"list|10": [{...}]` 一行生成 10 条 |
| F11 | **场景预设** | 一键：空数据 / 超长列表 / 500 / 401 / 403 / 网络超时 / 延迟 N 秒 |
| F12 | 延迟模拟 | 固定延迟 + 随机区间 |
| F13 | 规则分组 / 场景组 | 一组规则整体开关，支持「场景」切换（如：正常态 / 全空态 / 全错态） |
| F14 | 改请求 | 改请求头、请求体、query（走 DNR + 注入） |
| F15 | 域名作用域 | 规则可限定只在某些域名生效，避免误伤 |

### 5.3 V2（有余力再做）

- F16 录制模式：一段时间内自动录下所有响应，批量转 Mock
- F17 HAR 文件导入
- F18 `chrome.debugger` 高级模式（覆盖非 XHR 请求 + Network 面板可见）
- F19 GraphQL 按 `operationName` 匹配
- F20 URL 重定向到本地文件（XSwitch 能力）
- F21 差异化 Mock：同一 URL 按参数命中不同响应（如 `page=1` 与 `page=2`）

---

## 6. 形态与信息架构（草案）

```
┌─ Popup（点插件图标）────────────┐   轻量：总开关、当前页命中数、快速跳转
├─ DevTools 面板「Mock」──────────┤   主战场：左=实时请求流，右=规则编辑器
├─ Options 页（完整管理）─────────┤   规则库、分组、导入导出、设置
└─ 内容脚本 + 注入脚本 ───────────┘   实际干活的地方
```

主交互动线（Capture-to-Mock）：

```
打开 DevTools → Mock 面板 → 看到请求流
   → 点某条请求的「Mock 它」
   → 右侧自动带出真实响应 JSON
   → 改几个字段 / 点「空数据」预设
   → 保存 → 页面刷新 → 生效
```

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| **注入时机竞态**，hook 不到早期请求 | 高 | `document_start` + `world: MAIN`；写专门的时序测试页 |
| **Network 面板看不到改动**，误以为没生效 | 高 | F5 实时请求面板作为补偿；命中时 console 打标记 |
| 某些 SDK 缓存了原始 fetch | 中 | 收集失败案例，V1 提供「强制模式」 |
| MV3 政策继续收紧 | 中 | 尽量少依赖敏感权限；host_permissions 按需申请 |
| 公司站点有 CSP / 严格安全策略 | 中 | 先在你司实际站点做**可行性验证**（见下方开放问题） |
| 范围失控做成 Requestly | 高 | 严守 4.3 节非目标；MVP 8 个功能不加码 |

---

## 8. 学习价值映射（这是本项目的另一个目标）

| 功能 | 学到的 Chrome 插件知识点 |
| --- | --- |
| 项目初始化 | Manifest V3 结构、权限模型、加载未打包扩展、调试方法 |
| F1 拦截引擎 | Content Script、**MAIN world / ISOLATED world 隔离**、`run_at` 时机、脚本注入 |
| F5/F6 DevTools 面板 | `devtools_page`、`chrome.devtools.panels`、`chrome.devtools.network` |
| 规则下发 | **Service Worker（背景页）生命周期**、`chrome.runtime` 消息通信、长连接 Port |
| F7 持久化 | `chrome.storage.local / sync`、配额与变更监听 |
| F14 改请求头 | **`declarativeNetRequest`** 规则语法、动态规则 API |
| Popup / Options | `action` API、扩展页面通信、`chrome.commands` 快捷键 |
| 打包发布 | 构建工具链（Vite + CRXJS）、版本号、Web Store 上架与审核 |
| V2 高级模式 | `chrome.debugger` + Chrome DevTools Protocol |

覆盖度：**Chrome 插件核心 API 的 90%**，且每个知识点都有真实使用场景，不是 Hello World。

---

## 9. 决策记录

| # | 问题 | 决策 | 状态 |
| --- | --- | --- | --- |
| Q1 | **技术路线** | **B 注入为主 + A DNR 为辅**，C（`chrome.debugger`）留到 V2 | ✅ 已定 |
| Q2 | **MVP 范围** | **锁定 F1–F8**，共 8 项，不加码 | ✅ 已定 |
| Q3 | 可行性验证 | **开发前先做半天 Spike**：最小 demo 插件，在你司实际业务站点上 hook 到 axios/fetch 请求并打印。**此项不通过则方案需重做** | ✅ 已定，待执行 |
| Q4 | 技术栈 | **React + TypeScript + Vite（CRXJS）** | ✅ 已定 |
| Q5 | 浏览器范围 | V1 只做 Chrome（待确认，建议如此） | ⏳ 建议 |
| Q6 | 是否上架 Web Store | 建议做，作为学习闭环最后一环（待确认） | ⏳ 建议 |

---

## 10. 下一步（评审通过后）

1. **知识扫盲文档**：Chrome 插件基础概念对齐（架构、权限、各类脚本的边界、调试手段）
2. **可行性验证 Spike**：最小 demo 验证 Q3
3. **技术方案设计文档**：目录结构、数据模型（规则 Schema）、模块划分、消息协议、构建配置
4. **开发排期**：按 F1–F8 拆任务

---

## 附：参考来源

- [Top Chrome Extensions for Overriding API Responses — Requestly](https://requestly.com/guides/top-chrome-extensions-for-overriding-api-responses/)
- [Requestly Alternatives / Comparisons](https://requestly.com/alternatives/)
- [Mockoon vs Requestly 对比](https://mockoon.com/compare/requestly/)
- [tweak — Mock API calls 官网](https://tweak-extension.com/)
- [Ajax Interceptor Tools — Chrome Web Store](https://chromewebstore.google.com/detail/ajax-interceptor-tools/kphegobalneikdjnboeiheiklpbbhncm)
- [ajax-tools — GitHub](https://github.com/PengChen96/ajax-tools)
- [Mockiato — GitHub](https://github.com/avivasyuta/mockiato)
- [Mock Express — Chrome Web Store](https://chromewebstore.google.com/detail/mock-express-api-mock-htt/dbcmekejnbcejobnahedglfapjaodpli)
- [ModResponse — Chrome Web Store](https://chromewebstore.google.com/detail/modresponse-mock-and-repl/bbjcdpjihbfmkgikdkplcalfebgcjjpm)
- [oh-my-mock — GitHub](https://github.com/scaljeri/oh-my-mock)
- [chrome.webRequest API 文档](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
- [Replace blocking web request listeners（MV3 迁移指南）](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests)
- [Chrome DevTools Protocol — Fetch domain](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/)
- [The Top 9 API Mocking Tools of 2025, Compared — DEV](https://dev.to/moonlit1151/api-mocking-9-tools-compared-4e1a)
