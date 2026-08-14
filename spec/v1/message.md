# SOMS Federation v1 Message

状态：`RELEASE CANDIDATE`（`v1.0-rc.1`）
规范性：本文全部为规范性要求，除非段落明确标记为“非规范性实现说明”。

本文定义 message query 中每个 message 的 wire 结构、全部 `contentType`、接收处理方式和附件拉取。
Feed 与 query 分页语义见 [Message Feed and Query](./message-feed.md)，资源 HTTP operation 见
[Resources](./resources.md)。

## 1. 类型与处理总览

`content` 在外层始终是 JSON 字符串。consumer MUST 先校验外层 `FederatedMessage`，再根据
`contentType` 对 `content` 执行一次 JSON 解析，并严格校验对应结构。

| `contentType` | 处理方式                                                                                   | 资源处理                                    |
| ------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `PURE_TEXT`   | 解析带 inline entity 的文本和可选 reply preview；存在引用时必须使用外层 `quoteTarget` 定位 | `assets` 必须为空                           |
| `IMAGE`       | 解析单张图片元数据并创建媒体消息                                                           | 按 `assets` 拉取图片 bytes                  |
| `VIDEO`       | 解析视频文件、尺寸和时长                                                                   | 按 `assets` 拉取视频 bytes                  |
| `AUDIO`       | 解析音频文件和时长                                                                         | 按 `assets` 拉取音频 bytes                  |
| `FILE`        | 解析普通文件名、大小和 MIME 信息                                                           | 按 `assets` 拉取文件 bytes                  |
| `GALLERY`     | 按 item 顺序解析多资源消息，每个 item 独立校验                                             | 拉取全部非 `DELETED` asset                  |
| `LINK`        | 保存页面 URL、标题、摘要及可选缩略图                                                       | 只有存在 CAS 缩略图时才拉取 asset           |
| `INVITE`      | 保存群邀请消息快照；群成员权威状态仍由 state-feed 决定                                     | `assets` 必须为空                           |
| `CALL`        | 保存通话结束后的 durable terminal message；不得当作实时 signaling frame                    | `assets` 必须为空                           |
| `FORWARD`     | 校验并保存 forward manifest/closure；closure 内消息保持作者坐标                            | 按 forward bundle 和 closure asset 规则拉取 |
| `SYSTEM`      | 不属于 federation message query；收到时必须拒绝该 item                                     | 不适用                                      |

consumer 对每个 item 的通用处理顺序：

1. 校验 thread、author、query seq 和所有外层字段。
2. 根据 `contentType` 解析并校验 `content`。
3. 校验 `assets` 与 content 中显式引用的 digest 集合完全一致。
4. 使用 `(thread, author, originSeq)` 幂等落库；不得按 `seq` 或时间去重。
5. 将尚未下载的资源保存为 durable pending work，再按资源接口拉取。
6. 按本地策略确定该 item 的处理结果；单条坏消息和后续资源失败不得永久阻塞同页其他消息或 query
   cursor。资源可作为 durable pending work 在 cursor 提交后继续处理。

## 2. 顺序与时间语义

message wire 中没有客户端权威的 `date` 字段。顺序和时间只使用以下字段：

- `seq`：当前 publisher 在把该 Message 副本写入其本地 thread 时分配的正安全整数，表示该
  publisher 数据库中的 thread-local 落库顺序。它不是跨 server identity，也不保证群 origin 和
  consumer 使用相同值。consumer 落库时分配自己的本地 `seq`，不得强行复用 wire `seq`。
- `originSeq`：author server 首次持久化该消息时分配的正安全整数。它与 author/thread 一起构成
  submission 与群 origin 权威分发之间的稳定作者坐标；group origin MUST 原样保留。
- `createdAt`：当前 publisher 首次把这个 Message 副本持久化到数据库的 epoch milliseconds。
  它是服务器落库时间，不是客户端发送时间、设备时间或跨 server 全局排序时间。
