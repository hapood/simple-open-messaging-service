# SOMS Federation v1 Message Tombstone Feed

状态：`REVIEW`
规范性：第 1 至 10 节全部为规范性要求；第 11 节明确标为 SOMS 实现说明，不约束其他实现的数据库结构。

本文定义 `GET /s2s/v1/message-tombstone-feed`。消息正文仍是不可变事实；作者撤回和已经生效的治理删除
通过独立、持久、可重放的 tombstone feed 收敛，而不是覆盖 message、修改 `updatedAt` 或依赖易失
feed-head hint 表达。通用身份、签名、成功 envelope 和错误规则见[主协议](./protocol.md)，消息稳定坐标与
`ThreadAddress` 见 [Message](./message.md)。

本文不定义举报提交、治理请求、审核流程或本地客户端删除 API。它只规定 publisher 已经形成一个权威
删除事实后，如何向有权 peer 传播该事实。

## 1. 删除类型、权威与固定拓扑

```ts
type MessageTombstoneType = 'WITHDRAW' | 'REPORT';
```

- `WITHDRAW` 表示作者撤回自己的消息。
- `REPORT` 表示该 thread authority 的举报或治理流程已经产生删除该消息的最终结果。只对举报者隐藏、
  屏蔽或折叠消息的本地展示结果不是 tombstone，不得（MUST NOT）进入联邦。
- 两种类型在接收端都产生相同的消息不可见终态。类型只用于审计和本地产品策略；wire 不携带举报人、
  举报理由、证据或其他治理隐私数据。

权威由 thread 类型决定：P2P 的 `WITHDRAW` authority 是 `target.creator.domain`；群 timeline（包括第三方域
成员 authored message）的删除 authority 始终是 group origin。第三方域成员要撤回群消息时，其 home server
向 origin 提交 `WITHDRAW` 请求；origin 验证作者和目标后形成新的群权威删除事实，再直接分发给 mirrors。
该 submission 不是 mirror 可消费的权威 tombstone，也不是可继续级联的 relay。

mirror 必须（MUST）只接受已知 group origin 发布的群 tombstone，并且不得（MUST NOT）向其他 peer 再发布。
群 origin 只接受目标作者 home server 对本域作者发起的 `WITHDRAW` submission；`REPORT` 只能由 origin 本地
治理产生。v1 不携带成员 home server 的端到端 deletion signature；mirror 验证并信任的是 group origin 的
群 timeline 权威。

## 2. Feed 拓扑与独立 feed-ID 空间

每个 publisher 对每个 recognized peer 提供一条全局、target-allocated tombstone feed。它不是 per-thread、
per-author 或 per-group stream；query 不携带 thread/account 路由参数。同一 peer 的所有 P2P tombstone 和
群 tombstone 都进入这一条 feed。

`message-feed` 与 `message-tombstone-feed` 为每个 pull peer 维护完全独立的 `feedId` 空间、allocator、
allocation upper bound、source-side ACK、retention floor、`lastServedThrough` 和 consumer pull cursor。一个
feed 的 `after`、空洞和确认对另一个 feed 没有含义。协议不规定任一 feed 的初始 ID，也不要求两个 feed
使用相同起点或保持相同步长；Recognize 不交换、猜测或重置 feed cursor。

## 3. 请求、Page 与 closed schema

请求 query：

| 字段      | 类型                               | 规则                                                                             |
| --------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| `after`   | `SignedDecimalString`              | 可选；consumer 已提交的 exclusive tombstone cursor；省略时只返回 `resumeAfter`。 |
| `take`    | `PositiveSafeInteger` query string | 可选；建议的 change 扫描数，不是硬上限。                                         |
| `through` | `SignedDecimalString`              | 可选；inclusive tombstone feed-ID 上界，必须（MUST）大于或等于 `after`。         |

