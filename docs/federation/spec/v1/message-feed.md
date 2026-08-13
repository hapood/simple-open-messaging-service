# SOMS Federation v1 Message Feed

状态：`REVIEW`
规范性：本文全部为规范性要求，除非段落明确标记为“非规范性实现说明”。

本文定义 `GET /s2s/v1/message-feed` 的请求、page、扫描和确认语义。message/content schema 见
[Message](./message.md)，资源 operation 见 [Resources](./resources.md)；通用身份、签名、错误和
cursor 规则见 [主协议](./protocol.md)。

## 1. 请求与 Page

请求 query：

| 字段          | 类型                               | 规则                                                                                                                                           |
| ------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `after`       | `SignedDecimalString`              | 可选；consumer 已提交的 exclusive cursor。省略时 source 返回 `FEDERATION_FEED_CURSOR_UNAVAILABLE` 及当前可用起点，不返回 page。                |
| `take`        | `PositiveSafeInteger` query string | 可选；consumer 建议的本页 change 扫描数，不是硬上限。source SHOULD 参考该值，但 MAY 根据当前服务能力采用不同扫描数；省略时完全由 source 决定。 |
| `through`     | `SignedDecimalString`              | 可选；inclusive 扫描上界，MUST 大于或等于请求中的 `after`。                                                                                    |
| `excludeSelf` | boolean string                     | 可选；仅允许 `true` 或 `false`，默认 `false`。为 `true` 时不返回由当前 pull peer authored 的 message。                                         |

`after`、`through` 和 `feedId` 都使用有符号 BigInt 规范十进制字符串。负数仅是 wire grammar 兼容值，
不具有 bootstrap 或哨兵语义。协议不规定 feed 的初始 ID，也不要求 ID 连续；source 只须保证同一
`(source, pull peer, feed)` 空间内严格递增且永不复用。规范形式为 `0` 或可选负号加非零开头的十进制数字；禁止 `+1`、
`01`、`-0`、空白、小数和指数形式。

source peer 为每个 pull peer 维护以下内部坐标：

- `retainedAfter`：source 仍可服务的 retained-history exclusive floor；只用于解释内部状态，不是 wire 字段。
- `acknowledgedThrough`：source 已观察到 consumer 确认的 exclusive cursor。
- `allocatedThrough`：该 feed 曾分配的最大坐标；它是单调的 source allocation
  upper bound，包含未分配空洞，不等于“最后一条可返回 message”。

`resumeAfter = max(retainedAfter, acknowledgedThrough)` 是当前可恢复的 exclusive cursor。它只在
`FEDERATION_FEED_CURSOR_UNAVAILABLE` 的结构化错误数据中暴露；`retainedAfter` 和 `allocatedThrough`
均不是 wire 字段。数据过期、故障恢复或状态修复可以让 `retainedAfter` 向前跳变；正常确认只推进
`acknowledgedThrough`。本 operation 不使用未限定含义的 `startId`、`endId`、`changeId` 或 `HWM`。

source 对每个请求计算：

```text
resumeAfter = max(retainedAfter, acknowledgedThrough)
effectiveAllocatedThrough = allocatedThrough
requestEnd = through is present
  ? max(request.after, min(effectiveAllocatedThrough, through))
  : effectiveAllocatedThrough
```

若 `request.after < resumeAfter`，source MUST 返回 HTTP `200`、业务码
`FEDERATION_FEED_CURSOR_UNAVAILABLE`，并只携带 `resumeAfter`。source 不得把缺失区间伪装成普通成功
page。consumer 验证该值相对本地 cursor 严格前进后，必须在一个本地事务中采用它，再以
`after=resumeAfter` 继续。本错误只报告不可再使用的
旧 cursor，不要求全量同步。

若请求省略 `after`，source MUST 使用同一个错误码和 data shape 返回当前 `resumeAfter`。这只是首次发现或本地 cursor 丢失时的 bootstrap 查询；consumer
不得把省略 `after` 当作 `after=0`，也不得在收到该业务结果前猜测起点。带有 `after` 但其值不是规范十进制
字符串仍返回 HTTP `400 FEDERATION_MALFORMED`。省略 `after` 的 bootstrap 请求不得携带 `take`、
`through` 或 `excludeSelf`；这些字段没有可扫描窗口，携带时同样返回 `FEDERATION_MALFORMED`。

成功 envelope 的 `data`：

```ts
interface MessageFeedPage {
  messages: FederatedMessage[];
  scannedThrough: SignedDecimalString;
  hasMore: boolean;
  retryAfterMs?: PositiveSafeInteger;
}
```

