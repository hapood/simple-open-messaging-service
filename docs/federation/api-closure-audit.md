# SOMS 联邦 API 闭环审计

> SOMS 协议/实现差距审计，更新于 2026-08-13。端点字段见
> [S2S API](../api/federation-s2s-api.md)，规范要求见
> [Federation v1](../../spec/v1/README.md)。

## 当前闭环

```text
first contact
  → well-known
  → signed Recognize in both directions
  → persist recognition facts and pin root

restart / transient failure
  → Healthy using the pinned certificate cache
  → fresh Recognize only when recognition facts are missing
  → state-feed
  → message/tombstone index feeds
  → per-thread message/tombstone queries

local business transaction
  → mutate fact/snapshot and increment business revision
  → compact per-peer state snapshot / thread end-seq indexes
  → commit
  → lightweight feed-heads wake-up
```

v1 surface、字段、错误和恢复规则已并入[正式协议](../../spec/v1/protocol.md)。下表 `CLOSED` 表示当前
SOMS 实现已有对应生产者、消费者和回归证据；它不表示内部实现不能继续优化。

## Surface 审计

| Endpoint                            | 状态   | 闭环说明                                                                       |
| ----------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `/.well-known/soms`                 | CLOSED | 发布 root/signing identity 和 protocol version；无 capability 分支。           |
| `/s2s/v1/recognize`                 | CLOSED | 单方向事实、反向持久调度、root pin、cursor 初始化与双向收敛。                  |
| `/s2s/v1/healthy`                   | CLOSED | pinned cache 验签、统一 unavailable 隐私响应与 degraded/healthy 恢复。         |
| `/s2s/v1/feed-heads`                | CLOSED | wake-up 可丢、重复、乱序；只 max-coalesce，不持久化为事实。                    |
| `/s2s/v1/state-feed`                | TODO   | 迁移到无 source ACK/cursor 验证，并实现 member omission 与 dependency repair。 |
| `/s2s/v1/message-feed`              | TODO   | 改为 `thread + messageEndSeq` 持久压缩索引。                                   |
| `/s2s/v1/message-tombstone-feed`    | TODO   | 改为 `thread + tombstoneEndSeq` 持久压缩索引。                                 |
| `/s2s/v1/messages`                  | TODO   | 新增 thread message query、实时权限验证与可修正正文 cursor。                   |
| `/s2s/v1/message-tombstones`        | TODO   | 新增永久 tombstone thread query 与 pending-delete 收敛。                       |
| `/s2s/v1/users/:account`            | CLOSED | 仅用于首次显式 profile 查询，不用于 chat-open freshness probe。                |
| `/s2s/v1/call`                      | CLOSED | 临时信令；终态记录走普通 message feed，进程崩溃中的实时信令不保证恢复。        |
| `/s2s/v1/media/:digest`             | CLOSED | Range、精确 message/thread/source-seq/digest ownership、恢复、GC 与墓碑覆盖。  |
| `/s2s/v1/forward-bundles/:bundleId` | CLOSED | closure digest、depth、资源和消息可见性校验。                                  |

关系和群成员变化统一由 state feed 传输；消息发送只依据本地已经收敛的状态，不同步查询远端。

正式规范中的字段 union 由单元测试与代码枚举比对；route manifest、数据库 E2E 和双节点 E2E 分别
验证 surface、事务恢复和互操作闭环。JSON Schema、向量与离线 conformance 工具已经随 v1 发布；
它们不是 endpoint 闭环或运行时互操作的前置条件。
