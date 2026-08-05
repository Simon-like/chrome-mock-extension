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
| **AI 协作** | 只有给人点的 GUI | 规则是 AI 的一等公民，可直接生成并导入 |
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

把 [`skills/mock-rule-authoring/`](./skills/mock-rule-authoring/SKILL.md) 装进 Claude Code，然后直接说：

> 帮我 mock 一个商品列表接口，10 条数据带分页

AI 生成 JSON 后，在规则管理页点 **「剪贴板导入」**。

---

## 功能

**规则与匹配**

- 三种 URL 匹配模式：包含 / 通配符 / 正则，可叠加 Method 过滤
- 列表顺序即优先级（先到先得），支持上下调整
- 覆盖已有接口 / 新建虚拟接口两种类型
- 单条开关 + 全局总开关 + `Alt+M` 快捷键

**响应构造**

- 自定义状态码、响应头、响应体
- CodeMirror 编辑器：语法高亮、折叠、实时校验、格式化
- 场景预设：空数据 / 500 / 401 / 慢 3 秒
- 响应外壳模板库（`{status,message,data}` 等），支持自定义，Capture 时自动识别

**观测与诊断**

- DevTools 面板实时请求流，被 Mock 的请求高亮标记
- 命中次数统计
- 规则遮蔽检测

**其他**

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

动态响应（JS 函数）· Mock.js 假数据生成 · 规则分组与场景切换 · 改请求头/请求体 ·
录制模式 · HAR 导入 · MCP Server · GraphQL 按 operationName 匹配

---

## 架构

```
src/
├── core/          ★ 纯 TypeScript，零 chrome / DOM 依赖
│   ├── types.ts       规则数据模型（系统地基）
│   ├── engine/        matcher · responder · shell · normalize
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
├── shared/        插件内部通信约定
└── ui/            跨页面复用的 React 组件
```

### core 层的铁律

> **不允许出现 `chrome.`、`window.`、`document.`**

三个具体理由，不是为了代码整洁这种虚的：

1. **同一份匹配逻辑要跑在两个地方** —— Service Worker 和 MAIN world 都需要它
2. **未来的 MCP Server 是 Node 进程**，那里没有 `chrome` 对象，但要复用同一套业务逻辑
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

所有状态变更（UI 点击、Capture 转规则、未来的 AI 下发）都走**同一个 `dispatch(Command)` 入口**。
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
npm run build          # 完整构建（类型检查 + 注入脚本 + 主构建）
npm test               # 89 个单元测试
npm run typecheck      # 只做类型检查
npm run build:inject   # 只重建注入脚本
```

改了 `src/hosts/inject/` 下的代码后：`npm run build` → `chrome://extensions` 点刷新 ↻ → **刷新页面**。

### 测试

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `tests/matcher.test.ts` | 31 | 三种匹配模式边界、ReDoS 防护、host / method 过滤 |
| `tests/responder.test.ts` | 22 | 响应构造、外壳套用与识别、Capture 转换、版本迁移 |
| `tests/reducer.test.ts` | 16 | 所有 Command 的行为与纯函数性 |
| `tests/inject.test.ts` | 20 | **注入层**：fetch / XHR 拦截、fail-open、延迟、健壮性 |

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

`spike/` 目录保留了最初的可行性验证代码，是一个不依赖任何构建工具的最小插件，
适合对照 03 号文档理解 Chrome 插件的运行机制。

---

## 技术栈

React 18 · TypeScript · Vite · CRXJS · CodeMirror 6 · Vitest · Manifest V3

---

<div align="center">
<sub>个人学习项目 · 从零开始的 Chrome 扩展开发实践</sub>
</div>