未知 query 字段、重复 query 字段、`+1`、`01`、`-0`、空白、小数、指数、零/负 `take` 或超出安全整数的
`take` 必须（MUST）返回 HTTP `400 FEDERATION_MALFORMED`。语法有效但超过 publisher 偏好页大小的
`take` 不得（MUST NOT）被拒绝；publisher 采用自身能承担的扫描数。

省略 `after` 时不得携带 `take` 或 `through`。source MUST 返回 HTTP `200`
`FEDERATION_FEED_CURSOR_UNAVAILABLE`，data 只含 `resumeAfter`；consumer 原子保存后将它用作下一次请求的
exclusive `after`。省略 `after` 不等于 `after=0`。

该 operation 使用主协议的 `recognized signed` 鉴权。缺少认可、签名失败、binding 失败、peer block、
并发请求和临时服务失败分别使用 errors.md 已注册的
`FEDERATION_RECOGNITION_REQUIRED`、`FEDERATION_BAD_SIGNATURE`、`FEDERATION_BINDING_VIOLATION`、
`FEDERATION_PEER_BLOCKED`、`FEDERATION_FEED_REQUEST_IN_PROGRESS` 和 `INTERNAL`，不得创建 tombstone 专用同义错误码。

成功 envelope 的 `data`：

```ts
interface MessageTombstonePage {
  tombstones: MessageTombstone[];
  scannedThrough: SignedDecimalString;
  hasMore: boolean;
  retryAfterMs?: PositiveSafeInteger;
}

interface MessageTombstone {
  feedId: SignedDecimalString;
  thread: ThreadAddress;
  target: {
    creator: Address;
    originSeq: SafeInteger;
  };
  type: MessageTombstoneType;
  deletedAt: EpochMilliseconds;
}
```

page、item、`target` 和 `thread` 都是 closed object。`ThreadAddress` 与 message 的 `thread` 完全相同。
稳定删除目标是 `(thread, target.creator.account, target.creator.domain, target.originSeq)`；publisher 或
consumer 本地的 message ID、thread ID、`seq`、删除日志 ID 均不得（MUST NOT）出现在 wire target 中。

`deletedAt` 是当前 thread authority 首次提交权威删除事实的时间。成员 home server 的 submission 时间不是
群 mirror 上的权威 `deletedAt`；它不是 consumer 排序、冲突覆盖或 cursor 推进依据。

完整请求与成功响应示例：

```http
GET /s2s/v1/message-tombstone-feed?after=40&take=100&through=52 HTTP/1.1
Host: b.example
Date: Tue, 14 Nov 2023 22:13:20 GMT
Content-Digest: sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:<base64-ed25519-signature>:
```

```json
{
  "code": 0,
  "message": "successful",
  "data": {
    "tombstones": [
      {
        "feedId": "47",
        "thread": {
          "type": "GROUP",
          "account": "!01arz3ndektsv4rrffq69g5fav",
          "domain": "b.example"
        },
        "target": {
          "creator": { "account": "alice", "domain": "a.example" },
          "originSeq": 19
        },
        "type": "WITHDRAW",
        "deletedAt": 1700000000000
      }
    ],
    "scannedThrough": "52",
    "hasMore": false
  }
}
```

## 4. 扫描、分页、ACK 与重试

source 为 tombstone feed 单独维护内部 `retainedAfter`、`acknowledgedThrough`、`lastServedThrough` 和
`allocatedThrough`。每次请求计算：

```text
resumeAfter = max(retainedAfter, acknowledgedThrough)
effectiveStart = request.after
effectiveEnd = allocatedThrough
requestEnd = through is present
  ? max(effectiveStart, min(effectiveEnd, through))
  : effectiveEnd
```

publisher 扫描 tombstone feed-ID 区间 `(effectiveStart, requestEnd]`。已经确认、过滤或未分配的位置可以
形成空洞；message feed 的任何坐标不属于本空间。page 必须满足：

