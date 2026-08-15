# `LINK` Message

状态：`RELEASE CANDIDATE`（`v1.0-rc.2`）

本文定义带页面 metadata 和可选 CAS 缩略图的 `LINK` 卡片。正文中的普通 URL 仍属于 `PURE_TEXT`，
不使用本类型。共用消息外层结构见 [Message Envelope](./envelope.md)。

## 1. Content schema

```ts
interface LinkPreviewContent {
  url: string;
  title: string;
  description: string;
  siteName?: string;
  imageDigest?: Sha256Hex;
  faviconDigest?: Sha256Hex;
}
```

这是 closed schema。`url/title/description` 始终必须出现；后三个字段是真正可以独立省略的字段，不得用
`null` 代替省略。

## 2. 字段规则

- `url` MUST 是绝对 `http` 或 `https` URL。
- `url` 是用户可见的业务链接，不是媒体下载地址或资源授权 proof。
- consumer 不得仅因为收到 LINK message 就自动访问页面 URL。
- `title` 和 `description` 可以是空字符串。
- `siteName` 存在时必须是 string；v1 不要求它非空。
- `imageDigest/faviconDigest` 存在时必须是 `Sha256Hex`，并分别对应消息外层结构中同 digest 的 asset
  descriptor。
- 两个 digest 可以相同。消息外层结构的 `assets` 是二者去重后的完整集合，因此长度可以是 0、1 或 2。

## 3. 无缩略图示例

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
  "seq": 61,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000010000,
  "clientMessageId": null,
  "contentType": "LINK",
  "content": "{\"url\":\"https://example.com/article\",\"title\":\"Example article\",\"description\":\"A short summary\"}",
  "assets": []
}
```

## 4. 两个缩略图示例

解析后的 content：

```json
{
  "url": "https://example.com/article",
  "title": "Example article",
  "description": "A short summary",
  "siteName": "Example",
  "imageDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "faviconDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

消息外层结构必须包含：

```json
{
  "contentType": "LINK",
  "content": "{\"url\":\"https://example.com/article\",\"title\":\"Example article\",\"description\":\"A short summary\",\"siteName\":\"Example\",\"imageDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"faviconDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}",
  "assets": [
    {
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bytes": 45678
    },
    {
      "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "bytes": 1234
    }
  ]
}
```

如果 `imageDigest === faviconDigest`，`assets` 只能包含一个 descriptor。

## 5. 必须拒绝

consumer MUST 拒绝至少以下情况：

- `url` 不是绝对 HTTP(S) URL；
- `title` 或 `description` 缺失或不是 string；
- 可选字段使用 `null`；
- digest 不是 `Sha256Hex`；
- content digest 的去重集合与消息外层结构的 `assets` 不相等；
- content 或消息外层结构包含该 schema 不允许的未知字段。
