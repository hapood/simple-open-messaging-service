# Federation v1 Message Feed

状态：`FINAL`
规范性：本文全部为规范性要求，除非段落明确标记为“非规范性实现说明”。

本文定义 `GET /s2s/v1/message-feed` 的完整 page、message、content、SYSTEM event、media 与
forward closure schema。通用身份、签名、错误和 cursor 规则见 [主协议](./protocol.md)。

## 1. 请求与 Page

请求 query 使用必选 `after: DecimalString` 与可选 `take: positive integer`。成功 envelope 的 `data`：

```ts
interface MessageFeedPage {
  messages: FederatedMessage[];
  scannedThrough: DecimalString;
  allocatedThrough: DecimalString;
  hasMore: boolean;
}
```

`allocatedThrough` 是本页冻结的 source HWM；`scannedThrough` 是本页成功提交后可确认的 cursor。
`hasMore: false` 时两者 MUST 相等。page/cursor、空页、重放与错误回滚规则与 state-feed 相同。

## 2. 外层 Message

```ts
interface Address {
  account: string;
  domain: string;
}

type ThreadAddress =
  | { type: 'GROUP'; account: string; domain: string }
  | { type: 'P2P'; participants: Address[] };

interface AssetDescriptor {
  digest: Sha256Hex;
  bytes: DecimalString;
  status: 'READY' | 'DELETED';
}

interface QuoteTarget {
  creator: Address;
  originSeq: number;
}

interface FederatedMessage {
  changeId: DecimalString;
  thread: ThreadAddress;
  author: Address;
  seq: number;
  originSeq: number;
  contentType: ContentType;
  content: string;
  createdAt: EpochMilliseconds;
  updatedAt: EpochMilliseconds;
  clientMessageId: string | null;
  quoteTarget?: QuoteTarget;
  assets: AssetDescriptor[];
}
```

- `changeId` 是对目标 peer 的 feed allocation cursor。
- GROUP identity 由 `thread.account/domain` 标识。P2P `participants` MUST 恰好包含两个不同 address，
  且包含 author；顺序无语义。
- `seq` 是当前 publisher 副本的 thread-local sequence；只用于该 publisher 的排序与精确资源授权。
- `originSeq` 是作者 server 首次发布时分配的稳定、非负安全整数。relay 不得改写。
- `createdAt` 是当前 publisher 持久化该副本的 epoch-ms；`updatedAt >= createdAt`。
- `clientMessageId` 是作者提供的幂等 key 或 `null`；不得把它当作跨作者全局 identity。
- `content` MUST 是 JSON object 的 UTF-8 JSON 编码字符串。consumer 先解析外层 page，再按
  `contentType` 对该字符串执行第二次 JSON 解析。
- `assets` 是 `content` 所引用 CAS bytes 的权威清单。`bytes` 是非负十进制字符串；`DELETED`
  是不可恢复 tombstone。非媒体消息 MUST 使用空数组。
- 只有 PURE_TEXT reply 可以出现 `quoteTarget`；它是 quote 的跨 server 稳定 identity。

publisher MUST 只发出本文列出的 content 字段。SYSTEM 等具权限/生命周期含义的 closed schema 出现
未知字段时 consumer MUST 拒绝；普通展示类型的 consumer MAY 忽略未知纯展示字段，但不得据此改变
权限、identity、media ownership 或 cursor。

## 3. `ContentType`

```ts
type ContentType =
  | 'PURE_TEXT'
  | 'INVITE'
  | 'IMAGE'
  | 'VIDEO'
  | 'FILE'
  | 'AUDIO'
  | 'LINK'
  | 'CALL'
  | 'FORWARD'
  | 'GALLERY'
  | 'SYSTEM';
```

这 11 个值是 v1 完整集合。未知值 MUST 拒绝，不能降级成普通文本。

## 4. `PURE_TEXT`

```ts
interface TextContent {
  text: string;
  quote?: {
    seq: number;
    author?: string;
    body?: string;
    contentType?: string;
    image?: string;
    imageLabel?: string;
    imageIdentity?: string;
    imageSize?: number;
    imageShape?: 'thumbnail' | 'avatar';
  };
}
```

`text` 是消息正文。`quote.seq` 是 publisher 本地展示坐标，非跨 server identity；出现 quote 时，
外层 `quoteTarget` MUST 同时出现，consumer 必须用后者定位引用，再把本地展示 `seq` 投影到自己的
存储。其余 quote 字段都是可选的非权威 preview，consumer MAY 重新生成或丢弃。

SYSTEM message 不可被 quote；preview 字段不得授予 media 或消息可见性。

## 5. 单资源媒体