1. `scannedThrough >= effectiveStart` 且 `scannedThrough <= requestEnd`；
2. 每个 `tombstone.feedId` 位于 `(effectiveStart, scannedThrough]` 并严格递增；
3. 新 allocation ID 严格大于该 peer 的 tombstone feed 此前分配的所有 ID，不得复用或倒退；
4. `hasMore: false` 表示本次 `requestEnd` 已连续扫描完成，不表示未来不会产生 change；
5. `hasMore: true` 时 consumer 必须（MUST）保持同一 `through` 并以 `after=scannedThrough` 继续；
6. 没有 tombstone item 时，`scannedThrough` 仍可跨过 message change 和其他空洞；
7. fill 尚未完成但 tombstone `allocatedThrough` 表明窗口中仍可能有工作时，可以返回
   `hasMore: true`、`scannedThrough === effectiveStart` 的空 bridge page，并可以携带
   `retryAfterMs`。consumer 应该（SHOULD）等待该毫秒数后重试。

经过认证且语法有效的 `after=N` 表示 consumer 已经原子提交 tombstone feed 到 `N`；publisher 可以
（MAY）确认并清理 `<=N` 的 tombstone feed change。响应本身不确认 `scannedThrough`；consumer 必须先
提交 page，再用下一次请求的 `after=scannedThrough` 完成 source-side ACK。响应丢失或本地事务失败时，
使用原 `after` 重试，publisher 必须（MUST）返回语义相同的 tombstone 或等价空洞进度。

同一 peer 的并发 tombstone-feed 请求必须（MUST）串行化。无法立即取得该 feed 的 source cursor 锁时，
返回 HTTP `200 FEDERATION_FEED_REQUEST_IN_PROGRESS`，consumer 保持 `after`、短暂退避并重试。

source 只接受 `after === acknowledgedThrough`（重试）或 `after === lastServedThrough`（确认最近一页）；
采用 bootstrap `resumeAfter` 后的首次请求也合法。其他值必须返回
`FEDERATION_FEED_CURSOR_MISMATCH`，不得推进 allocator、ACK 或 retention floor。consumer 不得主动
fast-forward。

## 5. Durable source、allocation 与 crash recovery

权威删除事实必须（MUST）先持久提交，之后才可被 feed fulfiller 分配。目标 message 已存在时，删除事务
至少原子提交其删除终态和本地持久删除事实；权威 tombstone 先于 message 到达时，则原子提交 unmatched
pending fact。它不需要同步等待所有远端 peer allocation；这一点与 message feed 的 post-commit fulfiller 相同。

publisher 必须（MUST）从 durable tombstone、per-peer source scan progress 和未确认 allocation 重建尚未
完成的投递。进程内通知、内存 buffer 和 feed-head hint 都只能加速，不能成为唯一发现路径。post-commit
hook 丢失、进程在删除提交后崩溃或内存 buffer 丢失时，启动、请求触发或周期 fulfiller 必须重新扫描并
补充分配，且不能越过尚未检查的前序 tombstone。

为一个 peer 分配 feed ID 和 append memory buffer 必须（MUST）在同一个 per-peer 串行域内完成。source
scan progress 只记录已经检查并形成 durable allocation 的本地 deletion 位置，不得越过未处理事实。每个
尚未确认的 `(peer, feedId, stable target)` allocation 必须持久保存；崩溃后以相同 `feedId` 重建 buffer，
不得给同一未确认事实重新分配新 ID。buffer 满时停止继续扫描该 peer，等 ACK 释放容量后从持久 source
progress 恢复；不得淘汰未确认 tombstone。

tombstone allocator 的推进会使 `tombstoneFeedEndId` 前进。只有 allocation 与其稳定 target 已持久提交，
才能发布对应 feed-head hint；不能先广播 feed head 再提交可恢复状态。

## 6. P2P、群提交与权威分发

tombstone 路由由 thread authority 和服务器持有的 thread/mirror 关系决定，不使用成员级历史边界。接收端
可能先收到 tombstone、后收到 message，或者始终没有目标 message；这三种情况都必须安全且幂等。对于
P2P consumer 和 group mirror，没有目标 Message row 的权威 tombstone 是正常 pending fact，不授权创建
thread、成员或可见消息。group origin 收到的成员 submission 不是权威事实：目标不存在时必须拒绝，不能
保存为 pending tombstone。

