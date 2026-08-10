# SOMS 联邦 API 闭环审计

> 当前 SOMS 实现审计，更新于 2026-08-10。端点字段见
> [S2S API](../api/federation-s2s-api.md)，规范要求见
> [Federation v1](./spec/v1/README.md)。

## 当前闭环

```text
first contact
  → well-known
  → ignite + pin identity

restart / transient failure
  → identity continuity proof
  → identity proof restores an existing demoted trust edge
  → state-feed
  → message-feed

local business transaction
  → mutate fact/snapshot and increment business revision
  → compact per-peer state item / allocate discovery change
  → commit
  → lightweight feed-revisions wake-up
```

v1 surface、字段、错误和恢复规则已并入[正式协议](./spec/v1/protocol.md)。下表 `CLOSED` 表示当前
SOMS 实现已有对应生产者、消费者和回归证据；它不表示内部实现不能继续优化。

## Surface 审计

| Endpoint                                       | 状态   | 闭环说明                                                                      |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| `/.well-known/soms`                            | CLOSED | 发布 root/signing identity 和 protocol version；无 capability 分支。          |
| `/s2s/v1/ignite`                           | CLOSED | 首次 pin identity 与 cursor 初始化原子完成；不用于身份丢失后的重建。          |
| `/s2s/v1/identity`                         | CLOSED | nonce、fingerprint、pairwise identity 连续性、demotion 与管理员原 pin 恢复。 |
| `/s2s/v1/feed-revisions`                   | CLOSED | wake-up 可丢、重复、乱序；只 max-coalesce，不持久化为事实。                   |
| `/s2s/v1/state-feed`                       | CLOSED | 完整五类状态、page/cursor 原子应用、key compaction、防回退、state-first。     |
| `/s2s/v1/message-feed`                     | CLOSED | 完整消息类型、durable discovery、分页 cursor、回执、relay 与重启恢复。       |
| `/s2s/v1/users/:account`                   | CLOSED | 仅用于首次显式 profile 查询，不用于 chat-open freshness probe。              |
| `/s2s/v1/call`                             | CLOSED | 临时信令；终态记录走普通 message feed，进程崩溃中的实时信令不保证恢复。       |
| `/s2s/v1/media/:digest`                    | CLOSED | Range、精确 message/thread/source-seq/digest ownership、恢复、GC 与墓碑覆盖。 |
| `/s2s/v1/forward-bundles/:bundleId`        | CLOSED | closure digest、depth、资源和消息可见性校验。                                 |

关系和群成员变化统一由 state feed 传输；消息发送只依据本地已经收敛的状态，不同步查询远端。

正式规范中的字段 union 由单元测试与代码枚举比对；route manifest、数据库 E2E 和双节点 E2E 分别
验证 surface、事务恢复和互操作闭环。JSON Schema、向量与离线 conformance 工具已经随 v1 发布；
它们不是 endpoint 闭环或运行时互操作的前置条件。
