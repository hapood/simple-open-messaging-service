# Simple Open Chat Federation Protocol v1 Message

状态：`RELEASE CANDIDATE`（`v1.0.0-rc.0`）

本文是 federation message 规范的总入口。消息外层结构、来源坐标、幂等、资源 descriptor 和 processing
receipt 见 [Message Envelope](./message/envelope.md)；每种 content 的唯一详细定义见下表。

Feed 与 query 分页语义见 [Message Feed and Query](./message-feed.md)，资源 HTTP operation 见
[Resources](./resources.md)。

## 1. 类型与处理总览

`content` 在消息外层结构中始终是 JSON object 编码后的 string。consumer MUST 先校验
`FederatedMessage`。核心类型和 consumer 支持的 extension type 必须对 `content` 执行一次 JSON 解析并
严格校验对应 closed schema；未知 extension type 按本节的有界跳过规则处理。

| `contentType` | 详细规范 | 处理方式 | 直接资源 |
| ------------- | -------- | -------- | -------- |
| `PURE_TEXT` | [Text](./message/text.md) | 文本、mention 和可选 reply reference | 无 |
| `IMAGE` | [Media](./message/media.md) | 单张图片 | 一个 asset |
| `VIDEO` | [Media](./message/media.md) | 视频及展示 metadata | 一个 asset |
| `AUDIO` | [Media](./message/media.md) | 音频及展示 metadata | 一个 asset |
| `FILE` | [Media](./message/media.md) | 普通文件 | 一个 asset |
| `GALLERY` | [Media](./message/media.md#4-gallery) | 有序的混合媒体集合 | item digest 去重集合 |
| `LINK` | [Link](./message/link.md) | 页面 metadata 和可选缩略图 | 0、1 或 2 个 asset |
| `INVITE` | [Invite](./message/invite.md) | P2P 中的群邀请 snapshot | 无 |
| `CALL` | [Call Record](./message/call-record.md) | P2P 通话终态记录 | 无 |
| `FORWARD` | [Forward](./message/forward.md) | bundle root card | card 无直接 asset |

consumer 对已知类型 item 的通用处理顺序：

1. 校验消息外层结构。
2. 解析并校验 content。
3. 校验 content digest 与 asset descriptor，并在下载前根据 `assets[].bytes` 执行本地大小限制。
4. 按直接来源坐标幂等接收。
5. 对实际数组和 descriptor 执行本地 quota；不得信任可推导的远端 count。
6. 持久化 message 和 durable resource work，再按资源 operation 拉取 bytes。

坏 item 和资源失败不得永久阻塞同页其他合法消息或 query cursor。

## 2. 顺序与时间语义

`seq/createdAt/originSeq/originCreatedAt` 的唯一规范见
[Message Envelope 第 3 节](./message/envelope.md#3-顺序与来源时间)。message wire 没有客户端权威的
`date` 字段，content 中的业务时间也不能替代外层 `createdAt`。

## 3. 外层 Message

`FederatedMessage`、Address、ThreadAddress、QuoteTarget 和 BlobDescriptor 的唯一规范见
[Message Envelope 第 1 节](./message/envelope.md#1-wire-类型)。

### 3.1 协议 identity 与坐标派生

直接来源 identity、reply/media/bundle 坐标见
[Message Envelope 第 4 节](./message/envelope.md#4-identity-与不可变性)及
[第 7 节](./message/envelope.md#7-引用坐标)。

### 3.2 不可变 identity 与重复消息

不可变字段、重放和冲突处理见
[Message Envelope 第 4 节](./message/envelope.md#4-identity-与不可变性)。

## 4. `ContentType`

```ts
type CoreContentType =
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

type ContentType = CoreContentType | ExtensionId;
```

这 10 个值是 v1 核心集合。extension message 的 `contentType` 必须等于定义它的 extension capability ID；
发送方只有在接收 peer 的最新有效 v1 discover response 和 Health `acceptedExtensions` 中都存在该 ID 时
才可以发送。它不得把未声明能力、软件版本、
历史成功响应或反向消息当作支持证明。

consumer 收到自己不支持的合法 `ExtensionId` 时必须：

1. 在本地有限的 body、字符串、数组和 object 上限内校验外层 message，并确认 `content` 编码一个 JSON object；
2. 不解释、不展示、不持久化该 message，不下载 `assets`，也不生成 processing receipt；
3. 将该 sequence 作为 unsupported hole，允许 `scannedThrough` 和 thread cursor 正常前进并继续处理同页其他 item；
4. 只可记录有上限的 extension ID 聚合诊断，不得保存完整未知 content。

不符合 `ExtensionId` grammar 的未知 `contentType` 仍是 malformed item，必须拒绝。升级后只处理随后收到的
受支持消息；v1 不保证恢复升级前已跳过的 extension message。extension message 不得降级成核心文本或其他
核心类型，也不得授予 identity、authorization、membership 或其他核心状态。

## 5. `PURE_TEXT`

唯一规范与完整示例见 [Text](./message/text.md)。

### 5.1 Inline entity 与 mention

inline entity grammar、escape 和 mention 处理见 [Text 第 3 节](./message/text.md#3-inline-entity)。

## 6. 单资源媒体

IMAGE、VIDEO、AUDIO 和 FILE 的唯一规范与示例见 [Media](./message/media.md)。

## 7. `GALLERY`

严格 item 联合类型和混合示例见 [Media 第 4 节](./message/media.md#4-gallery)。

## 8. `LINK`

唯一规范、真正可选字段和缩略图组合见 [Link](./message/link.md)。

## 9. `INVITE`

唯一规范、P2P 联合约束和示例见 [Invite](./message/invite.md)。

## 10. `CALL`

唯一规范、outcome 矩阵和 connected/未 connected 示例见
[Call Record](./message/call-record.md)。`durationMs` 是本地派生值，不属于 federation wire。

## 11. `FORWARD`

唯一规范、bundle 图、局部引用和示例见 [Forward](./message/forward.md)。wire card 只携带 `bundleId`；
summary 和 count 由接收方验证 bundle 后在本地生成。

## 12. Processing Receipt、群提交与权威分发

Processing receipt 见 [Message Envelope 第 8 节](./message/envelope.md#8-processing-receipt)。群成员 home
server 只能提交本域成员 authored message；group origin 接受并形成自己的权威 timeline 坐标后向 mirror
分发。mirror 只接受已知 origin，且不得继续向第三个 peer 发布。