`scannedThrough` 是本页连续扫描完成的位置。pull peer 只有在本页的 message 处理结果与 cursor
一起提交后，才能把它作为下一次请求的 `after`。请求开始时的 `requestEnd` 决定本次可扫描窗口。
响应前 source MAY 因 fill 观察到同一窗口内更多工作，因此最终判断为：

```text
latestRequestEnd = through is present
  ? max(request.after, min(max(request.after, latestAllocatedThrough), through))
  : max(request.after, latestAllocatedThrough)
hasMore = scannedThrough < max(requestEnd, latestRequestEnd)
```

这里的 `latestAllocatedThrough` 是响应前最后一次观察到的 allocation upper bound。`through` 仍是硬上界；post-fill 发现
`through` 之后的工作不得令本次有界请求返回 `hasMore: true`。若没有 post-fill 变化，上式退化为
`scannedThrough < requestEnd`。

`take` 只表达期望扫描的 change 数，不限制返回 message 数，也不构成 page schema 不变量。source
可以因容量、负载和公平调度扫描少于或多于该建议值。已删除、过滤或未分配的位置可以形成空洞；
即使 `messages` 为空，`scannedThrough` 仍可推进。语法有效的 `take` 不得仅因超出 source 偏好的页大小
而被拒绝；source 应选择自身能够承担的扫描数。零、负数、非规范十进制或超出 `PositiveSafeInteger`
范围仍是 malformed query。

`excludeSelf` 只过滤 response 的 `messages[]`，不从 feed ID 空间移除 allocation，也不改变
`scannedThrough` 或 `hasMore`。这里的 self 由已认证 peer domain 判断，即
`message.author.domain === authenticatedPeer.domain`。同一次排空的后续分页 SHOULD 保持相同值。
启用过滤表示 pull peer 主动放弃 self-authored delivery receipt，以及 source 为该副本生成的
`seq/createdAt/updatedAt`。

过滤发生在扫描之后。例如本页扫描的全部 change 都由 pull peer authored 时，publisher 返回
`messages: []`，但仍返回已经推进的 `scannedThrough`。只要该请求窗口尚未扫描到 `requestEnd`，
`hasMore` 就是 `true`，pull peer MUST 使用 `after=scannedThrough` 继续请求；不得因为空数组停止。

### 1.1 确认与重试

source 只接受 `after` 等于 `acknowledgedThrough`（重试）或 `lastServedThrough`（确认最近一页）；采用
`resumeAfter` 后的首次请求也视为合法。其他位置必须返回 `FEDERATION_FEED_CURSOR_MISMATCH`，不得推动
allocator、retention floor 或 ACK。source 接受合法的 `after=N` 后，才可把 `<=N` 视为 pull peer 已确认。
协议不保证已确认位置之后还能再次拉取；实现可以按本地需求延长保留时间。v1 不允许 consumer 主动
fast-forward，也不另设 reset operation。

接收 page 本身不确认 `scannedThrough`。pull peer 必须先提交本页，再通过下一次请求
`after=scannedThrough` 完成确认。响应丢失或本地事务失败时，pull peer 使用原 `after` 重试，
source 必须以相同 `feedId` 重放尚未确认的消息，除非 source 的 `retainedAfter` 已因过期或故障向前跳变。

确认后 source 可以删除用于重放正文的 allocation，但若后续 tombstone 的授权取决于该 message 是否曾向
此 peer 投递，source 必须继续保存等价的精确投递凭据，直到对应 Message 可被安全物理清理。不得只凭
“该 peer 曾经属于 thread audience”推断，因为退出后重新加入会形成不可见的消息区间；也不得向未收到
目标 message 的 peer 暴露 tombstone 的 creator/originSeq。

### 1.2 Page 不变量

每个成功 page 必须满足：

1. `scannedThrough >= after`，pull peer 的 durable cursor 永不后退。
2. 每个 `message.feedId` 位于 `(after, scannedThrough]`，并严格递增。
3. 同一 `(source, pull peer)` feed 的新 allocation ID MUST 严格大于该 feed 此前分配的所有 ID；ID 可以
   有空洞，但不得复用或倒退。
4. `hasMore: true` 时通常有 `scannedThrough > after`。若 fill 发现后续工作但当前 page 尚未扫描它，
   允许返回 `scannedThrough === after` 的 fulfill bridge page，且不限制连续次数。
5. `hasMore: false` 表示本次请求快照已扫描完成，不表示未来不会产生新 change。
6. `through` 存在且未被较新的 `retainedAfter` 越过时，message 和 `scannedThrough` 不得超过 `through`。

