# SOMS 联邦文档入口

本目录是 SOMS 联邦协议整理工作的唯一入口。当前阶段的目标是冻结现有实现基线，区分协议要求、
SOMS 实现、历史设计和未来计划；这里还不是对外发布的完整互操作规范。

正式 Federation v1 定版前的独立任务位于
[v1-todos/README.md](./v1-todos/README.md)。应逐项完成并冻结，再执行最终规范生成任务。

## 当前应当相信什么

当文档之间出现冲突时，按以下顺序判断当前 SOMS 节点的实际行为：

1. `src/federation/` 中的路由、验证和处理代码；
2. `test/federation*.e2e-spec.ts` 中通过双节点测试验证的行为；
3. [protocol-baseline.md](./protocol-baseline.md) 中从代码和测试提取的快照；
4. 现有 overview、API 和 roadmap 文档。

这个顺序只用于确认“当前实现是什么”，不代表当前代码天然就是未来协议规范。正式规范建立后，
规范和机器可读 schema 将成为协议行为的权威来源，代码必须通过一致性测试证明符合规范。

## 文档分类

| 分类              | 含义                                               | 当前文档                                                                                                                                                   |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline          | 当前 SOMS 实现的审计快照，非独立协议承诺           | [protocol-baseline.md](./protocol-baseline.md)                                                                                                             |
| API closure audit | 逐端点的生产者、消费者、参数、响应、恢复和测试闭环 | [api-closure-audit.md](./api-closure-audit.md)                                                                                                             |
| Known conflicts   | 已确认但尚未裁决的文档或实现差异                   | [known-conflicts.md](./known-conflicts.md)                                                                                                                 |
| Pending design    | 已裁决、等待逐步实现和审核的下一版设计             | [节点身份连续性与持久消息发现](./identity-and-durable-discovery-design.md)、[每 Peer 状态 Feed](./per-peer-state-feed-design.md)                            |
| Overview          | 概念、设计解释和部分部署说明                       | [旧版协议与部署指南](../overview/federation-protocol.md)                                                                                                   |
| API reference     | 当前接口速查，仍需与 baseline 对齐                 | [旧版 S2S API reference](../api/federation-s2s-api.md)                                                                                                     |
| Historical design | 已实施阶段的设计背景，不具现行规范效力             | [Step 2](../roadmap/federation-step2-design.md)、[Step 3](../roadmap/federation-step3-design.md)、[API review](../roadmap/federation-api-design-review.md) |
| Roadmap           | 尚未形成协议承诺的未来工作                         | `docs/roadmap/` 中明确标为 planned/deferred 的内容                                                                                                         |

## 整理原则

- 现行协议不得依赖读者把旧端点“脑内映射”为新端点。
- 规范不得引用 NestJS service、数据库表或前端状态作为 wire behavior 的定义。
- `BUILT`、测试状态和内部实现放在 implementation 文档，不进入规范性正文。
- 新的 wire contract 最终使用 JSON Schema 表达，并配套正反测试向量。
- 尚未裁决的差异进入冲突清单，不通过悄悄改文档来改变协议。
- 任一 API 只有在请求、响应、错误、恢复和测试全部闭合后，才能标记为 `CLOSED`。

## 下一阶段

基线通过维护者确认后，下一步是建立 `specification/v0.1/`，先定义术语、版本、发现、签名、
通用数据类型和错误模型，再逐项迁移端点。迁移完成前，现有文档保留，不批量删除历史信息。