- `updatedAt`：当前 publisher 最后一次持久更新该 Message 副本的 epoch milliseconds，MUST
  大于或等于 `createdAt`。它同样是服务器数据库时间。

group origin 接受 submission 时会产生自己的 `seq`、`createdAt` 和 `updatedAt`，因此这些字段在不同 publisher 返回的
同一 authored message 上可以不同。consumer MUST 使用 `(thread, author, originSeq)` 关联重复消息
和 self-authored receipt。跨 thread 或跨 server 展示排序不得假设不同服务器时钟严格同步。

message query MAY 返回 pull peer 自己 authored 且已由 source 持久化的消息。consumer 使用稳定 authored
identity 将它作为幂等回执合并，不得创建重复消息。

content 内部若另有业务时间，例如 CALL 的 `startedAt`、`endedAt`，其语义由对应 content schema
单独定义，不能替代外层数据库时间。

## 3. 外层 Message

```ts
interface Address {
  account: Account;
  domain: Domain;
}

type ThreadAddress =
  | { type: 'GROUP'; account: GroupAccount; domain: Domain }
  | { type: 'P2P'; participants: Address[] };

interface AssetDescriptor {
  digest: Sha256Hex;
  bytes: SafeInteger;
  status: 'READY' | 'DELETED';
}

interface QuoteTarget {
  creator: Address;
  originSeq: number;
}

interface FederatedMessage {
  thread: ThreadAddress;
  author: Address;
  seq: number;
  originSeq: number;
  contentType: ContentType;
  content: string;
  createdAt: EpochMilliseconds;
  updatedAt: EpochMilliseconds;
  clientMessageId: CanonicalUuid | null;
  quoteTarget?: QuoteTarget;
  assets: AssetDescriptor[];
}
```

- GROUP identity 由 `thread.account/domain` 标识。P2P `participants` MUST 恰好包含两个不同 address，
  且包含 author；顺序无语义。GROUP 的 `account` 必须是 `GroupAccount`；message author 和 P2P participant
  的 `account` 必须是 `UserAccount`。consumer 以规范化 Address 的 `(domain, account)` ASCII
  lexicographic 顺序构造 P2P 本地唯一键。
- `seq` 是当前 publisher 副本的 thread-local sequence，只用于该 publisher 的 page 内排序和展示坐标；
  不得把它当作跨 publisher identity。`seq`、`originSeq` 和 `quoteTarget.originSeq` 都是 `PositiveSafeInteger`。
- `originSeq` 是作者 server 首次发布时分配的稳定正安全整数。group origin 不得改写；资源接口的 `seq`
  query 使用该值，与 outer message 的 `author` 共同形成精确资源授权坐标。
- `createdAt` 是当前 publisher 持久化该副本的 epoch-ms；`updatedAt >= createdAt`。
- `clientMessageId` 是作者提供的 `CanonicalUuid` 幂等 key 或 `null`；不得把它当作跨作者全局 identity。
- `content` MUST 是 JSON object 的 UTF-8 JSON 编码字符串。consumer 先解析外层 page，再按
  `contentType` 对该字符串执行第二次 JSON 解析。
- `assets` 是 `content` 所引用 CAS bytes 的权威清单。`bytes` 是 `SafeInteger`；`DELETED`
  是不可恢复 tombstone。每个 digest 最多出现一次；content 引用 digest 的去重集合必须与该数组的
  digest 集合完全相等，包括 `DELETED` descriptor。没有直接资源引用的消息必须使用空数组。
- 只有 PURE_TEXT reply 可以出现 `quoteTarget`；它是 quote 的跨 server 稳定 identity。

本文所有标为 interface 的 object 都是 closed schema：publisher MUST 只发出列出的字段，consumer
遇到未知字段 MUST 拒绝该 item。只有具体小节明确声明可扩展或可忽略的结构例外。

outer `assets` 基数如下：

