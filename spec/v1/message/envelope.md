# Message Envelope

状态：`RELEASE CANDIDATE`（`v1.0-rc.2`）

本文定义 federation message query 中每个 message 共用的外层 wire 结构、来源坐标、幂等规则和
processing receipt。具体 `contentType` 的解析后结构见 [Message 总览](../message.md#4-contenttype)
及其分主题文档；分页语义见 [Message Feed and Query](../message-feed.md)。

## 1. Wire 类型

```ts
interface Address {
  account: Account;
  domain: Domain;
}

type ThreadAddress =
  | { type: 'GROUP'; account: GroupAccount; domain: Domain }
  | { type: 'P2P'; participants: Address[] };

interface BlobDescriptor {
  digest: Sha256Hex;
  bytes: SafeInteger;
}

interface QuoteTarget {
  targetSeq: PositiveSafeInteger;
}

type JsonObjectString = string;

interface EncodedMessageContent {
  contentType: ContentType;
  content: JsonObjectString;
}

interface FederatedMessage extends EncodedMessageContent {
  thread: ThreadAddress;
  author: Address;
  seq: PositiveSafeInteger;
  originSeq: PositiveSafeInteger | null;
  originCreatedAt: EpochMilliseconds | null;
  createdAt: EpochMilliseconds;
  clientMessageId: CanonicalUuid | null;
  quoteTarget?: QuoteTarget;
  assets: BlobDescriptor[];
}
```

`JsonObjectString` 表示 UTF-8 JSON object 的字符串编码，不是任意文本。consumer MUST 先校验外层
`FederatedMessage`，再根据 `contentType` 对 `content` 执行一次 JSON 解析，并严格校验对应 closed
schema。解析结果不是 object、包含未知字段或不符合对应类型时，consumer MUST 拒绝该 item。

## 2. Thread 与 author

- GROUP identity 由 `thread.account/domain` 标识，`account` 必须是 `GroupAccount`。
- P2P `participants` MUST 恰好包含两个不同 Address，必须包含 `author`，顺序无语义。
- message author 和 P2P participant 的 `account` 必须是 `UserAccount`。
- consumer 以规范化 Address 的 `(domain, account)` ASCII lexicographic 顺序构造 P2P 本地唯一键。

## 3. 顺序与来源时间

message wire 没有客户端权威的 `date` 字段：

- `seq` 是当前 publisher 把该副本写入本地 thread 时分配的 thread-local 顺序。consumer 落库时分配
  自己的本地 `seq`，不得强行复用 wire `seq`。
- `createdAt` 是当前 publisher 首次持久化该副本的 epoch milliseconds，不是客户端发送时间、设备时间
  或跨 server 排序时间。
- 权威源发布 timeline message 时，`originSeq/originCreatedAt` 必须是 `null/null`。
- consumer 从直接 publisher 拉取并形成非权威副本时，其 origin pair 必须等于 incoming
  `seq/createdAt`。
- `originSeq/originCreatedAt` 必须同时为 null 或同时非 null。它们是单跳来源坐标，不得跨 publisher
  原样复制。

content 内的业务时间，例如 CALL 的 `startedAt/endedAt`，不能替代外层数据库时间。

## 4. Identity 与不可变性

incoming message 的直接来源 identity 是：

```text
(source domain, normalized thread, wire seq)
```

consumer 必须持久保存该坐标与本地副本的映射。同一来源坐标的普通消息重放必须幂等合并；不得按时间、
preview、`clientMessageId` 或本地数据库 ID 去重。

同一来源坐标下，以下字段全部不可变：

- `thread`
- `author`
- `seq`
- `originSeq/originCreatedAt`
- `createdAt`
- `clientMessageId`
- `contentType`
- 解析后的 `content`
- `quoteTarget`
- `assets`

任一字段冲突都是坏 item，不得用较新的时间、较大的 seq 或接收顺序覆盖。v1 不定义消息编辑；撤回和
治理删除由 [Message Tombstone Feed](../message-tombstone-feed.md) 表达。

## 5. 条件字段

字段声明中的 `?` 只表示字段在某些合法状态下省略，不表示 publisher 可以任意选择：

| 字段 | 必须出现 | 必须省略 |
| ---- | -------- | -------- |
| `quoteTarget` | `PURE_TEXT` message 是引用回复 | message 不是引用回复，或类型不是 `PURE_TEXT` |
| CALL `clientMessageId` | 始终；值必须是非 null `CanonicalUuid` call SID | 不适用 |

其他类型专属条件字段由对应 content 文档定义。`clientMessageId` 对一般消息是作者提供的幂等 key 或
`null`，不得作为跨作者全局 identity。

## 6. Asset 清单

`assets` 是 content 直接引用 CAS bytes 的权威清单：

| `contentType` | digest 与 `assets` |
| ------------- | ------------------ |
| `PURE_TEXT`、`INVITE`、`CALL`、`FORWARD` | 不直接引用 digest，必须为空 |
| `IMAGE`、`VIDEO`、`AUDIO`、`FILE` | 恰好一个 digest 和同 digest descriptor |
| `GALLERY` | item digest 的去重完整集合 |
| `LINK` | `imageDigest/faviconDigest` 的去重完整集合，可以为 0、1 或 2 项 |

- 每个 digest 最多出现一次。
- content 引用 digest 的去重集合必须与 `assets` 完全相等。
- content 中的 `size` 必须与对应 descriptor 的 `bytes` 相同。
- 资源当前是否存在只由资源 operation 的响应表达；消息 descriptor 不携带可用状态。

## 7. 引用坐标

只有 `PURE_TEXT` reply 可以携带 `quoteTarget`。`quoteTarget.targetSeq` 指向同一 thread 中当前权威
publisher 的目标 `seq`。

consumer 使用 `(source domain, thread, targetSeq)` 查找目标副本，再投影为本地 seq。引用不携带远端
preview；目标不可用时仍保存 reply，并显示本地的不可用占位。

## 8. Processing receipt

consumer 成功持久化 incoming message 后，应该（SHOULD）使该非权威副本可由直接 publisher 查询，
作为 processing receipt。副本的 origin pair 等于 publisher 原 item 的 `seq/createdAt`。

publisher 读取 receipt 时：

- 使用 `(thread, author, originSeq)` 关联自己先前发布的 message；
- 只把 receipt 的 `seq/createdAt` 用作对方副本坐标和诊断时间；
- 不得创建 timeline message、修改原消息、产生新 receipt 或继续分发；
- 不得把 receipt 的 origin pair 反写到原消息。

未观察到 receipt 不能证明处理失败，也不能区分尚未处理、传输延迟、本地隔离或丢弃。

## 9. 通用接收顺序

1. 校验 thread、author、query seq 和所有外层字段。
2. 根据 `contentType` 解析并校验 `content`。
3. 校验 `assets` 与 content digest 集合完全一致。
4. 使用直接来源 identity 幂等接收并记录坐标映射。
5. 将未下载资源保存为 durable pending work。
6. 按本地策略提交合法 item、隔离坏 item，并推进允许推进的 query cursor。

单条坏消息和后续资源失败不得永久阻塞同页其他消息或 cursor，也不得留下可被视为合法 message、资源
授权 proof 或其他业务事实的部分写入。
