# 文档治理规则

> 类型：Governance
> 状态：Active
> 更新：2026-08-27

## 1. 目标

这套规则解决三个问题：人和 AI 能快速找到当前有效信息；需求、方案、决策和实验互不覆盖；过时内容保留历史价值，但不会继续冒充当前事实。

本项目借鉴三类成熟实践，但保持轻量：用 [Diátaxis](https://diataxis.fr/) 区分教程、操作指南、参考和解释；用 [ADR](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) 保存重要架构取舍；用 [Rust RFC 生命周期](https://github.com/rust-lang/rfcs#the-rfc-life-cycle) 的思想区分提议、接受和实现。GitHub Docs 的[内容模型](https://docs.github.com/en/contributing/style-guide-and-content-model)也说明了按内容职责建立稳定类型的价值。

## 2. 文档类型与边界

| 类型 | 负责回答 | 不应该包含 | 位置 |
| --- | --- | --- | --- |
| Governance | 全项目长期遵守什么、文档如何维护 | 某个功能的局部需求 | `docs/governance/` |
| Discovery | 为什么值得做、用户和市场是什么 | 当前实现状态 | `docs/product/discovery/` |
| PRD | 为什么做这次迭代、做什么、如何验收 | 详细模块/函数实现 | `docs/product/prds/` |
| Design | 已批准需求如何落到系统、接口和数据 | 产品优先级讨论 | `docs/architecture/` 或功能子目录 |
| ADR | 一个重要技术取舍及其后果 | 完整系统说明、执行清单 | `docs/architecture/decisions/` |
| Spike | 一个不确定假设如何验证、证据和结论 | 已承诺的产品范围 | `docs/experiments/` |
| Guide | 某类读者如何完成一个任务 | 全量字段百科 | `docs/guides/` |
| Reference | 精确、可查的语法/API/配置 | 教学叙事和路线图 | `docs/reference/` |
| Delivery snapshot | 某日的状态、路线图、交接上下文 | 永久有效的当前真相 | `docs/delivery/snapshots/` |
| Implementation plan | 已明确方案的任务拆解和验证顺序 | 需求决策或架构论证 | `docs/planning/implementation/` |

## 3. 生命周期

### PRD

`Draft → In Review → Approved → In Delivery → Delivered → Superseded / Withdrawn`

- PRD 批准后尽量不直接重写已确认的范围；需求改变时记录变更，重大改向新建 PRD 并声明 `Supersedes`。
- `Delivered` 只表示验收标准已经验证，不表示文档永远正确。

### Design

`Draft → Accepted → Implemented → Superseded`

- Design 可以随当前实现更新，但必须在“偏差与后续变更”中记录与原方案不同的地方。
- 涉及系统边界、数据所有权、安全边界、不可逆依赖或长期约束的取舍，额外写 ADR。

### ADR

`Proposed → Accepted → Superseded / Rejected / Deprecated`

- ADR 一旦 Accepted，不重写历史理由；新决策用新 ADR 的 `Supersedes` 关联旧 ADR。
- 小型、局部且容易撤销的实现细节不写 ADR。

### Spike

`Planned → Running → Concluded → Invalidated`

- Concluded 后冻结实验步骤和原始结论。
- 产品或平台变化使证据失效时标记 Invalidated，并新建 Spike，不覆盖旧实验。

## 4. 文档头与命名

每份受生命周期管理的文档至少包含：`类型`、`状态`、`创建/更新日期`、`Owner`、`关联`。若有替代关系，再写 `Supersedes / Superseded by`。

- PRD：`PRD-0001-short-kebab-name.md`
- ADR：`ADR-0001-short-kebab-name.md`
- Spike：`SPIKE-0001-short-kebab-name.md`
- 时间快照：`YYYY-MM-DD-short-kebab-name.md`
- Guide/Reference：使用稳定的语义名称，不加顺序号。

ID 在各自类型内递增，不能复用。文件名使用 ASCII kebab-case，标题和正文可以使用中文。

## 5. 单一事实源

- 全局约束只在 `global-constraints.md` 定义；其他文档引用，不复制出另一套。
- 功能范围和验收标准只在 PRD 定义。
- 当前系统结构在 `architecture/README.md` 和对应 Design 定义。
- “为什么选 A 不选 B”在 ADR 定义。
- 精确语法/API 在 Reference 定义；Guide 应链接 Reference。
- 当前完成度必须来自可验证代码/测试或最新状态记录，不能从旧路线图推断。

可以为了阅读体验写简短摘要，但必须链接权威来源，并明确“摘要不作为规范”。

## 6. 什么时候必须更新文档

| 代码/产品变化 | 必须更新 |
| --- | --- |
| 用户行为、范围或验收标准改变 | PRD 状态/变更记录 + 对应 Guide |
| 模块边界、消息流或数据模型改变 | Architecture/Design；重要取舍补 ADR |
| 权限、隐私、安全边界改变 | Global Constraints + ADR + Guide |
| 模板语法、MCP 工具或配置改变 | Reference + Guide + 对应测试说明 |
| 新技术风险未验证 | 先建 Spike，结论后再批准 Design |
| 一轮交付结束 | 新增带日期状态快照，不覆盖旧快照 |

## 7. AI 协作规则

AI 开始修改前应按顺序读取：`docs/README.md`、全局约束、相关 PRD、相关 Design/ADR、相关 Reference。不得把 `delivery/snapshots/` 的完成度直接当作当前事实。

AI 产出新文档时：先判断类型；从模板创建；使用明确状态；链接上游需求和下游验证；发现文档与代码冲突时，报告冲突并以测试验证，不静默猜测。

## 8. 维护检查

文档变更提交前至少检查：

```bash
rg -n 'docs/(0[1-9]|1[0-3])-' README.md docs src tests mcp-server skills
git diff --check
npm test
```

第一条应无输出；第二条应无空白错误。只改文档时，若不运行完整测试，需要在交付说明中明确。