| `contentType`                            | content digest 引用与 `assets`                                           |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `PURE_TEXT`、`INVITE`、`CALL`、`FORWARD` | 不得直接引用 digest；`assets` 为空。FORWARD closure 资产另行获取。       |
| `IMAGE`、`VIDEO`、`AUDIO`、`FILE`        | 恰好一个 digest 和一个 descriptor。                                      |
| `GALLERY`                                | 每项一个 digest；`assets` 是去重后的完整 descriptor 集合。               |
| `LINK`                                   | `imageDigest/faviconDigest` 的去重集合；可以为 0、1 或 2 个 descriptor。 |

consumer 只为 `READY` descriptor 建立下载任务；`DELETED` 保留不可用占位且不得请求 bytes。
descriptor status 是 authored message snapshot 的不可变部分；message 发布后发生的 blob 丢失或授权状态
变化通过资源 operation 的响应表达，不得通过重发同一 message identity 并改写 status 表达。

### 3.1 协议 identity 与坐标派生

`(thread, author, originSeq)` 是协议级的不可变 message identity。它通过 wire 字段表达，但其作用不限于
传输：publisher 和 consumer 都必须（MUST）用它关联持久化、幂等、引用、墓碑与资源授权。下表定义
后续 operation 必须从已验证 message 派生的坐标。consumer 不得用本地数据库 ID、publisher-local
`seq`、preview 字段或 child bundle ID 替代这些值。

| 用途                      | 权威来源与映射                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| authored message identity | `(thread, author, originSeq)`；用于幂等合并、tombstone target 和 self-authored receipt               |
| reply target identity     | outer `quoteTarget.creator + quoteTarget.originSeq`，并继承当前 message 的 `thread`                  |
| direct media identity     | outer `author` → `fromAccount/fromDomain`；outer `originSeq` → media query `seq`；content → `digest` |
| media audience            | P2P 使用 signer domain 对应参与者；GROUP 使用 outer `thread` 的 group identity 派生 `toAccount`      |
| forward closure root      | outer `ForwardCardContent.bundleId` → bundle path `:bundleId` 与 response `rootBundleId`             |
| forward asset identity    | direct media 坐标加 outer root `bundleId`；`digest` 必须位于该 root 的已验证完整 closure             |

本表定义协议 identity 在不同 operation 之间的派生关系。实现可以（MAY）把这些坐标映射到任意本地
schema，但必须（MUST）保存足够信息，使重试、重放、资源授权和 tombstone 应用仍使用同一个协议 identity。

### 3.2 不可变 identity 与重复消息

v1 不定义消息编辑；撤回与生效治理删除由独立
[Message Tombstone Feed](./message-tombstone-feed.md) 表达，不修改本节 message item。
`(thread, author, originSeq)` 标识的 authored message 一旦首次
发布，其 `thread`、`author`、`originSeq`、`clientMessageId`、`contentType`、解析后的 `content`、
`quoteTarget` 和 `assets` 都不可变。group origin 接受 submission 后 MUST 原样保留这些 authored 字段。

consumer 再次收到同一 identity 时必须与已经保存的 authored 字段比较；语义相同的重放或 receipt
幂等合并，不得插入第二条 timeline message。任一不可变字段冲突都是坏 item，不得按较新的
`updatedAt`、较大的 `seq` 或接收顺序覆盖。publisher-local `seq/createdAt/updatedAt` 不是 authored
message revision；它们可以在不同 publisher 的同一消息副本上不同。

## 4. `ContentType`

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
  | 'GALLERY';
