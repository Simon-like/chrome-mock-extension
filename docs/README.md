# Mock Studio 文档中心

这里是项目文档的唯一入口。文档按“职责”组织，而不是按创建顺序排列；遇到内容冲突时，先看本文的权威性规则，再看文档状态和更新时间。

## 先从哪里读

| 你的目的 | 从这里开始 |
| --- | --- |
| 第一次了解项目 | [产品调研与定位](./product/discovery/market-and-product-research.md) → [当前架构](./architecture/README.md) |
| 准备让 AI 或开发者改代码 | [全局约束](./governance/global-constraints.md) → [当前架构](./architecture/README.md) → 对应 PRD / Design / ADR |
| 提一个新功能 | [文档治理规则](./governance/documentation-policy.md) → [PRD 模板](./governance/templates/prd-template.md) |
| 做技术方案 | 已批准 PRD → [Design 模板](./governance/templates/design-template.md) → 必要时补 ADR / Spike |
| 开发和调试插件 | [开发工作流](./guides/development-workflow.md) |
| 接入 MCP | [MCP 使用指南](./guides/mcp-usage.md) |
| 查 Mock 模板语法 | [Mock 模板语法](./reference/mock-template-syntax.md) |
| 了解某个历史阶段 | [交付与历史快照](./delivery/README.md) |

## 文档地图

| 目录 | 回答的问题 | 内容是否持续更新 |
| --- | --- | --- |
| [`governance/`](./governance/README.md) | 文档怎么写、全局不能破坏什么 | 是，规则变化时更新 |
| [`product/`](./product/README.md) | 为什么做、为谁做、某次迭代做什么 | 每个 PRD 按生命周期演进 |
| [`architecture/`](./architecture/README.md) | 系统现在如何工作、为什么这样设计 | 当前设计持续更新；ADR 只追加/替代 |
| [`experiments/`](./experiments/README.md) | 某个技术假设是否可行、证据是什么 | 结论形成后冻结 |
| [`guides/`](./guides/README.md) | 用户或开发者如何完成一项任务 | 产品行为变化时更新 |
| [`reference/`](./reference/README.md) | 精确的语法、协议、字段是什么 | 与实现同步更新 |
| [`delivery/`](./delivery/README.md) | 某个时间点完成了什么、接下来计划什么 | 快照冻结；新阶段新增快照 |
| [`planning/implementation/`](./planning/implementation/) | 已明确工作如何拆解和验证 | 每个计划独立维护 |

## 权威性与冲突处理

同一主题出现多个说法时，按下面顺序判断：

1. [`governance/global-constraints.md`](./governance/global-constraints.md) 中的全局约束优先。
2. 已接受且未被替代的 ADR，优先于 Design 中的讨论稿。
3. 已批准/已交付的 PRD，优先于早期调研里的功能设想。
4. Reference 描述当前精确行为；Guide 只解释完成任务的路径。
5. `delivery/snapshots/` 只代表文件日期当天，不作为当前事实源。
6. 仍冲突时，以代码、自动化测试和 `manifest.config.ts` 的可验证行为为准，并立即修正文档。

## 当前有效的核心文档

- 全局边界：[全局约束](./governance/global-constraints.md)
- 架构入口：[架构总览与演进](./architecture/README.md)
- 基线设计：[系统设计](./architecture/system-design.md)
- MCP 设计：[MCP Server](./architecture/mcp-server.md)
- 功能定义：[PRD-0001 AI 协同与虚拟接口](./product/prds/PRD-0001-ai-collaboration-and-virtual-endpoints.md)、[PRD-0002 信息架构重构](./product/prds/PRD-0002-information-architecture.md)

> 注意：2026-08-07 之后的实现变化尚未形成新的项目状态快照。需要判断“现在是否已经实现”时，不要只读旧交接文档，应同时检查代码和测试。
