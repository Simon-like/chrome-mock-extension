# 可行性实验（Spikes）

| ID | 问题 | 状态 | 结论 |
| --- | --- | --- | --- |
| [SPIKE-0001](./SPIKE-0001-main-world-interception.md) | MAIN world 注入能否在真实业务站点稳定拦截 | Concluded | 可行；形成注入时机、包装层与失败回退约束 |
| [SPIKE-0002](./SPIKE-0002-dynamic-response.md) | 动态 JS 能否在目标站点 CSP 下工作 | Concluded | 目标站点可行；能力仍受站点 CSP 约束 |

Spike 只解决不确定性，不承诺产品范围。新实验从 [Spike 模板](../governance/templates/spike-template.md) 创建；平台或环境变化导致旧证据失效时，新建实验并标记旧结论 Invalidated。
