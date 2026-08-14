# SOMS Federation v1 Message Feed and Query

状态：`REVIEW`
规范性：本文全部为规范性要求。

本文定义消息索引型压缩 feed `GET /s2s/v1/message-feed` 和按 thread 读取消息正文的
`GET /s2s/v1/messages`。feed 只回答“哪个 thread 可查询上界推进了”；权限校验、消息返回和正文保留
策略都在 query operation 发生。消息 schema 见 [Message](./message.md)，通用规则见
[Protocol](./protocol.md)。

## 1. Message feed

### 1.1 请求

query 是 closed 参数集：

| 字段      | 类型                               | 规则                                                                      |
| --------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `after`   | `DecimalString`                    | 可选；exclusive 扫描位置。省略时只查询起始位置，不返回 page。             |
| `take`    | `PositiveSafeInteger` query string | 可选；建议的本页最大 item 数；source MAY 返回更少，但不得返回更多。       |
| `through` | `DecimalString`                    | 可选；inclusive 截断上界，MUST 大于或等于 `after`。连续有界分页保持不变。 |

`take` 和 `through` 只能在携带 `after` 时出现。未知、重复或 malformed 参数返回
`400 FEDERATION_MALFORMED`。`after` 、`through` 和所有 feed 坐标都是非负规范十进制字符串；
feed item ID 为正整数。`0` 是第一个 item 之前的 exclusive cursor，不是 item ID。
`take` 不保证响应一定达到该数量，也不放宽 source 公开的 page-byte 上限；单个合法 feed item 超过
operation 上限时返回 `FEDERATION_PAYLOAD_TOO_LARGE`。

省略 `after` 时，source MUST 返回 HTTP `200 FEDERATION_FEED_CURSOR_UNAVAILABLE`，data 只含
`resumeAfter`。该值由 source 定义；SOMS 新建的 per-peer feed 使用 `"0"`。consumer 必须原子保存它，
再以该值作为 `after` 请求。重新加好友、重新入群或同一 account 的关系 epoch 变化不得使
已保存的 feed cursor 后退、换人或重置。

source 不为 consumer 保存 ACK 或验证 cursor 的单调性。任意位于 `[0, messageFeedEndId]` 的
`after` 都是合法读取位置，包括重复或较旧位置。只有省略 `after` 或者 `after` 明显大于当前
feed end 时，source 才可使用 `FEDERATION_FEED_CURSOR_UNAVAILABLE` 返回有效 `resumeAfter`。
压缩、空洞或历史业务数据清理不得导致 message feed 返回该结果。

### 1.2 Page

```ts
interface MessageFeedPage {
  items: MessageFeedItem[];
  scannedThrough: DecimalString;
  messageFeedEndId: DecimalString;
  hasMore: boolean;
}

interface MessageFeedItem {
  feedId: PositiveDecimalString;
  thread: ThreadAddress;
  messageEndSeq: DecimalString;
}
```

stable key 是 `(target peer, thread)`。`messageEndSeq` 是该 source 对该 thread 当前已提交、可通过
message query 请求的 inclusive thread sequence upper bound，它不是 feed cursor。一个 thread 的上界严格增加时，
source MUST 为该 stable key 分配一个比该 feed 历史所有 ID 都大的新 `feedId`，并用新 item
取代旧 item。相同或更小的 `messageEndSeq` 是 no-op。
`messageEndSeq`、message query 的 `after/through/scannedThrough` 与外层 message `seq` 必须都在
`SafeInteger` 数值范围内；前四者在 wire 上使用十进制字符串，message `seq` 使用 JSON integer。

message feed 是持久压缩索引：source 可以删除被更新 item 覆盖的旧 item，但不得因容量、时间、
重启或 consumer 读取位置删除当前 stable-key 投影。对一个仍可能产生或查询消息的 thread，
当前 item MUST 可从任何合法较旧 `after` 发现。

每一 page 在一个一致 source snapshot 上计算：

```text
requestEnd = through is present ? min(through, messageFeedEndId) : messageFeedEndId
candidates = current items with feedId in (after, requestEnd], ordered by feedId
```

source 返回不超过自身 page 上限的前缀。若还有 candidate，`scannedThrough` 等于本页最后一项
`feedId` 且 `hasMore: true`；否则 `scannedThrough=requestEnd` 且 `hasMore: false`。空 page 也可以直接
推进到 `requestEnd`。所有 item 位于 `(after, scannedThrough]` 且严格递增。

分页之间发生压缩时，新 item 只能获得更大 `feedId`。它可能超过已冻结的 `through`，但必须出现在
后续 feed head 或周期对账中；不得以小于或等于 consumer `after` 的 ID 原地改写而让变更丢失。

consumer MUST 验证 page，原子合并每个 thread 的最大 `messageEndSeq` 并把本地 feed cursor 更新为
`scannedThrough`。feed page 本身不携带消息正文，也不授予读取权限。

## 2. Message query

### 2.1 Thread query union

`GET /s2s/v1/messages` 使用 closed query。通用字段是 `after`、`through` 和 `take`；其中 `after`
可选，`through` 是本次有界排空固定使用的 inclusive `messageEndSeq` 上界，`take` 是建议的最大返回消息数。
`take` 和 `through` 只能在携带 `after` 时出现；携带 `through` 时必须满足 `through >= after`，否则返回
`400 FEDERATION_MALFORMED`。thread 必须为下列
两个互斥 shape 之一：