所有 `url` 是 publisher 的 CAS 展示路径，其中 64 位 digest MUST 与对应 `assets[].digest` 相同。
consumer 下载并验证 bytes 后 MAY 重写为自己的本地路径。URL/query 不是资源 identity，也不得替代
`GET /media/:digest` 的精确消息授权参数。

```ts
interface ImageContent {
  url: string;
  w: number;
  h: number;
  size: number;
}

interface FileContent {
  url: string;
  name: string;
  size: number;
  mimeType: string;
}

interface VideoContent extends FileContent {
  w: number;
  h: number;
  duration: number;
}

interface AudioContent extends FileContent {
  duration: number;
}
```

- IMAGE、FILE、VIDEO、AUDIO MUST 各引用恰好一个 asset。
- `size` 是 JSON 安全整数 bytes，MUST 与 descriptor `bytes` 相同。
- `w`、`h` 是正有限像素数；`duration` 是正有限秒数。它们是展示 metadata，不证明 bytes 内容。
- `name` 与 `mimeType` 是非空展示字符串；不能用于安全判定。bytes、digest 与服务端响应 header 才是
  资源校验依据。

## 6. `GALLERY`

```ts
type GalleryKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';

interface GalleryContent {
  items: GalleryItem[];
}

interface GalleryItem {
  kind: GalleryKind;
  url: string;
  size: number;
  name?: string;
  mimeType?: string;
  w?: number;
  h?: number;
  duration?: number;
}
```

`items` MUST 非空，每项引用一个 asset；同一 digest MAY 去重共享 descriptor。各 kind 的字段规则与
对应单资源类型相同：IMAGE 使用 `w/h`；VIDEO 使用 `name/mimeType/w/h/duration`；AUDIO 使用
`name/mimeType/duration`；FILE 使用 `name/mimeType`。与 kind 无关的字段 MUST 省略。

## 7. `LINK`

```ts
interface LinkContent {
  url: string;
  title: string;
  description: string;
  siteName?: string;
  image?: string;
  favicon?: string;
}
```

页面 `url` MUST 是绝对 `http`/`https` URL。`image` 与 `favicon` 若存在，MUST 是已本地化的 CAS
路径，其 digest 必须出现在 `assets`；未带缩略图的 LINK 使用空 assets。页面 URL 不是 media 下载
授权。title/description 可以是空字符串；可选字段没有值时必须省略而非发送 `null`。

## 8. `INVITE`

```ts
interface GroupInviteContent {
  type: 'GROUP_INVITE';
  from: string;
  group: string;
  groupName: string;
  groupAvatar?: string;
  groupDomain: string;
  groupIsLocal: boolean;
}
```

INVITE 是 P2P timeline 中的展示卡，不是 membership authority。`from` 是 inviter account；`group`
是以 `!` 开头的群 account；`groupDomain` 是群 origin。`groupAvatar` 是可选展示 locator，不授予 media
访问。`groupIsLocal` 只描述群相对 publisher 的部署位置，consumer 不得用它替代 `groupDomain`。
接受/拒绝必须通过 state-feed 的双向 membership intent 与 origin `GROUP_META` 收敛。

## 9. `CALL`

```ts
type CallMediaType = 'AUDIO' | 'VIDEO';
type CallOutcome =
  | 'completed'
  | 'cancelled'
  | 'declined'
  | 'missed'
  | 'failed'
  | 'unreachable';

interface CallContent {
  type: 'CALL';
  callType: CallMediaType;
  status: CallOutcome;
  caller: Address;
  callee: Address;
  startedAt?: EpochMilliseconds;
  endedAt?: EpochMilliseconds;
  durationMs?: number;
}
```

CALL 是 terminal timeline record；ringing、SDP、ICE 和 transient lifecycle 只走 `/s2s/v1/call`，不写
进 message content。`clientMessageId` 是 call SID。`startedAt` 只在连接后出现；连接后的记录 MUST
同时含 `startedAt/endedAt/durationMs`，且 duration 等于两者差；未连接结果省略 startedAt 和 duration。

`caller` MUST 等于 outer `author`；`caller` 与 `callee` 必须是 P2P participants 中两个不同的 stable
address。数据库 user id 不得出现于 S2S content。

> 非规范性 SOMS 实现说明：SOMS 在 S2S 边界把 address 投影为接收节点自己的 numeric user id 后再
> 保存本地 CALL 气泡，以兼容本地客户端；该本地字段不属于联邦协议。

## 10. `FORWARD`

message 的卡片 content：

```ts
interface ForwardCardContent {
  version: 1;
  bundleId: string;
  summaryLines: string[];
  messageCount: number;
  assetCount: number;
}
```