```

这 10 个值是 v1 完整集合。未知值 MUST 统一拒绝该条并记录 error，不能降级成普通文本。
总览表中的 `SYSTEM` 是明确列出的非法保留值，不属于 `ContentType` 联合类型；它只用于说明接收行为。

## 5. `PURE_TEXT`

```ts
interface TextContent {
  text: string;
  quote?: {
    seq: number;
    author?: string;
    body?: string;
    contentType?: string;
  };
}
```

`TextContent` 是 outer `content` 字符串执行一次 JSON 解析后的 closed object；`text` 本身仍是 string，
但不是无结构纯文本，它可以包含第 5.1 节定义的 inline entity。不得在 `text` 中传输 HTML、编辑器
私有 JSON node 或可执行 markup。

`quote.seq` 是 publisher 本地展示坐标，非跨 server identity；出现 quote 时，
外层 `quoteTarget` MUST 同时出现，consumer 必须用后者定位引用，再把本地展示 `seq` 投影到自己的
存储。其余 quote 字段都是可选的非权威 preview，consumer MAY 重新生成或丢弃。

只有 `PURE_TEXT` message 可以携带 `quote/quoteTarget`；被引用的目标可以是任意 content type。
`quoteTarget` 必须指向同一 thread。目标尚未同步或已不可用时，consumer 保存 message 并使用 preview
降级展示，不得因此拒绝 message；preview 字段不得授予 media 或消息可见性。

### 5.1 Inline entity 与 mention

inline entity 的通用 wire 形式是：

```text
[<sigil><label>](soms://<entity-type>/<percent-encoded-id>?v=1)
```

v1 支持以下两个 mention：

```text
[@张三](soms://user/zhangsan%40example.com?v=1)
[@所有人](soms://audience/all?v=1)
```

- `user` entity 的 decoded ID 是目标稳定地址的 `account@domain` 表示；domain 使用协议 canonical
  domain，比较按 Address 规则进行。label 是发送时的展示快照，不参与 identity。
- `audience/all` 表示 GROUP thread 的全体 audience；它不得出现在 P2P thread。
- entity URI 的 scheme 和 host/type 比较区分大小写，并且 v1 canonical publisher MUST 使用上例小写
  形式、唯一 query `v=1` 和标准 URI percent-encoding。
- label 中的 `\`、`[`、`]` 分别写作 `\\`、`\[`、`\]`。普通正文中的 literal `[` 写作 `\[`，literal
  `\` 写作 `\\`；只有 `\\` 和 `\[` 在普通正文中具有 escape 语义。
- malformed、被 escape 或不完整的 token 是普通文本。未知 entity type/version 必须降级为其可读
  `<sigil><label>`，不得令整条消息无法展示，也不得产生 mention 权限或 attention 语义。
- consumer 不得把 entity 当作 HTML；UI 必须使用 text node/component 安全渲染。

author server 负责在首次持久化前验证 mention 是否适用于该 thread。group origin 接受 submission 时再次
验证其群上下文，但不改写合法 token，
consumer 在本地 unread/notification 逻辑中按稳定 entity ID 判断 `@me` 或 `@all`。编辑器节点、数据库
表示和 UI 组件属于本地实现，不是 Federation wire contract。

例如第二次 JSON 解析后的 `TextContent` 是：

```json
{
  "text": "你好 [@张三](soms://user/zhangsan%40example.com?v=1)"
}
```

它在 outer `FederatedMessage` 中仍编码为一个 JSON string：

```json
{
  "contentType": "PURE_TEXT",
  "content": "{\"text\":\"你好 [@张三](soms://user/zhangsan%40example.com?v=1)\"}"
}
```

上例是字段摘录，不是完整 `FederatedMessage`。

## 6. 单资源媒体

media content 不携带 publisher 展示 URL。每个资源使用显式 `digest` 与 outer `assets` descriptor
关联；consumer 必须根据 digest 和 outer message 的 author/thread/originSeq 自行构造
`GET /s2s/v1/media/:digest` 请求。完整构造规则见
[媒体资源 operation](./resources.md#31-operation-与精确授权坐标)。

publisher 必须通过 signer 的 thread audience 授权资源访问，并验证 digest 与精确消息的绑定；
不得使用 message-feed 索引 item 作为下载授权。feed 只负责发现 thread query 上界，不是资源权限 proof。

```ts
interface ImageContent {
  digest: Sha256Hex;
  w: number;
  h: number;
  size: number;
}

interface FileContent {
  digest: Sha256Hex;
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

- IMAGE、FILE、VIDEO、AUDIO MUST 各引用恰好一个 digest 和同 digest asset descriptor。
- `size` 是 `SafeInteger` bytes，MUST 与 descriptor `bytes` 相同。
- `w`、`h` 是 `PositiveSafeInteger` 像素；`duration` 是正有限秒数。它们是展示 metadata，不证明
  bytes 内容。
- `name` 与 `mimeType` 是非空展示字符串；不能用于安全判定。bytes、digest 与服务端响应 header 才是
  资源校验依据。consumer 必须把 `name` 当作不可信 basename 展示，不能将其直接作为文件系统路径；
  `mimeType` 不得触发未经验证的主动内容执行。

## 7. `GALLERY`

```ts
type GalleryKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';

interface GalleryContent {
  items: GalleryItem[];
}

interface GalleryItem {
  kind: GalleryKind;
  digest: Sha256Hex;
  size: number;
  name?: string;
  mimeType?: string;
  w?: number;
  h?: number;
  duration?: number;
}
```

`items` MUST 非空并保持展示顺序，每项引用一个 asset；同一 digest MAY 被多项引用并共享唯一 descriptor。
content 中所有 item digest 的去重集合必须与 outer `assets` digest 集合相等。各 kind 的字段规则与
对应单资源类型相同：IMAGE 使用 `w/h`；VIDEO 使用 `name/mimeType/w/h/duration`；AUDIO 使用
`name/mimeType/duration`；FILE 使用 `name/mimeType`。与 kind 无关的字段 MUST 省略。

## 8. `LINK`

```ts
interface LinkContent {
  url: string;
  title: string;
  description: string;
  siteName?: string;
  imageDigest?: Sha256Hex;
  faviconDigest?: Sha256Hex;
}
```

页面 `url` MUST 是绝对 `http`/`https` URL，它是用户可见的业务链接，不是 media 下载授权。consumer
不得仅因收到消息而自动访问该页面。`imageDigest` 与 `faviconDigest` 若存在，必须分别解析到同 digest
asset descriptor；二者 MAY 相同，二者的去重集合必须与 outer `assets` digest 集合相等。未带缩略图的
LINK 使用空 assets。title/description 可以是空字符串；
可选字段没有值时必须省略而非发送 `null`。

## 9. `INVITE`

```ts
interface GroupInviteContent {
  type: 'GROUP_INVITE';
  from: UserAccount;
  group: GroupAccount;
  groupName: string;
  groupDomain: Domain;
}
```

INVITE 是 P2P timeline 中的展示卡，不是 membership authority。`from` 是 inviter account；`group`
是以 `!` 开头的群 account；`groupDomain` 是群 origin。卡片不携带 publisher-local avatar locator；
consumer 按权威 group state/profile 自行解析头像，也自行判断该群相对本节点是否 local。`from` MUST
等于 outer `author.account`，outer author domain 是 inviter domain；`group/groupDomain` 必须形成合法
GROUP ThreadAddress identity。INVITE 的 outer thread 必须是 inviter 与 invitee 的 P2P thread，outer
`assets` 必须为空。接受/拒绝必须通过 state-feed 的双向 membership intent 与 origin `GROUP_META` 收敛。

## 10. `CALL`

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
进 message content。outer `clientMessageId` MUST 是非空 `CanonicalUuid` call SID，outer `assets` 必须
为空。所有 outcome 都必须有 `endedAt`。时间字段按该端是否接受过合法 `connected.startedAt` 决定：

- 已 connected：`startedAt` 与 `durationMs` 都必须出现，`startedAt` 等于 accepted connected frame 的
  值，`durationMs` 是 `SafeInteger` 且精确等于 `endedAt - startedAt`。
- 从未 connected：`startedAt` 与 `durationMs` 都必须省略。

`cancelled/declined/missed/unreachable` 必定属于从未 connected；`completed` 可以在 accepted 后、媒体
尚未连接时正常结束，也可以在 connected 后结束；`failed` 可以发生在连接前或连接后。calls operation
的 `ended(completed)` 映射为 `completed`，`ended(timeout|failed)` 映射为 `failed`；`declined`、
`cancelled` 和 `missed` 映射到同名 outcome。`unreachable` 表示没有可发送或可接受的远端 lifecycle
frame 时，由本地权威失败路径生成的终态。

`endedAt >= startedAt`（若有）。这些业务时间由生成 terminal record 的 publisher 断言，不用于跨服务器排序。
完整 frame state machine 见 [Calls](./calls.md)。

`caller` MUST 等于 outer `author`；`caller` 与 `callee` 必须是 P2P participants 中两个不同的 stable
address。数据库 user id 不得出现于 S2S content。

> 非规范性 SOMS 实现说明：SOMS 在 S2S 边界把 address 投影为接收节点自己的 numeric user id 后再
> 保存本地 CALL 气泡，以兼容本地客户端；该本地字段不属于联邦协议。

## 11. `FORWARD`

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

`bundleId` 是 publisher 生成的、区分大小写的 opaque root ID：解码后 UTF-8 长度为 `1..26` bytes，
不得包含 NUL 或 `/`。publisher 必须保证自己可返回的 bundle ID 不冲突，并且一旦发布就不得把同一 ID
重新绑定到不同 closure；ID 不要求是 digest，consumer 不得从其外形推断时间或内容。

`summaryLines` 为零至三项非空展示字符串。`messageCount` 是以该 card `bundleId` 为 root 的子 closure
中所有 reachable manifest 的 message 总数；`assetCount` 是该子 closure 按 digest 去重后的 asset 数，
分别必须是 `SafeInteger`。outer card 的计数覆盖整个返回 closure，inner card 的计数覆盖对应 child
subtree；所有计数都必须与验证后的 closure 相等，但仅用于卡片预览和预分配，不能替代 closure 验证。
outer FORWARD message 的 `assets` 必须为空。

完整、不可变 closure 通过
`GET /s2s/v1/forward-bundles/:bundleId` 获取；卡片计数不得替代 closure 验证。
closure 下载同样必须 join signer 的 thread audience 并验证 bundle 与可见 FORWARD message 的绑定，
不得依赖 message-feed change 是否仍保留。
完整 HTTP operation、资源上限、错误与原子提交要求见[资源接口](./resources.md)第 4 节。

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
  id: number;
  sender: {
    displayName: string;
    account: UserAccount;
    domain: Domain;
    avatarDigest?: Sha256Hex;
  };
  contentType: ContentType;
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

`ForwardAsset.bytes` 是 `SafeInteger`；`ForwardWireBundle.depth`、`ForwardManifest.depth`、message `id`
与出现时的 `quote.targetId` 都是 `PositiveSafeInteger`。`sender.account/domain` 形成 `UserAccount`
Address；`displayName`、`extension`、`filename` 和 `mime` 都是不可信展示 metadata，
不得作为路径、授权或内容执行依据。`sentAt` 是被转发历史中的展示时间，不是当前 publisher 落库时间，
不得用于跨 server 全局排序。

closure 必须满足以下关系：

- `rootBundleId` 等于 card/path `bundleId`。`bundles[].id` 全局唯一，root 恰好出现一次；每个
  `manifest.bundleId` 等于 enclosing bundle `id`。
- `ForwardManifestMessage.id` 是 `PositiveSafeInteger`，在所属 manifest 内唯一；它只用于该 manifest
  内 quote/link，不是 outer message identity。
- `manifest.children` 无重复。它的 ID 集合必须与该 manifest 中所有 `childBundleId` 的集合完全相等，
  每个 child ID 恰好由一条 message 引用。出现 `childBundleId` 时该 message 的 `contentType` 必须是
  `FORWARD`，其解析后 card `bundleId` 必须等于 `childBundleId`；反之内层 FORWARD 必须携带该字段。
- 从 root 沿 children 可达的 bundle 必须恰好等于 `bundles` 返回集合；不得缺 child、夹带不可达
  bundle、形成环或把同一 child 挂到多个 parent。depth 与数量上限见资源 operation。
- inner `contentType` 必须是第 4 节合法值，`content` 使用对应 content object 的字段 shape；依赖 outer
  thread、clientMessageId 或 quoteTarget 的约束在 closure 内不适用。sender avatar digest 和 inner content
  的全部直接 digest 引用必须与 enclosing bundle `assets` 的 digest 集合完全相等；每个 bundle 内 digest
  唯一且相同 digest descriptor 必须一致。顶层 `assets` 是所有 bundle asset 按 digest 去重后的完整集合。
- `quote.targetId` 若出现，必须解析到同一 manifest 中恰好一条 message；`preview` 仅供展示。跨 manifest
  quote 不在 v1 表达。
- outer card 和每个 inner FORWARD card 的 `messageCount/assetCount` 必须分别等于以其 `bundleId` 为
  root 的 subtree 实际计数。
- forward 内层 INVITE 和 CALL 只是不可变历史展示，不赋予当前关系、群权限或实时 call 状态；接收端
  不得执行内层业务动作。
- `accessContext.threadId/seq` 若出现必须是 `SafeInteger`，只表示 publisher-local 诊断上下文。consumer
  不得用它构造 bundle/media 请求或定位自己的 thread。

### 11.1 Manifest canonicalization 与 digest

`manifestDigest` MUST 是 `manifest` 按 [RFC 8785 JSON Canonicalization Scheme
(JCS)](https://www.rfc-editor.org/rfc/rfc8785.html) 序列化所得 UTF-8 bytes 的 SHA-256 小写 hex。manifest
必须属于 JCS 要求的 I-JSON 子集：object 不得有重复 member，string 必须是有效 Unicode，number 必须能
无损表示为 IEEE 754 double；本 schema 的 integer 还必须满足 `SafeInteger`。array 顺序保持不变。
consumer 必须先解析并校验 closed schema，再对解析值执行 JCS；不得直接 hash response 中带缩进或不同
member 顺序的 substring。

固定 conformance vector：

```json
{
  "schemaVersion": 1,
  "bundleId": "b1",
  "depth": 1,
  "children": [],
  "messages": []
}
```

JCS UTF-8 bytes（末尾无换行）为：

```text
{"bundleId":"b1","children":[],"depth":1,"messages":[],"schemaVersion":1}
```

SHA-256 必须为：

```text
82049987f0534ad058938072e851c2dfb19508833b36fffce41a98bbc34628e3
```

## 12. Self-authored Receipt、群提交与权威分发

publisher 收到并持久化 peer 自己 authored 的消息后，必须把该副本分配回 author peer。consumer 用
`(thread, author, originSeq)` 找到原发布，记录 `createdAt` 作为对方持久化回执时间，不得插入重复
timeline message。资源授权坐标使用 authored `originSeq`；publisher-local `seq` 只用于诊断和该 publisher
自己的展示坐标。

第三方域群成员的 home server 只能把本域成员 authored message 提交给 group origin。origin 验证并持久
接受后保留 `author/originSeq`，再向 mirrors 权威分发；mirror 必须只接受已知 origin，且不得继续向第三个
peer 发布。message 不携带 author server 的端到端签名，因此 mirror 信任的是 group origin 的群 timeline
权威，而不是可加密验证的原作者证明。重复 submission、change/page、receipt 和 clientMessageId 必须幂等。

任何 media digest、quoteTarget、thread participant、author identity、不可变字段或 content schema
不一致都是坏 item。consumer 必须隔离该条并保留同页其他合法消息；记录、丢弃、不可用占位或人工修复
属于本地策略，但坏 item 和后续资源失败不得永久阻塞 feed cursor，也不得留下可被当作合法 message 或
资源授权 proof 的部分写入。