pull peer 不持久维护 source 的 `allocatedThrough`。除正常 page 的 `scannedThrough` 外，它只在
有效的 `FEDERATION_FEED_CURSOR_UNAVAILABLE` 后持久化 source 返回的 `resumeAfter`。

### 1.3 Fill 与空队列衔接

source 完成本页后还会按实际确认 cursor 再清理和 fill。若此时在 `through` 允许的窗口内发现内部
`latestRequestEnd > scannedThrough`，本页 MUST 返回 `hasMore: true`，即使本页扫描时队列为空且
`messages: []`、`scannedThrough === after`。pull peer MUST 遵循 `hasMore` 使用同一个 `after`
继续请求。协议不限制连续 fulfill bridge page 的次数。

上述空 fulfill bridge page MAY 返回正整数 `retryAfterMs`，建议 pull peer 至少等待对应毫秒数再重试。
它只是负载提示，不改变 cursor、确认或重试语义。其他 page SHOULD 省略该字段。

### 1.4 非规范性 SOMS fulfiller 与 cache 说明

SOMS source 收到请求后，先按请求的 `after` 清理已确认的内存 change，再从 durable
message/audience 状态向进程单例 fulfiller 发出补充事件，但 HTTP 请求不等待 fill。fulfiller 对单个 peer
串行，并以有界 quantum 在 peer 间 round-robin；未追平的 peer 回到队尾，避免大 backlog 长时间占用
跨 peer 并发槽。

SOMS 可以按完整参数 `(after, take, through, excludeSelf)` 缓存当前内存 change 引用数组的
浅拷贝。参数完全一致的重试可复用该快照；任一参数不同必须重新读取 buffer。空数组不得长期缓存，
否则 fulfiller 完成后相同请求会看不到新数据。确认导致 retire 时必须使相关快照失效。

### 1.5 Consumer 排空算法

1. 若尚无 durable cursor，可省略 `after` 获取结构化起点；否则必须携带 durable cursor，并按需携带
   `take`、`through`。
2. 收到 `FEDERATION_FEED_CURSOR_UNAVAILABLE` 时，验证其 closed data 与单调性，原子采用
   `resumeAfter`，并从该位置继续。
3. 收到成功 page 时，校验 page schema、feed ID 顺序和 page 不变量。
4. 在本地事务中应用 message，并把 durable cursor 更新为 `scannedThrough`。
5. `hasMore: true` 时继续请求；有界排空保持相同 `through`。
6. `hasMore: false` 时结束本轮，等待 feed-head hint 或周期轮询。

### 1.6 示例

负数 cursor 语法仍兼容，但不代表“首次请求”；若它早于 source 的可用位置，会得到结构化 cursor 错误：

```http
GET /s2s/v1/message-feed?after=-5&take=100
```

```json
{
  "code": 50019,
  "message": "requested cursor is below the retained floor",
  "data": { "resumeAfter": "220" }
}
```

有界排空：

```http
GET /s2s/v1/message-feed?after=120&take=100&through=500
```

示例响应：

```json
{
  "messages": [],
  "scannedThrough": "220",
  "hasMore": true
}
```

提交后继续：

```http
GET /s2s/v1/message-feed?after=220&take=100&through=500
```

若请求 `after=220` 时 source 的 retained floor 已推进到 `450`，source 返回
`FEDERATION_FEED_CURSOR_UNAVAILABLE` 和 `resumeAfter: "450"`。consumer 验证并提交新 cursor 后，再以
`after=450` 请求。

## 2. Message item

`messages[]` 的外层结构、全部 `contentType`、各类型处理方式、`seq/originSeq`、服务器落库时间
以及附件拉取规则统一定义在 [Message](./message.md)。

consumer MUST 按 Message 规范逐项校验和幂等应用。单条 message 或后续资源处理失败不得永久阻塞
同页其他 message 或 feed cursor；丢弃、记录、占位和人工修复属于 consumer 本地策略。媒体 bytes 使用
[媒体资源 operation](./resources.md#31-operation-与精确授权坐标) 拉取；FORWARD bundle 和 closure
资源使用 [Forward Bundle](./resources.md#4-转发包forward-bundle) 规则。资源下载失败不得回滚已经与
message 处理结果一起提交的 `scannedThrough`。

消息撤回和生效治理删除不作为 message revision 或特殊 `contentType` 出现在本 feed；它们由
[Message Tombstone Feed](./message-tombstone-feed.md) 持久传播。consumer 插入任何 message 前必须查询
同一稳定目标的既有 tombstone，避免迟到或重放的消息复活。
