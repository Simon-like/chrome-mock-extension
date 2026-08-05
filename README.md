# Mock Studio

AI 可编程的本地 Mock 运行时 —— Chrome 扩展。

> 学习项目。文档在 [docs/](./docs)，建议按 01 → 05 的顺序读。
> 当前进度：**S0–S10 已完成，MVP 功能齐**（见 [排期](./docs/05-技术方案设计.md#10-开发排期)）

---

## 快速开始

```bash
npm install
npm run build
```

然后在 Chrome 里：

1. 打开 `chrome://extensions`
2. 开启右上角 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择 **`dist/`** 目录（不是项目根目录）
4. **刷新你要调试的页面** —— 注入脚本只在页面加载时执行

验证是否工作：用浏览器打开 `testbed/index.html`，点「检查引擎」。

---

## 常用命令

```bash
npm run build          # 完整构建（含类型检查 + 注入脚本）
npm test               # 89 个单元测试（core + 注入层）
npm run typecheck      # 只做类型检查
npm run build:inject   # 只重建注入脚本
```

测试分布：

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `tests/matcher.test.ts` | 31 | 三种匹配模式的边界、ReDoS 防护、host/method 过滤 |
| `tests/responder.test.ts` | 22 | 响应构造、外壳套用与识别、Capture-to-Mock、版本迁移 |
| `tests/reducer.test.ts` | 16 | 所有 Command 的行为与纯函数性 |
| `tests/inject.test.ts` | 20 | **注入层**：fetch/XHR 拦截、fail-open、延迟、健壮性 |

注入层测试跑在 happy-dom 里，真实执行 hook 逻辑 —— 伪造 XHR 响应是全项目最容易写错的地方
（原型上的只读 getter、事件派发时序），手工验证成本高且容易漏边界。

改了 `src/hosts/inject/` 下的代码后，必须重跑 `npm run build`（或 `build:inject`），
再去 `chrome://extensions` 点刷新 ↻，**然后刷新页面**。

---

## 怎么用

### 从真实请求创建 Mock（推荐路径）

1. 在目标页面按 F12，切到 **Mock** 面板
2. 触发页面操作，请求会实时出现在列表里
3. 找到目标请求，点 **「转为 Mock」** —— 真实响应会自动填进右侧编辑器
4. 改几个字段，或点「空数据」「500 错误」等预设
5. 保存 → 刷新页面 → 生效

### 手工新建虚拟接口（后端还没做）

1. 点扩展图标 → 「管理规则」
2. 「+ 新建规则」→ 类型选 **「新建虚拟接口」**
3. 填 URL 和响应体 → 保存

> 虚拟接口在列表里有橙色「虚拟」标记。**停用它页面请求会真的失败**，
> 而覆盖式规则停用只是回到真实数据 —— 风险等级不同，所以要区分标记。

### 让 AI 帮你写规则

把 [skills/mock-rule-authoring/](./skills/mock-rule-authoring/SKILL.md) 装进 Claude Code，
然后直接说「帮我 mock 一个商品列表接口，10 条数据带分页」。
AI 生成 JSON 后，在规则管理页点 **「从剪贴板导入」**。

---

## 架构

```
src/
├── core/          ★ 纯 TypeScript，零 chrome/DOM 依赖
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
│   └── devtools/      Mock 面板（请求流 + Capture-to-Mock）
│
├── shared/        插件内部通信约定
└── ui/            跨页面复用的 React 组件
```

**core 层的铁律：不允许出现 `chrome.`、`window.`、`document.`。**

三个理由（详见 [设计文档 §3.2](./docs/05-技术方案设计.md)）：

1. 同一份匹配逻辑要同时跑在 Service Worker 和 MAIN world 两个地方
2. V2 的 MCP Server 是 Node 进程，没有 `chrome` 对象，但要复用同一套业务逻辑
3. 纯函数可以脱离浏览器做单元测试

---

## 三条不可退让的技术约束

这三条都是实测得出的，改动前请先读对应文档。

### 1. `world: "MAIN"` + `run_at: "document_start"`

在 ISOLATED world（content script 默认）里改 `window.fetch` **完全拦不到页面请求** ——
两个 world 的 JS 环境是隔离的。而晚于页面脚本执行的话，页面可能已经把原始 `fetch`
存进变量了，改 `window.fetch` 也没用。

→ [知识扫盲 §2](./docs/03-知识扫盲：Chrome插件核心概念.md)

### 2. 注入脚本必须打成同步 IIFE

CRXJS 默认会把 content script 包成 loader，内部用**动态 `import()`** 加载真正的代码。
动态 import 是异步的，会把 hook 安装时机推迟到模块加载之后，破坏 `document_start` 的时序保证。

→ 所以注入脚本走 [`vite.inject.config.ts`](./vite.inject.config.ts) 单独打成 IIFE，
构建后由 [`build/injectContentScriptPlugin.ts`](./build/injectContentScriptPlugin.ts) 补进 manifest。

### 3. 引擎健康判断必须用行为，不能用引用相等

实测结果：目标站点的监控/APM SDK 会在我们**之后**再包一层 `fetch`，
导致 `window.fetch !== 我们的函数`。但我们仍在调用链**最底层**，mock 照常生效。

```js
// ❌ 会误报
window.fetch === ourFetch

// ✅ 正确
observedCount + mockedCount > 0
```

→ [Spike 验证结论 §2](./docs/04-Spike验证结论.md)

---

## 已实现功能

| ID | 功能 |
| --- | --- |
| F1 | 拦截引擎（fetch + XHR） |
| F2 | 三种 URL 匹配模式（包含 / 通配符 / 正则）+ Method 过滤 |
| F3 | 静态响应 Mock（状态码 / 响应头 / 响应体） |
| F4 | 单条开关 + 全局总开关 + `Alt+M` 快捷键 |
| F5 | DevTools 实时请求面板 |
| F6 | **Capture-to-Mock**（从真实请求一键转规则） |
| F7 | 持久化（`chrome.storage.local`） |
| F8 | 导入 / 导出 JSON |
| F22 | **虚拟接口**（凭空新增后端不存在的接口） |
| F24 | 响应外壳模板库（部分：内置模板 + 规则级选择） |
| F25 | 外壳自动推断（Capture-to-Mock 时识别） |
| L0 | AI Skill + 剪贴板导入 |
| — | 场景预设（空数据 / 500 / 401 / 慢 3 秒） |
| — | 规则遮蔽检测、命中次数诊断、ReDoS 防护 |

## 未实现（V1/V2）

动态响应（JS 函数）· Mock.js 假数据生成 · 规则分组与场景切换 ·
改请求头/请求体 · 录制模式 · HAR 导入 · MCP Server · GraphQL 匹配

---

## 排错

| 现象 | 原因 / 解法 |
| --- | --- |
| 测试页显示「未检测到引擎」 | 装扩展后没刷新页面；或 `dist/inject.js` 缺失（跑 `npm run build`） |
| 规则命中次数一直是 0 | URL 匹配条件写错了。用 DevTools 面板对照真实请求的 URL |
| 命中了但页面数据没变 | 响应体内容或结构不对（比如外壳套错了） |
| 早期请求没被拦截 | 规则下发前发出的请求会 fail-open 放行。刷新页面即可 |
| 规则改了不生效 | 改 `src/hosts/inject/` 需要重新 build + 刷新扩展 + 刷新页面 |
| 列表里某条规则永不命中 | 看是否有「被上方规则遮蔽」的警告 —— 匹配是先到先得 |

各类脚本的 console 在哪看：[知识扫盲 §8](./docs/03-知识扫盲：Chrome插件核心概念.md)

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [01 市场调研与产品报告](./docs/01-市场调研与产品报告.md) | 竞品分析、技术路线选型、产品定位 |
| [02 需求补充](./docs/02-需求补充：AI协同与虚拟接口.md) | AI 协同三级方案、虚拟接口、架构预留 |
| [03 知识扫盲](./docs/03-知识扫盲：Chrome插件核心概念.md) | Chrome 插件核心概念（零基础可读） |
| [04 Spike 验证结论](./docs/04-Spike验证结论.md) | 真实站点可行性验证结果 |
| [05 技术方案设计](./docs/05-技术方案设计.md) | 数据模型、分层、消息协议、每个决策的理由 |
