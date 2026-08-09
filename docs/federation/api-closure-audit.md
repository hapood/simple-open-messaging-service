# SOMS 联邦 API 闭环审计

> 当前实现审计，更新于 2026-08-09。端点字段见
> [S2S API](../api/federation-s2s-api.md)，剩余验收项见
> [重构清单](./refactor-followup-checklist.md)。

## 当前闭环

```text
first contact
  → well-known
  → ignite + pin identity

restart / transient failure
  → identity continuity proof
  → signed ping restores an existing demoted trust edge
  → state-feed
  → message-feed

local business transaction
  → mutate fact/snapshot and increment business revision
  → compact per-peer state item / allocate discovery change
  → commit
  → lightweight feed-rev wake-up
```

## Surface 审计

| Endpoint | 状态 | 闭环说明 |
| --- | --- | --- |
| `/.well-known/soms` | IMPLEMENTED | 发布 root/signing identity；仍需正式 capability schema。 |
| `/s2s/ignite` | IMPLEMENTED | 首次 pin identity 与 cursor 初始化原子完成；不用于身份丢失后的重建。 |
| `/s2s/identity` | IMPLEMENTED | nonce、fingerprint、epoch、pairwise identity 连续性验证。 |
| `/s2s/ping` | IMPLEMENTED | demoted peer 的唯一恢复数据面；原 key 验签成功才恢复 trusted。 |
| `/s2s/feed-rev` | IMPLEMENTED | wake-up 可丢/重复/乱序；只 max-coalesce，不持久化为事实。 |
| `/s2s/state-feed` | IMPLEMENTED | page/cursor 原子应用、key compaction、防回退、state-first。大页边界矩阵仍扩充中。 |
| `/s2s/message-feed` | IMPLEMENTED | durable discovery、分页 cursor、重启恢复；删除矩阵仍扩充中。 |
| `/s2s/users/:account` | IMPLEMENTED | 仅用于首次显式 profile 查询并落本地库，不用于 chat-open freshness probe。 |
| `/s2s/call` | IMPLEMENTED | 临时信令；终态消息走普通 message feed。进程崩溃中的实时信令不保证恢复。 |
| `/s2s/get_file` | IMPLEMENTED | Range、digest、thread/message 授权；并发/GC/墓碑矩阵仍扩充中。 |
| `/s2s/forward-bundles/:bundleId` | IMPLEMENTED | closure digest/depth/可见性校验。 |

## 已关闭的旧路径

以下路径不再属于 v1 surface，也不兼容：

- `/s2s/init`
- `/s2s/invite`、`/s2s/invite-accept`、`/s2s/invite-revoke`
- `/s2s/thread-access`
- `/s2s/users/:account/revision`
- group roster/meta revision probe
- `/s2s/new-msg-map`
- thread 级 `/s2s/messages` 与 `/messages/before`
- `/s2s/miss-feed`
- 客户端 `sync-peer-profile`、群 `sync-meta` 和 chat-open probe

关系和群成员变化统一由 state feed 传输；消息发送只依据本地已经收敛的状态，不同步查询远端。

## 仍未 CLOSED 的共同原因

- 尚未发布第三方可消费的严格 JSON Schema 与 capability negotiation。
- 字段级 fuzz/未知字段/Unicode 和最大字节矩阵未全部覆盖。
- 媒体终止、共享 digest、临时分块 GC 与管理员物理删除矩阵未全部完成。
- 群踢人、最后 peer member、重新加入等交付边界仍需完整 E2E 矩阵。

因此当前端点最高标记为 `IMPLEMENTED`，不宣称第三方协议规范已经 `CLOSED`。
