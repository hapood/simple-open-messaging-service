# SOMS Federation v1 Message Tombstone Feed and Query

状态：`REVIEW`
规范性：本文全部为规范性要求。

本文定义墓碑索引型压缩 feed `GET /s2s/v1/message-tombstone-feed` 和按 thread 读取权威
删除事实的 `GET /s2s/v1/message-tombstones`。feed 不携带具体 tombstone，只携带
`thread + tombstoneEndSeq`。

## 1. 删除事实与权威

```ts
type MessageTombstoneType = 'WITHDRAW' | 'REPORT';

interface MessageTombstone {
  deletionSeq: DecimalString;
  thread: ThreadAddress;
  target: {
    creator: Address;
    originSeq: SafeInteger;
  };
  type: MessageTombstoneType;
  deletedAt: EpochMilliseconds;
}
```

`WITHDRAW` 是作者撤回；`REPORT` 是 thread authority 已生效的治理删除。两者均是不可逆的
不可见终态。稳定目标是 `(thread, target.creator, target.originSeq)`。

P2P `WITHDRAW` 的 authority 是 `target.creator.domain`。群消息的权威 publisher 始终是 group origin；
第三方成员 home server 只能向 origin 提交本域作者的 `WITHDRAW`，origin 验证并形成群权威事实后
再分发给 mirrors。`REPORT` 只能由 group origin 的治理流程产生。mirror 不得继续转发。

`deletionSeq` 是 authority 在该 thread 中分配的正整数删除序列，严格递增且不复用。它与 message
`seq`、`originSeq`、feed ID 都是独立坐标。publisher MUST 永久保留权威 tombstone 事实；不得因
容量、时间、peer ACK、好友重加或成员重新入群而丢弃或重置 deletion sequence。

## 2. Tombstone feed

feed 请求参数是可选 `after`、`take`、`through`，其 shape、bootstrap、左开右闭窗口、page 计算、
不维护 source ACK 以及不验证 consumer cursor 单调性的规则，与
[Message Feed 第 1 节](./message-feed.md#1-message-feed) 完全相同。省略 `after` 时返回
`FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter }`；SOMS 新 feed 的起点为 `"0"`。

```ts
interface MessageTombstoneFeedPage {
  items: MessageTombstoneFeedItem[];
  scannedThrough: DecimalString;
  tombstoneFeedEndId: DecimalString;
  hasMore: boolean;
}

interface MessageTombstoneFeedItem {
  feedId: PositiveDecimalString;
  thread: ThreadAddress;
  tombstoneEndSeq: DecimalString;
}
```

stable key 是 `(target peer, thread)`。当该 peer 有权得知的 `tombstoneEndSeq` 严格增加时，source MUST
为它分配新的、全 feed 历史更大的 `feedId`，并用新 item 取代旧 item。相同或更小上界是 no-op。

tombstone feed 是持久压缩索引。source 可删除被新 item 覆盖的旧索引 item，但不得删除任一
当前 thread stable-key 投影，也不得因压缩、历史清理或重启要求 consumer 提高 feed `after`。
更新 item 必须使用更大 `feedId`，不得在 consumer 已可能越过的 ID 上原地改写。

feed item 只是查询发现索引，不是删除事实，不能单独导致本地 message 删除。consumer 原子合并
每个 thread 的最大 `tombstoneEndSeq` 和 feed `scannedThrough`，然后通过 query 取得具体事实。

## 3. Tombstone query

`GET /s2s/v1/message-tombstones` 使用与 message query 完全相同的 P2P/GROUP thread query union，
并使用可选 `after`、`through`、`take`。此处 `after` 和 `through` 属于 thread-local
`deletionSeq` 空间，不是 tombstone feed ID。`take` 和 `through` 只能与 `after` 一起出现；携带
`through` 时必须满足 `through >= after`，否则返回 `400 FEDERATION_MALFORMED`。

省略 `after` 时，source 返回 `FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter }` 而不返回 page。
起点由 source 对该 thread 的授权视图定义；协议不要求为 `0`。由于 tombstone 事实永久保留，
已携带的、语法合法且不大于当前 `tombstoneEndSeq` 的 `after` MUST 可读；source 不得以清理为由
返回更大 `resumeAfter`。明显大于当前 end 的 `after` MAY 获得有效的修正起点。

```ts
interface MessageTombstoneQueryPage {
  tombstones: MessageTombstone[];
  scannedThrough: DecimalString;
  hasMore: boolean;
}
```

查询窗口是 `(after, min(through, currentTombstoneEndSeq)]`，返回项按 `deletionSeq` 严格递增。
`candidates` 是窗口内该 peer 有权获知的全部权威 tombstone；page 前缀、`scannedThrough`、`hasMore`、
空洞和固定 `through` 的计算与 message query 第 2.2 节一致。空页可推进到本请求上界，但不得跳过区间内
存在且该 peer 有权获知的权威事实。

source MUST 在 query 时重新校验 thread authority、目标 peer 是否曾被授予目标消息的可见性，以及
当前 block 和本地策略。feed item 不是授权 proof。权限计算 MAY 幂等物化已有 durable facts 推导的
即时好友/群有效状态，但不得因 GET 本身创建或扩大授权。

实现方配额耗尽时，query MAY 返回 HTTP `200 FEDERATION_QUOTA_EXCEEDED` 和唯一结构化数据
`{ retryAfter }`。consumer 不推进 thread deletion cursor、不改变 peer lifecycle，并至少等待该秒数后重试。
配额阈值、单位、窗口和算法不属于协议，也不得作为结构化字段返回。

## 4. Consumer 应用与竞态

consumer 必须校验 authority binding：P2P source 必须是作者 domain；群 tombstone source 必须是已知 group
origin。第三方成员提交给 origin 的撤回 command 不是 mirror 可应用的权威 query item。

一个 query page 与本地 thread deletion cursor 必须在同一事务中提交。每个 tombstone 按稳定目标幂等应用：

- message 已存在时，使其进入不可见终态，并更新 preview、search、unread、quote、forward 和本地删除日志；
- message 尚未到达时，保存 pending tombstone，阻止后到或重放消息复活；
- 停止目标消息尚未完成的 media/bundle 本地化和新资源授权；
- 已有语义相同事实是 no-op；同一稳定目标的 authority、type 或 `deletedAt` 矛盾必须回滚 page 并审计。

message 插入、media promote 和 tombstone 应用必须共享稳定目标串行化边界。tombstone 先到和 message
先到都必须收敛为相同删除结果。权威 tombstone 的目标暂时不存在不是 query 失败，也不得阻塞
query cursor。

## 5. 与轻量推送的关系

`feed-heads` 仍只携带 `stateFeedEndId`、`messageFeedEndId`、`tombstoneFeedEndId`。consumer 先排空
state feed，再排空 tombstone 和 message 索引 feed，合并其 thread end seq，最后按 thread 调用两个 query。
提示可丢失、重复或乱序；启动和周期 reconciliation 必须直接读取三个 feed。

删除应先于消息正文应用。对同一轮发现的 thread，consumer SHOULD 先把 tombstone query 排空到
`tombstoneEndSeq`，再把 message query 排空到 `messageEndSeq`；即使到达顺序相反，第 4 节的 pending 机制仍必须
保证收敛。