传播规则：

- P2P：作者 home server 直接向对端 peer 分配权威 tombstone；其他服务器不得发布该 P2P target。
- 群 submission：第三方成员 home server 只向 group origin 提交本域作者的 `WITHDRAW` 请求。origin 必须
  已有目标群消息并验证作者；submission 本身不向 mirrors 扩散。
- 群权威分发：origin 提交群删除事实后，直接向持有该群 mirror 的相关 peer 分配 tombstone。作者 home
  server 若也是 mirror，会和其他 mirror 一样从 origin 收到权威结果。
- mirror：只应用 origin 的 tombstone，绝不调用 outbound tombstone fanout，也不向其他 peer 级联。

群 origin 必须保留足够的 inactive thread identity shell 和 target identity，使成员离开或群解散后仍可验证
未完成 submission 和投递。管理员执行 destructive federation reset 时，相关 shell、cursor 和 pending
tombstone 的清理遵循 reset generation；reset 前已发出的异步 page 不得跨 generation 写入。

## 7. Consumer 校验、事务与竞态

consumer 收到 page 后必须（MUST）先完成以下校验：

- page closed schema、cursor 范围和 item 顺序有效；
- thread 可以映射到已有 P2P thread 或群 identity shell；tombstone 本身不得创建用户、thread 或 membership；
- P2P consumer 收到的 source domain 等于 `target.creator.domain`，且 creator 是该 P2P thread participant；
- group mirror 收到的 source domain 必须等于该群已知 origin；第三方 creator domain 不能直接向 mirror
  发布该群 tombstone；
- group origin 接收成员 submission 时，source 必须等于 `target.creator.domain`，type 必须是 `WITHDRAW`，
  且 origin 已持有由该 creator authored 的目标群消息；
- page 所属 peer identity/reset generation 在网络请求开始后没有改变。

任一 item malformed、越权、无法映射或与已有稳定事实冲突时，整个 page 及 cursor 必须（MUST）回滚并
记录审计错误；不得跳过坏 tombstone 后继续推进，因为这会永久保留本应删除的消息。资源暂时不可用不是
item malformed，应按本地可恢复任务处理。

校验完成后，consumer 必须（MUST）在同一事务中：

1. 按稳定 target 串行化 message/tombstone 写入；
2. 对权威 tombstone，目标 message 尚不存在时幂等保存 pending tombstone；已存在时直接物化删除，不保留
   重复 pending fact；group origin 对不存在目标的成员 submission 必须拒绝；
3. 若 message 已存在，将其标为删除并更新依赖的本地投影；
4. 将该 target 尚未完成的媒体本地化转为不可自动复活的 tombstoned 终态；
5. 把 tombstone pull cursor 推进到 page 的 `scannedThrough`；
6. 再次验证 peer reset generation，防止旧响应跨 reset 提交。

消息插入和媒体 promote 必须（MUST）取得同一个稳定 target 串行化门禁，因此两种到达顺序都收敛：

1. message 先到：随后到达的 tombstone 将它标为删除并撤销其资源授权；
2. tombstone 先到：consumer 保存 born-deleted fact，后来到达或重放的 message 只能幂等落为删除，不能
   短暂显示，也不能启动或 promote 新媒体下载。

对于权威 tombstone，删除目标暂时没有 Message row 不是错误，也不得阻止 cursor 推进。若 target 已存在 tombstone：语义相同
的权威重放是 no-op；`deletedAt` 或 `type` 不同仍保持不可见终态，但必须（MUST）视为权威事实
冲突、回滚当前 page 并审计，不能使用先到、后到或时间大小覆盖。

## 8. 本地可观察删除结果

