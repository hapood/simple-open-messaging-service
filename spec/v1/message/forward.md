# `FORWARD` Message and Bundle

状态：`RELEASE CANDIDATE`（`v1.0.0-rc.0`）

本文定义 timeline 中的 `FORWARD` 卡片和它引用的不可变 forward bundle。消息卡片只保存摘要和 bundle
root ID；完整 bundle 通过资源 operation 获取。共用消息外层结构见 [Message Envelope](./envelope.md)，
HTTP、授权和错误契约见 [Resources](../resources.md) 第 4 节。

## 1. 外层卡片 content

```ts
interface ForwardCardContent {
  bundleId: string;
}
```

这是没有可选字段的 closed schema。

- `bundleId` 是 publisher 生成、区分大小写的 opaque root ID。
- `bundleId` 解码后的 UTF-8 长度必须为 `1..26` bytes，且不得包含 NUL 或 `/`。
- publisher 必须保证自己可查询的 bundle ID 不冲突，发布后不得把同一 ID 绑定到其他 bundle。
- FORWARD 消息外层结构的 `assets` 必须为空；bundle asset 不在卡片上重复列出。
- consumer 下载并验证 bundle 后，从实际内容生成本地摘要、message count 和 asset count；这些本地派生
  字段不属于 federation wire。

## 2. 外层消息完整示例

```json
{
  "thread": {
    "type": "P2P",
    "participants": [
      { "account": "alice", "domain": "a.example" },
      { "account": "bob", "domain": "b.example" }
    ]
  },
  "author": { "account": "alice", "domain": "a.example" },
  "seq": 91,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000200000,
  "contentType": "FORWARD",
  "content": "{\"bundleId\":\"bundle-demo-01\"}",
  "assets": []
}
```

## 3. Bundle schema

```ts
interface ForwardWireBundle {
  id: string;
  messages: ForwardBundleMessage[];
  children: ForwardChildBundle[];
  assets: BlobDescriptor[];
}

interface ForwardChildBundle {
  id: string;
  messages: ForwardBundleMessage[];
}

interface ForwardAuthorSnapshot extends Address {
  displayName: string;
  avatarDigest?: Sha256Hex;
}

interface ForwardBundleMessageBase {
  id: PositiveSafeInteger;
  author: ForwardAuthorSnapshot;
  sentAt: EpochMilliseconds;
  quoteTargetId?: PositiveSafeInteger;
}

type ForwardBundleMessage = ForwardBundleMessageBase &
  (
    | {
        contentType: 'FORWARD';
        content: JsonObjectString;
        childBundleId: string;
      }
    | {
        contentType: Exclude<ContentType, 'FORWARD'>;
        content: JsonObjectString;
      }
  );
```

