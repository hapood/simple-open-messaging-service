# SOMS Federation v1 TODO 工作区

本目录存放生成正式 v1 规范前必须分别完成并冻结的任务。这里是工作清单，不是 normative
protocol specification。

## 执行规则

1. 一次执行一个 TODO，不在当前任务中静默扩大范围。
2. 状态按 `OPEN -> IMPLEMENTED -> VERIFIED -> FROZEN` 流转。
3. 代码存在不等于完成；参数、反例、恢复、测试和文档一致后才可 `VERIFIED`。
4. 所有决策唯一且依赖已冻结后才可 `FROZEN`。
5. 跨任务问题必须在双方登记依赖或遗留项。
6. 99 只整合已冻结结论，不负责临时补设计。

## 任务与依赖

| ID  | 任务                                                             | 初始状态 | 依赖         |
| --- | ---------------------------------------------------------------- | -------- | ------------ |
| 01  | [v1 surface 与版本](./01-v1-surface-and-versioning.md)           | OPEN     | 无           |
| 02  | [well-known 与 limits](./02-well-known-and-limits.md)            | OPEN     | 01           |
| 03  | [网络发现安全](./03-network-discovery-security.md)               | OPEN     | 01           |
| 04  | [请求 schema 与参数校验](./04-request-schemas-and-validation.md) | OPEN     | 01           |
| 05  | [响应与错误模型](./05-response-and-error-model.md)               | OPEN     | 01           |
| 06  | [系统事件与生命周期](./06-system-events-and-lifecycle.md)        | OPEN     | 04、05       |
| 07  | [投递恢复与分页](./07-delivery-recovery-and-pagination.md)       | OPEN     | 01、04、05   |
| 08  | [身份丢失与 reset](./08-identity-loss-and-reset.md)              | OPEN     | 03、04、05   |
| 99  | [生成 Federation v1 规范](./99-generate-federation-v1-spec.md)   | BLOCKED  | 01–08 FROZEN |

依赖表示最终冻结关系，不阻止提前调查独立部分。

## 每个工作节点的强制总结

每个节点结束必须记录：检查范围、发现、决策、代码/迁移/测试/文档变更、验证结果、新敞口、
下一节点入口。没有证据的验收项不得勾选。