成功提交 tombstone 后，任何普通消息读取、搜索、会话预览、未读/mention 计算、通知补发、quote resolve
或 forward-bundle 授权都不得（MUST NOT）把 target 当作 live message。客户端可以不显示占位；具体 UI
不是联邦协议要求。

实现必须（MUST）在同一删除事务中更新依赖正确性的投影，或持久登记可恢复的投影重建任务。至少包括
thread last-message/preview、消息搜索可见性和本地客户端 deletion log。SSE/WebSocket 等实时通知只是
唤醒；客户端仍通过本地持久删除源恢复。

## 9. 媒体、资源授权与共享 CAS

tombstone 提交后，publisher 必须（MUST）停止以目标 message 授权新的 media 或 forward-bundle 请求。
授权检查必须读取 durable message/tombstone 状态，不能只依赖尚未刷新的缓存。已经发出 response header 的
in-flight byte stream 可以结束或中断；这不改变后续请求已经失去授权的事实。

consumer 必须（MUST）停止目标 message 尚未完成的资源下载和 promote。部分 CAS bytes、断点信息和失败
诊断可以保留，以便其他 live message 复用。一个 digest 被 tombstone 引用不等于该 CAS asset 被删除；只要
另一个 live、authorized message 仍引用它，就不得（MUST NOT）删除共享 bytes。

## 10. 唤醒、排空、保留与故障

`feed-heads` 分别发布 `stateFeedEndId=S`、`messageFeedEndId=M` 和 `tombstoneFeedEndId=D`。hint 仍然只是
可丢失唤醒；consumer 应冻结三个值为本轮独立 `through`，并按以下顺序排空：

```text
state-feed?through=S -> message-tombstone-feed?through=D -> message-feed?through=M
```

轻量 hint 携带的 `(S, M, D)` 是主协议第 9 节定义的不可拆分 drain barrier。consumer 必须先把 durable
state cursor 提交到 `S`；未达到时不得请求或应用该轮 `M`、`D` 窗口。并发到达的新 hint 可以唤醒下一轮，
但不得改变正在排空的有界窗口。

message 与 tombstone cursor 分别提交到 `M`、`D` 后，本轮 barrier 才排空。排空顺序不能代替
第 7 节的竞态保护；任一 feed 的 page 与自己的 cursor 独立原子提交，一个 feed 失败不得提前推进另一个
feed 的 cursor。没有 hint 时，周期 reconciliation 读取当前 page，仍按相同顺序排空。

publisher 可以物理删除已经被该 peer 的 tombstone ACK 覆盖的 feed allocation，但 durable stable
tombstone 至少保留到以下条件全部成立：所有历史 entitled peer 已确认对应 feed change；所有可能重放
target message 的 source history 已清理；没有 pending media、resource proof 或本地客户端删除恢复需要它。
无法证明条件成立时必须保留。

publisher 不得静默丢弃未确认 tombstone 或把内部 `retainedAfter` 推过未确认位置。若数据库损坏导致无法
重建已经分配但未确认的 tombstone，publisher 必须停止向该 peer 提供 tombstone feed，返回 HTTP
`503 INTERNAL` 并要求运维修复或执行显式 destructive reset；不得伪装成普通空 page 或 cursor 前跳。该
故障使连接可用性进入 `degraded`，不把无过错的远端 identity 标记为 `halted`。

## 11. 非规范性 SOMS 实现映射

SOMS 实现应复用 message feed 的 per-peer mutex 和 owner election，但使用独立 feed-ID allocator、bounded memory buffer、
durable fulfiller/checkpoint、post-commit notification 和启动/请求恢复模型，而不是恢复旧的 per-thread
`message-deletions` HTTP stream。

建议的数据职责如下；表名可以调整：