| mode  | 必需字段                                    | 绑定                                                                         |
| ----- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| P2P   | `type=P2P`, `account`, `peerAccount`        | `account` 由 source domain 托管；`peerAccount` 由已验证 signer domain 托管。 |
| GROUP | `type=GROUP`, `groupAccount`, `groupDomain` | 完整 group Address；source 必须持有该 origin thread 或其授权 mirror。        |

两种 shape 的字段不得混用。请求中的 thread 必须与 feed item 的 `ThreadAddress` 规范化后完全
相同。source 不接受请求方声明的 peer domain；该 domain 只来自验证后的 HTTP Message Signature。

未携带 `after` 表示该 thread query 的 bootstrap。source 返回
`FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter }`，不返回消息。这个起点由 source 根据该 thread、已验证 peer、
当前关系状态和保留策略定义。协议不要求它为 `0`。同一 account 重新建立好友关系或重新入群不会
创建一个较小的 query 坐标空间，也不允许 consumer 用较小 `after` 替换本地已提交位置。
当 thread seq 从 `0` 开始且 seq `0` 仍可查询时，SOMS source 返回 `"-1"`，从而保持 `(after, through]`
并能在首次 query 返回 seq `0`。

### 2.2 Query page

```ts
interface MessageQueryPage {
  messages: FederatedMessage[];
  scannedThrough: DecimalString;
  hasMore: boolean;
}
```

source 在请求开始时读取一致的 `currentMessageEndSeq`，并计算：

```text
queryEnd = through is present ? min(through, currentMessageEndSeq) : currentMessageEndSeq
candidates = 当前 peer 有权读取且正文仍保留、seq 位于 (after, queryEnd] 的消息，按 seq 排序
```

source 返回不超过自身公开 item/page-byte 上限和有效 `take` 的 candidate 前缀，不得跳过前缀中的可查询
消息；source MAY 返回更少，但不得超过请求的 `take`。单条合法消息超过 operation page-byte 上限时返回
`FEDERATION_PAYLOAD_TOO_LARGE`，不得用永久空页跳过它。
若返回后仍有 candidate，`scannedThrough` 等于本页最后一条消息的 `seq` 且 `hasMore: true`；否则
`scannedThrough=queryEnd` 且 `hasMore: false`。不存在 candidate 的空页直接推进到 `queryEnd`。返回消息按
source thread `seq` 严格递增，且均位于 `(after, scannedThrough]`。sequence 中未分配、未向该 peer
allocation 或已有权威 tombstone 的位置是可扫描空洞，不阻止 `scannedThrough` 前进。连续有界分页 MUST
保持最初的 `through` 不变。对同一 snapshot 和同一组参数的重复 GET 必须语义幂等。

source MAY 按公开保留策略清理旧消息正文。当 `after` 早于该 thread 当前可服务的
exclusive floor 时，source MAY 返回 `FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter }`，此时 consumer 只能在
`resumeAfter > after` 时原子采用它。若 `after` 明显超过当前 thread end，source MAY 返回严格更小的有效
`resumeAfter` 纠正越界位置。两种规则只属于各自明确条件，不得用来跳过 message feed。

### 2.3 授权与状态对账

source MUST 在每次 query 时使用 durable 的当前好友、群成员、block、thread authority、历史 allocation
proof 和本地策略重新计算访问结果。feed item 的存在不是授权 proof。当前 P2P 关系或 peer-level 群
audience 无效时，source MUST 返回 `FORBIDDEN`；重新建立同一 account 的关系后，恢复使用原 query 坐标，
不得重置或缩小坐标空间。关系有效时，只能返回该 peer 在历史有效 audience 期间获得 durable allocation
proof 的消息；离开期间未 allocation 的 sequence 是空洞，重新加入不得回填。正文保留策略仍可通过
第 2.2 节的 `resumeAfter` 跳过已清理前缀。

权限计算 MAY 在同一本地事务中物化由已有 durable facts 可确定推导的即时状态，例如过期请求失效、
好友有效性或群 audience 有效性。这种 reconciliation 必须幂等，不得仅因为 peer 发起了 GET 就创建
邀请、接受好友、加入群或扩大当前请求的权限。

consumer 按 `(thread, author, originSeq)` 幂等合并消息。插入或展示任何消息前，必须先应用已查询的
权威 tombstone，防止迟到消息复活。媒体与 forward bundle 继续使用 [Resources](./resources.md) 的
精确消息绑定。

### 2.4 Query 专用暂缓结果

message query 在请求已正确认证且 peer lifecycle 可继续时，可以使用以下 HTTP `200` 业务结果：

- `FEDERATION_QUOTA_EXCEEDED`：实现方为本 operation 定义的配额已经耗尽；只携带 `{ retryAfter }`；
- `FEDERATION_MESSAGE_QUERY_RATE_LIMITED`：当前 signer、thread 或 query budget 请求过频；
- `FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE`：该 thread 的 query materialization、存储或后台
  reconciliation 暂时不能提供一致 page。

三者都 MUST 携带 `{ retryAfter }`，其值是从完整收到响应起计算的非负整数秒。consumer 不得推进 message
query cursor，也不得把 peer 标记为 `degraded`；应在至少等待 `retryAfter` 后按本地有上限、带 jitter 的
策略重试。后两个 code 只用于 `GET /s2s/v1/messages`；通用 quota code 也可由其他 operation 按各自文档
使用。它们不得替代 HTTP `503` 表达整个 federation 服务不可用。
