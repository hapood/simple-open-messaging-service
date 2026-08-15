# `PURE_TEXT` Message

状态：`RELEASE CANDIDATE`（`v1.0-rc.2`）

本文定义 `PURE_TEXT` 的解析后 content、引用回复和 inline entity。共用外层字段与接收规则见
[Message Envelope](./envelope.md)。

## 1. Content schema

```ts
interface PureTextContent {
  text: string;
}
```

`PureTextContent` 是消息外层结构的 `content` 执行一次 JSON 解析后的 closed object。`text` MUST 非空、是有效
Unicode，并且不得包含未配对 surrogate。它不得携带 HTML、编辑器私有 JSON node 或可执行 markup。

v1 不规定统一最大长度。publisher 和 consumer 可以设置本地安全上限，但不得把 mention 展开后的字符数、
JSON 编码长度和 UTF-8 byte 长度视为相同数值。

## 2. Reply

普通文本省略消息外层结构的 `quoteTarget`。引用回复必须满足：

- 消息外层结构存在 `quoteTarget`；
- `quoteTarget` 指向同一 thread 中当前权威 publisher 的目标 message；
- 消息外层结构的 `assets` 为空。

引用不携带作者、正文或 content type preview。consumer 从本地目标消息生成摘要；目标不可用时显示
不可用占位。这样引用只有一个权威坐标，不存在 preview 与目标内容冲突的问题。

## 3. Inline entity

inline entity 的 canonical wire 形式是：

```text
[@<label>](socfp://<entity-type>/<percent-encoded-id>)
```

v1 支持 user mention 和 group-wide audience mention：

```text
[@张三](socfp://user/zhangsan%40example.com)
[@所有人](socfp://audience/all)
```

`socfp` 是消息正文中的标识符 scheme，不是 transport scheme；实现不得（MUST NOT）对该 URI 发起网络请求，
也不定义相对引用、base URI resolution、query、fragment、port 或 userinfo。v1 canonical URI 只有以下两种
ASCII 形式：

```abnf
socfp-user     = "socfp://user/" user-account "%40" domain
socfp-audience = "socfp://audience/all"
```

其中 `user-account` 和 `domain` 分别严格使用[主协议](../protocol.md#62-联邦共享类型shared-federation-types)
定义的 `UserAccount` 与 `Domain` ASCII grammar。分隔二者的 `@` 必须（MUST）编码为大写十六进制的 `%40`；
其他字符不得（MUST NOT）进行 percent-encoding。因此 `%4a`、`%4A`、对 unreserved character 的编码、双重编码、
空 host、额外 path segment、port、fragment 或 query 均不是 canonical v1 entity。

两个 v1 entity URI 只有在完整 ASCII 字节序列相等时才相等；consumer 不得（MUST NOT）使用通用 URL
normalization、host case folding、默认端口消除或 percent-decoding 后再编码来建立另一种等价形式。解析成功后，
user entity 的语义 identity 是 decoded `UserAccount@Domain`，audience entity 的语义 identity 固定为 `all`。

- user entity 的 decoded ID 是规范化的 `account@domain`；label 只是展示快照。
- `audience/all` 只能出现在 GROUP thread。
- scheme 和 entity type 比较区分大小写；publisher 必须使用上述唯一 canonical 形式。
- label 中的 `\`、`[`、`]` 分别编码为 `\\`、`\[`、`\]`。普通正文中的 literal `[` 写成 `\[`，
  literal `\` 写成 `\\`。
- malformed、被 escape 或不完整的 token 按普通可读文本展示，不得产生 mention 权限或
  attention 语义。
- consumer 必须用 text node/component 安全渲染，不得把 entity 当 HTML。

author server 在首次持久化前验证 mention 是否适用于 thread；group origin 接受 submission 时再次验证
群上下文，但不改写合法 token。

## 4. 完整普通文本示例

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
  "seq": 42,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000000000,
  "clientMessageId": "018f0f4e-7b2a-7c3d-8e9f-0123456789ab",
  "contentType": "PURE_TEXT",
  "content": "{\"text\":\"你好 [@张三](socfp://user/zhangsan%40example.com)\"}",
  "assets": []
}
```

## 5. 完整 reply 示例

```json
{
  "thread": {
    "type": "P2P",
    "participants": [
      { "account": "alice", "domain": "a.example" },
      { "account": "bob", "domain": "b.example" }
    ]
  },
  "author": { "account": "bob", "domain": "b.example" },
  "seq": 57,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000005000,
  "clientMessageId": null,
  "quoteTarget": {
    "creator": { "account": "alice", "domain": "a.example" },
    "targetSeq": 42
  },
  "contentType": "PURE_TEXT",
  "content": "{\"text\":\"收到\"}",
  "assets": []
}
```

## 6. 必须拒绝

consumer MUST 拒绝至少以下情况：

- `text` 为空、不是 string 或包含未配对 surrogate；
- content 含未知字段，包括旧版内嵌 `quote`；
- `quoteTarget.targetSeq` 不是 `PositiveSafeInteger`；
- `quoteTarget` 指向其他 thread；
- `PURE_TEXT` 的消息外层结构 `assets` 非空。
