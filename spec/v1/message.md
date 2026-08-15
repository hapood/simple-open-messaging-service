# Simple Open Chat Federation Protocol v1 Message

状态：`RELEASE CANDIDATE`（`v1.0-rc.2`）

本文是 federation message 规范的总入口。消息外层结构、来源坐标、幂等、资源 descriptor 和 processing
receipt 见 [Message Envelope](./message/envelope.md)；每种 content 的唯一详细定义见下表。

Feed 与 query 分页语义见 [Message Feed and Query](./message-feed.md)，资源 HTTP operation 见
[Resources](./resources.md)。

## 1. 类型与处理总览

`content` 在消息外层结构中始终是 JSON object 编码后的 string。consumer MUST 先校验
`FederatedMessage`，再根据 `contentType` 对 `content` 执行一次 JSON 解析，并严格校验对应 closed
schema。

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

consumer 对每个 item 的通用处理顺序：

1. 校验消息外层结构。
2. 解析并校验 content。
3. 校验 content digest、`size` 与 asset descriptor。
4. 按直接来源坐标幂等接收。
5. 对实际数组和 descriptor 执行本地 quota；不得信任可推导的远端 count。
6. 持久化 message 和 durable resource work，再按资源 operation 拉取 bytes。

坏 item 和资源失败不得永久阻塞同页其他合法消息或 query cursor。

## 2. 顺序与时间语义

`seq/createdAt/originSeq/originCreatedAt` 的唯一规范见
[Message Envelope 第 3 节](./message/envelope.md#3-顺序与来源时间)。message wire 没有客户端权威的
`date` 字段，content 中的业务时间也不能替代外层数据库时间。

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

这 10 个值是 v1 完整集合。consumer MUST 拒绝未知值，不得降级成普通文本。

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

## 13. 非规范性实现能力建议

以下只是默认本地能力建议，不是 wire 合法性上限：

| 对象 | 建议默认能力 |
| ---- | ------------ |
| PURE_TEXT 用户原始输入 | canonical mention 转换前最多 4000 Unicode code points |
| 单条解析后 content | 最多 64 KiB UTF-8 bytes |
| GALLERY items | 创建时最多 10 项 |
| 单个媒体 asset | 默认自动本地化上限 50 MiB |
| LINK URL | 创建时最多 2048 Unicode code points |
| Forward bundle | 总 message 500、总 asset 500、JSON 2 MiB |
| feed/query page | 建议 100 items，并受本地 byte budget 约束 |

接收方必须按实际解析数量、descriptor `bytes`、HTTP 响应和累计下载 bytes 执行 quota。发送方不能通过
声明字段扩大接收方的本地上限。