`summaryLines` 最多三项，仅用于展示。完整、不可变 closure 通过
`GET /s2s/v1/forward-bundles/:bundleId` 获取；卡片计数不得替代 closure 验证。

```ts
interface ForwardWireClosure {
  schemaVersion: 1;
  rootBundleId: string;
  bundles: ForwardWireBundle[];
  assets: ForwardAsset[];
  accessContext?: { threadId: number; seq: number };
}

interface ForwardWireBundle {
  id: string;
  depth: number;
  manifestDigest: Sha256Hex;
  manifest: ForwardManifest;
  assets: ForwardAsset[];
}

interface ForwardManifest {
  schemaVersion: 1;
  bundleId: string;
  depth: number;
  children: string[];
  messages: ForwardManifestMessage[];
}

interface ForwardManifestMessage {
  id?: number;
  sender: {
    displayName: string;
    account: string;
    domain: string;
    avatarDigest?: Sha256Hex;
  };
  contentType: string;
  content: string;
  sentAt: EpochMilliseconds;
  childBundleId?: string;
  quote?: { preview: string; targetId?: number };
}

interface ForwardAsset {
  digest: Sha256Hex;
  kind: 'avatar' | 'image' | 'file' | 'video' | 'audio' | 'link';
  extension: string;
  bytes: number;
  filename?: string;
  mime?: string;
}
```

`manifestDigest` MUST 是 canonical manifest JSON 的 SHA-256。所有 child 必须闭合、无环、受实现公布的
有界资源限制约束。forward 内层 INVITE、CALL 和 SYSTEM 不得赋予当前关系/群权限；接收端必须把整个
bundle 当作不可变历史展示。`accessContext` 若出现，只是 publisher 返回的诊断/授权上下文。

## 11. `SYSTEM`

```ts
type SystemMessageType =
  | 'FRIEND_REQUESTED'
  | 'FRIEND_ACCEPTED'
  | 'FRIEND_ADDED'
  | 'FRIEND_REMOVED'
  | 'GROUP_JOINED'
  | 'GROUP_LEFT'
  | 'GROUP_ADMIN_GRANTED'
  | 'GROUP_ADMIN_REVOKED'
  | 'GROUP_OWNER_TRANSFERRED';

interface SystemContent {
  type: SystemMessageType;
  subject?: Address;
}
```

SYSTEM 是 closed schema：除 `type`、`subject` 外不得包含字段。自然语言、昵称和本地 user id 不得放入
content；客户端依据 type、outer author 和 stable subject 本地化渲染。

| type                      | `subject` | 展示含义                                                             |
| ------------------------- | --------- | -------------------------------------------------------------------- |
| `FRIEND_REQUESTED`        | 省略      | outer author 发起好友请求。                                          |
| `FRIEND_ACCEPTED`         | 省略      | outer author 接受好友关系。                                          |
| `FRIEND_ADDED`            | 省略      | v1 legacy display event；新 publisher MUST NOT 产生。                |
| `FRIEND_REMOVED`          | 必选      | outer author 移除 subject 对应的好友关系。                           |
| `GROUP_JOINED`            | 必选      | subject 已由 origin roster 确认加入群。                              |
| `GROUP_LEFT`              | 必选      | subject 主动离开或被 operator 移出；outer author 是 actor/operator。 |
| `GROUP_ADMIN_GRANTED`     | 必选      | subject 被授予管理员展示事件。                                       |
| `GROUP_ADMIN_REVOKED`     | 必选      | subject 被撤销管理员展示事件。                                       |
| `GROUP_OWNER_TRANSFERRED` | 必选      | owner 转移给 subject。                                               |

SYSTEM 永远是结构化、durable 的 timeline notice，但它本身不替代 state-feed authority：好友成立看双方
`P2P_META`，群成员/角色/owner 看 origin `GROUP_META`。consumer 不得仅凭 SYSTEM 修改授权状态。

## 12. Self-authored Receipt、Relay 与幂等

publisher 收到并持久化 peer 自己 authored 的消息后，必须把该副本分配回 author peer。consumer 用
`(thread, author, originSeq)` 找到原发布，记录 `createdAt` 作为对方持久化回执时间，不得插入重复
timeline message。publisher-local `seq` 只用于诊断和精确 media ownership proof。

relay 收到第三方 authored 消息时保留 `author/originSeq`；不得把同一 allocation 直接反射回刚拉取的
relay source。重复 change/page、重复 receipt 和重复 clientMessageId 必须幂等。

任何 media digest、quoteTarget、thread participant 或 author identity 不一致都必须使整个 page 与
cursor 回滚；consumer 不得保存“部分可信”的普通消息后跳过失败项。