`ForwardWireBundle.assets` 使用 [Message Envelope](./envelope.md#1-wire-类型) 定义的共享
`BlobDescriptor { digest, bytes }`。

所有 object 都是 closed schema。inner `content` 使用对应 message content schema，但依赖消息外层结构
thread 或 `quoteTarget` 的约束在 bundle 中不适用。

## 4. Bundle 图与局部 ID

- response `id` 必须等于卡片和 request path 的 `bundleId`，只有这个父 ID 可以独立查询。
- `children[]` 是全部层级 child bundle 的扁平集合，不递归嵌套。
- `children[].id` 在当前 response 中必须唯一、不得等于父 `id`，也不得作为独立资源请求目标。
- 父 `messages[]` 和每个 child `messages[]` 分别拥有独立的 message ID 空间。
- 同一 `messages[]` 中的 `id` 必须唯一；不同 bundle 数组可以复用相同 ID。
- `quoteTargetId` 只能引用同一个 enclosing `messages[]` 中的 message ID，不得跨 bundle。
- inner `contentType: 'FORWARD'` 必须携带 `childBundleId`，且它必须匹配一个 `children[].id`。
- 非 FORWARD inner message 必须省略 `childBundleId`。
- child 引用允许自环和互环；consumer 不递归展开图，只扫描父 messages 和扁平 children 各一次。

## 5. Author、quote 与 asset

- `author.account/domain` 必须组成合法 `UserAccount` Address。
- `displayName` 是不可信展示 snapshot。
- `avatarDigest` 是真正可选字段；存在时必须包含在父 `assets` 中。
- `quoteTargetId` 是条件字段；存在时必须指向同一个 enclosing `messages[]` 中的目标。引用不携带 preview。
- 文件名、MIME 和媒体 kind 来自引用 digest 的 inner content，不在 asset descriptor 中重复传输。
- 全部 author avatar 和 inner content digest 的去重集合必须与父 `assets` 完全相等。
- child 不拥有独立 assets 数组。
- consumer 从父 messages、全部 children messages 和 assets 的实际长度计算本地 count，并可持久化用于
  quota、GC 和管理统计；这些 count 不由 publisher 在 wire 中声明。

inner INVITE 和 CALL 只是不可变历史展示，不授予当前 membership、群权限或实时 call 状态。inner
inviter/caller 由 enclosing `ForwardBundleMessage.author` 表示；bundle 不表达 CALL callee。

inner extension message 只能在目标 peer 的有效 v1 discover response 与 Health 都允许对应 capability 时发送。consumer 若仍遇到
自己不支持的合法 extension type，必须放弃整个 bundle，不持久化部分 closure、不下载其 assets；承载该
bundle 的外层 FORWARD card 可以保留为不可展开状态。未知 inner content 不得阻塞 message query cursor。

## 6. 最小完整 bundle 示例

以下是第 2 节卡片引用的完整 response data。HTTP success envelope 见 Resources。

```json
{
  "id": "bundle-demo-01",
  "messages": [
    {
      "id": 1,
      "author": {
        "account": "alice",
        "domain": "a.example",
        "displayName": "Alice"
      },
      "sentAt": 1769990000000,
      "contentType": "PURE_TEXT",
      "content": "{\"text\":\"hello\"}"
    }
  ],
  "children": [],
  "assets": []
}
```

## 7. Child 引用示例

父 messages 中的 inner FORWARD：

```json
{
  "id": 2,
  "author": {
    "account": "alice",
    "domain": "a.example",
    "displayName": "Alice"
  },
  "sentAt": 1769991000000,
  "contentType": "FORWARD",
  "content": "{\"bundleId\":\"child-01\"}",
  "childBundleId": "child-01"
}
```

同一 response 的 `children[]` 必须包含：

```json
{
  "id": "child-01",
  "messages": [
    {
      "id": 1,
      "author": {
        "account": "bob",
        "domain": "b.example",
        "displayName": "Bob"
      },
      "sentAt": 1769980000000,
      "contentType": "PURE_TEXT",
      "content": "{\"text\":\"nested message\"}"
    }
  ]
}
```

`content.bundleId`、`childBundleId` 和 `children[].id` 必须相等。child ID 只在当前父 response 中解析，
不得对 `/forward-bundles/child-01` 发起独立请求。

## 8. 获取、验证与提交

consumer 必须先验证完整 bundle 的 closed shape、引用闭合、局部 ID、实际 count 和 asset 集合，再在一个提交
边界内保存。不得保存能够参与展示或资源授权的部分 bundle。

bundle 和 CAS 请求始终绑定发现它的外层 FORWARD message。媒体请求使用该消息的 thread、author、权威
publisher `seq` 和 digest；不得使用 child ID、inner author、bundle-local message ID 或 quote target
作为授权坐标。

## 9. 必须拒绝

consumer MUST 拒绝至少以下情况：

- card `bundleId`、request path 和 response `id` 不相等；
- card 或 bundle response 携带 wire 不允许的摘要、version 或 count 字段；
- child ID 重复、等于父 ID，或 `childBundleId` 没有匹配 child；
- FORWARD inner message 缺少 `childBundleId`；
- 非 FORWARD inner message 携带 `childBundleId`；
- 同一 messages 数组的 message ID 重复；
- `quoteTargetId` 不存在于同一个 enclosing messages 数组；
- author 或 content digest 集合与父 `assets` 不相等；
- 任一 object 含未知字段；
- bundle 只能部分读取、验证或持久化。