- `FederationTombstoneServeCursor(peerDomain, allocatedThrough, retainedAfter, acknowledgedThrough, lastServedThrough)`：独立 source-side allocator、retention 与 ACK；
- durable tombstone allocation：保存尚未确认的 `peerDomain/feedId/deletionId` 映射；
- `FederationTombstonePullCursor(peerDomain, committedThrough)`：consumer 已提交 cursor；
- durable tombstone source progress：记录每个 peer 已完成 allocation 的本地 deletion ID，支持重启重建；
- `FederationMessageDelivery(peerDomain, messageId)`：message ACK 后仍保留的精确投递凭据；只凭当前或历史
  thread audience 不能区分 leave/rejoin 之间的不可见区间；
- memory entry：至少保存 `feedId`、stable tombstone ID 和 thread/target 定位；
- pending federated tombstone：只保存尚未匹配本地 Message 的权威删除，对 stable target 唯一，并保存
  authority domain、直接 source domain、原始 authority `deletedAt`、type 和接收时的 reset generation；
  匹配后在同一事务物化 `DeletedMessage` 并物理删除该 pending row。

现有按 `(threadId, peerDomain, streamAccount, streamKind)` 建模的 `FederationDeletedCursor` 属于旧 per-stream
架构，不能直接作为本文全局 feed cursor；实现本文时应迁移或替换。pending federated tombstone 必须保存
thread authority 的 `deletedAt`，不能用 mirror 本地接收时间替代 wire `deletedAt`。

建议的 producer 路径是：本地删除事务提交 `DeletedMessage` 持久事实和业务投影 -> post-commit 通知 fulfiller ->
fulfiller 按 deletion ID 顺序扫描持久删除事实与目标 peer 的 thread/mirror 路由 -> 在 per-peer mutex 下从独立
allocator 分配并持久保存 feed ID 后 append buffer -> 发出 `tombstoneFeedEndId` hint。consumer 后续 ACK 时才更新
durable checkpoint。通知丢失时由启动、周期和请求触发的同一 scanner 补齐。

建议的 consumer 路径是：收到 hint/周期任务 -> 排空 state -> 在 peer 单飞锁下拉 tombstone page -> 在
数据库事务中获取 reset shared lock 与 stable-target advisory lock -> 应用 tombstone、媒体终止和本地
deletion log -> 更新 tombstone pull cursor -> commit 后发送本地 SSE -> 再排空 message feed。任何 post-
commit UI 通知失败都不回滚已提交 tombstone，客户端通过本地删除源恢复。

### 11.1 SOMS 锁域与固定加锁顺序

SOMS 应为每个 peer 只维护一个进程内 `feedMutex`，由 message 与 tombstone 两种 feed 共用。它保护该
peer 的两个 allocator 调用、两个 memory buffer 的 append/retire、loaded/ack checkpoint 内存投影、fill
state，以及两个 feed 的 response snapshot/cache。所有 change array 读取和修改都必须在该 mutex 内；
不得先取得数组引用、释放 mutex，再原地修改。对外返回的 page 使用不可变 entry 或数组浅拷贝，不能把
仍会被 retire/append 的内部数组直接交给 controller/cache。

数据库 stable-target 锁与内存 `feedMutex` 不跨阶段同时持有：

1. producer 删除/插入事务只取得 `reset shared lock -> stable-target advisory lock -> 按需 Message row lock`，
   提交本地持久删除事实或 unmatched pending fact 后释放全部数据库锁；
2. post-commit hook 或 durable scanner 随后取得 `peer feedMutex -> source cursor/allocator DB row lock`，完成
   allocation 与 buffer append；
3. feed serve 同样取得 `peer feedMutex -> source feed cursor DB row lock`，在 mutex 内完成 ACK、retire、
   snapshot 读取和 cache 更新；
4. consumer apply 不取得 source-side `feedMutex`，只按
   `reset shared lock -> stable-target advisory lock -> Message/PendingMedia rows -> pull cursor row` 写数据库；
5. destructive reset 不得在数据库事务中等待 `feedMutex`。它先按 reset 规范提交 generation 变化，再由
   持有 `feedMutex` 的下一次操作在任何 read/serve/append 前观察 generation、清空两个 buffer/cache 并
   重新初始化。

