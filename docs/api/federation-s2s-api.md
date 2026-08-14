# SOMS Federation S2S API

> 当前 `/s2s/v1` 的非规范性 SOMS 实现参考。规范性 wire contract 以
> [Federation Protocol v1](../federation/spec/v1/protocol.md) 为准。

所有 S2S operation 使用 RFC 9421 HTTP Message Signature。`recognize` 建立双向认可，`healthy` 查询已固定
identity 的可用性，普通数据 operation 需要已收敛的双向认可。

## Endpoints

| Method | Path                         | Purpose                                          |
| ------ | ---------------------------- | ------------------------------------------------ |
| `POST` | `/recognize`                 | 认可一个方向并调度反向认可。                     |
| `POST` | `/healthy`                   | 隐私保护的已认可 peer 可用性查询。               |
| `POST` | `/feed-heads`                | 携带三个独立 feed end ID 的可丢失唤醒。          |
| `GET`  | `/state-feed`                | 读取状态快照型压缩 feed。                        |
| `GET`  | `/message-feed`              | 读取 `thread + messageEndSeq` 压缩索引。         |
| `GET`  | `/message-tombstone-feed`    | 读取 `thread + tombstoneEndSeq` 压缩索引。       |
| `GET`  | `/messages`                  | 按 thread 与 seq 窗口查询消息正文。              |
| `GET`  | `/message-tombstones`        | 按 thread 与 deletion seq 窗口查询权威删除事实。 |
| `POST` | `/call`                      | 瞬时 WebRTC lifecycle/SDP/ICE signalling。       |
| `GET`  | `/users/:account`            | 首次联系的最小公开 identity card。               |
| `GET`  | `/media/:digest`             | 精确消息授权的 CAS Range 下载。                  |
| `GET`  | `/forward-bundles/:bundleId` | 授权的不可变 forward-bundle closure。            |

## 压缩 Feed 共享模型

三个 feed 的 wire 参数均为可选 `after`、`take`、`through`。`after` 是 exclusive，`through` 是
inclusive，窗口是 `(after, through]`。首次 bootstrap 请求不得携带任何 query 参数；也就是说，省略
`after` 时不得单独携带 `take` 或 `through`，source 只返回 `resumeAfter`，不返回 page。SOMS 新建 feed
的起点为 `0`，第一个 item ID 为 `1`。feed ID 为正整数，cursor/end 为非负整数。

source 不为 peer 保存 ACK、最后服务位置或单调验证游标。较旧或重复 `after` 可重读；consumer 自行
原子提交 page 和本地 cursor。三个 feed 都是持久压缩投影，不因历史清理提高最小 `after`。
当 stable key 的当前值推进时，必须分配全 feed 更大的新 `feedId`，不能只在旧 ID 上原地改写。

## State feed

State feed 是 snapshot-bearing compacted feed。它直接携带 `PROFILE`、`MEMBER_PROFILE`、三种方向
intent 和 origin-authoritative `GROUP_META`。consumer 按 stable key 和业务 `revision` 幂等合并；
`feedId` 只用于扫描。

一个群 revision 引用新 member 前，publisher 必须先把对应 `MEMBER_PROFILE` 放入目标 peer 的当前
feed projection，且 member item 的 feed ID 更小。profile 后续更新打破该顺序时，source 重新索引
仍引用它的 group snapshot；相同业务 revision/body 在 consumer 端是 no-op。

当一个 member 对目标 peer 既不再是好友、也不再是任一共同群的成员时，publisher 直接从投影
移除 `MEMBER_PROFILE`，不发布删除 item。consumer 只能在完整排空 state feed 后按最新好友和 roster
做 mark-and-sweep，不得在单页之间清理，也不得删除历史消息的稳定 author Address。

## Message and tombstone discovery

Message feed 的 stable key 是 `(peer, thread)`，item 只含 `feedId`、`thread`、`messageEndSeq`。
Tombstone feed 对称地只含 `tombstoneEndSeq`。两个 end seq 是独立的 thread-local query 坐标，
不是 feed ID。具体 message/tombstone array 只从两个 query operation 返回。

Message query 允许 source 清理旧正文；若请求位置早于可服务 floor，source 可返回更高
`resumeAfter`。Tombstone 事实和 deletion sequence 永久保留，tombstone query 不得以清理为由跳过删除事实。

Query 的 `through` 是一次有界排空固定使用的 inclusive thread-seq 终点，不是 feed ID；连续分页保持同一
值，以免持续写入使单次任务没有终点。Message query 请求过频或暂时无法产生一致 page 时，可分别返回
HTTP `200 FEDERATION_MESSAGE_QUERY_RATE_LIMITED` 或
`FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE`，两者都携带秒级 `retryAfter`，且都不推进 query
cursor、不改变 peer lifecycle。

`/messages`、`/message-tombstones`、`/media/:digest` 和 `/forward-bundles/:bundleId` 均可返回 HTTP `200`
`FEDERATION_QUOTA_EXCEEDED`。其 closed data 只有 `{ retryAfter }`；operation 已提供业务类型上下文，协议不
公开 category、limit、计量单位、窗口或算法。

两个 query 在每次请求时重新计算权限，feed item 不是授权 proof。权限计算可幂等物化已有 durable
facts 推导的即时好友/群有效状态，但不得因 GET 自身创建邀请、接受好友、入群或扩大当前权限。

## Wake-up and drain

```text
POST /feed-heads (S, M, D)
  -> GET /state-feed?after=<stateCursor>&through=S
  -> after state reaches S: GET /message-tombstone-feed?after=<tombstoneFeedCursor>&through=D
  -> GET /message-feed?after=<messageFeedCursor>&through=M
  -> merge per-thread tombstoneEndSeq/messageEndSeq
  -> GET /message-tombstones per changed thread
  -> GET /messages per changed thread
```

hint 可丢失、重复和乱序；三个坐标可分别 max-coalesce。启动与周期 reconciliation 即使没有 hint
也必须按 state、tombstone、message 顺序直接读取三个 feed。索引引用未知 thread 时回滚该索引 page，
重新排空 state feed 后重试。对同一 thread，先应用 tombstone query，再应用 message query；反向到达时
pending tombstone 机制仍必须防止消息复活。

## Calls and resources

`/call` 承载瞬时 WebRTC/JSEP frame；终态通话历史仍是普通 `CALL` message。媒体与 forward bundle
使用精确 message identity 作授权坐标。查询到消息后可先持久 pending media work，再进行可恢复 Range
下载；资源失败不回滚已提交的 message query cursor。
