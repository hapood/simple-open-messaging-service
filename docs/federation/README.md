# SOMS 联邦文档入口

本目录区分正式联邦协议、SOMS 实现审计和历史设计说明。已完成的 Federation TODO 与 roadmap 已在
结论合入正式文档后删除，需要追溯时使用 Git 历史。[Federation v1](./spec/v1/README.md) 是当前实现目标；
feed/query 压缩模型尚在从旧实现迁移。

## 当前应当相信什么

当文档之间出现冲突时，按以下顺序判断当前 SOMS 节点的实际行为：

1. [Federation v1 正式规范](./spec/v1/README.md)；
2. `src/federation/` 中的路由、验证和处理代码；
3. `test/federation*.e2e-spec.ts` 中通过双节点测试验证的行为；
4. [protocol-baseline.md](./protocol-baseline.md) 中从代码和测试提取的实现快照。

正式规范定义“节点必须做什么”；后几项用于确认 SOMS 当前“实际做了什么”。二者冲突时应修复实现
或显式升 major，不能把实现偶然行为写回 v1 覆盖规范。

## 文档分类

| 分类              | 含义                                               | 当前文档                                                                                                                                                  |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline          | 当前 SOMS 实现的审计快照，非独立协议承诺           | [protocol-baseline.md](./protocol-baseline.md)                                                                                                            |
| API closure audit | 逐端点的生产者、消费者、参数、响应、恢复和测试闭环 | [api-closure-audit.md](./api-closure-audit.md)                                                                                                            |
| Design history    | 已落地或已被新规范替代的实现设计                   | [认可与身份连续性](./spec/v1/recognition.md)、[旧有界内存 Message Feed](./memory-message-feed.md)、[旧每 Peer 状态 Feed](./per-peer-state-feed-design.md) |
| Overview          | 当前协议与部署概览                                 | [联邦协议概览](../overview/federation-protocol.md)                                                                                                        |
| API reference     | 当前 S2S 接口速查                                  | [S2S API reference](../api/federation-s2s-api.md)                                                                                                         |
| Specification     | 面向独立实现者的 v1 wire contract                  | [Federation v1](./spec/v1/README.md)                                                                                                                      |

## 整理原则

- 现行协议不得依赖读者把旧端点“脑内映射”为新端点。
- 规范不得引用 NestJS service、数据库表或前端状态作为 wire behavior 的定义。
- `BUILT`、测试状态和内部实现放在 implementation 文档，不进入规范性正文。
- JSON Schema、HTTP manifest、正反测试向量和离线 conformance CLI 与正式正文一起发布；它们不是
  v1 运行时协商的一部分。
- 新发现的实现偏差应直接以正式规范为基准修复；若必须改变 wire contract，则进入新的 URL major。
- 任一 API 只有在请求、响应、错误、恢复和测试全部闭合后，才能标记为 `CLOSED`。

## 机器可读发布制品

[v1 Schema 包](./spec/v1/schema/README.md) 包含完整 JSON Schema、HTTP manifest、
正反向量和固定 HTTP Message Signature 向量。执行 `npm run federation:conformance` 可离线校验发布包
或第三方 JSON。制品从五份正式正文生成，不迁移或兼容已删除的旧端点，也不改变 v1 wire contract。