因此全局顺序是“若需要内存锁，则总是先 `feedMutex`、后 source cursor DB lock”；而持有 stable-target、
Message 或 pull-cursor DB lock 的事务永远不等待 `feedMutex`。禁止相反顺序，避免 deletion transaction 与
feed serve/fill 互相等待。

一次操作不得同时持有两个 peer 的 `feedMutex`；群 tombstone fanout 按 peer 分别调度，不能为追求跨 peer
原子性嵌套加锁。持有 `feedMutex` 时不得执行远端 HTTP、SSE 或其他无界外部调用；只允许执行有明确
statement/transaction timeout 的本地数据库操作。consumer pull 的网络单飞锁也不得跨网络请求持有任何
数据库事务或 stable-target lock。

各 feed allocator 的数据库 `UPDATE ... RETURNING` 是 feed ID 唯一性的最终门禁，但不能替代
`feedMutex`：数据库行锁只能保证 ID 不重复，不能保护进程内 array、dedup set、fill state 或 snapshot。
allocator 推进与 allocation 映射必须在同一事务中持久提交；进程在 append 前崩溃时，重启从该映射以相同
ID 恢复。durable ACK checkpoint 只能在 consumer 用后续 `after` 确认对应 buffer entry 时推进，确认后才
可删除映射。

本地 authored message 的 wire `originSeq` 必须使用与 message feed 相同的投影：持久 receipt 尚未写入
`Message.originSeq` 时使用作者 thread-local `seq`；已有 receipt 时使用持久 `originSeq`。删除事务必须在
删除事务必须在锁内冻结这一 stable 值对应的 Message 身份；异步 fulfiller 必须从该持久 Message 与
`DeletedMessage` 关联读取，不能从可能变化的临时 receipt 状态推导。

### 11.2 必须覆盖的实现竞态

| 竞态                                                    | 允许的线性化结果                                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| message serve 已读取 live row，随后删除提交             | 本页可以返回 message；之后 tombstone feed 必须返回删除，consumer 最终不可见。                                                     |
| 删除先提交，message serve 后读取                        | message change 扫描为空洞；tombstone 由 fulfiller 分配。                                                                          |
| tombstone allocation 已持久提交、append 前崩溃          | 重启从 durable allocation 以相同 feed ID 恢复，不得重新分配。                                                                     |
| append 完成、ACK 前进程崩溃                             | 重启从 durable allocation 以相同 feed ID 重放。                                                                                   |
| ACK/retire 与 post-commit append 同时发生               | 同一 `feedMutex` 串行；retire 不能删除尚未进入本次 snapshot 的新 entry，append 后必须按 cache 规则失效或隔离旧 snapshot。         |
| 本地 `WITHDRAW` 与 `REPORT` 同时删除                    | `Message` row/stable-target 锁和唯一 `DeletedMessage(thread, seq)` 决定唯一首个事实；另一事务幂等读取既有终态，不生成第二个删除事实。 |
| 远端 tombstone 与 message insert/media promote 同时发生 | 三条路径取得同一 stable-target advisory lock；后取得者读取前者已提交事实，message 只能 born-deleted，media 不能复活。             |
| reset 与远端 page apply 同时发生                        | reset shared lock、expected generation 与提交前复查共同保证旧 page 要么先完整提交，要么完整回滚，不能跨 generation 部分写入。     |
| 新资源请求与删除同时发生                                | 删除提交前已经通过 snapshot/授权的 in-flight stream 可结束；删除提交后的新授权查询必须看到 tombstone 并拒绝。                     |

`feedMutex` 只能保护一个进程内的 owner。SOMS message feed 已要求每个数据库只有一个 federation memory-
feed owner；tombstone feed 必须复用同一 owner election 和同一 peer mutex registry，不能另起一个独立 owner。
若未来支持多进程共同 serving，必须用数据库 durable queue/row lock 替换该假设，不能假定两个进程的内存
mutex 彼此可见。
