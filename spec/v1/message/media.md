# Media Messages

状态：`RELEASE CANDIDATE`（`v1.0.0-rc.0`）

本文定义 `IMAGE`、`VIDEO`、`AUDIO`、`FILE` 和 `GALLERY`。共用消息外层结构、asset status、坐标和
接收规则见 [Message Envelope](./envelope.md)，媒体 HTTP operation 见 [Resources](../resources.md) 第 3 节。

## 1. 通用规则

media content 不携带 publisher 展示 URL。每项资源使用 `digest` 与消息外层结构的 `assets` descriptor
关联。`assets` 的元素使用 [Message Envelope](./envelope.md#1-wire-类型) 定义的共享
`BlobDescriptor { digest, bytes }`；`bytes` 是资源的唯一声明长度。consumer 根据已验证消息的
thread、author、seq 和 digest 构造媒体请求。

- `digest` 必须是 `Sha256Hex`。
- 每个 content digest 必须能在消息外层结构的 `assets` 中找到唯一的同 digest `BlobDescriptor`。
- consumer 可以在下载前根据 `BlobDescriptor.bytes` 执行本地大小和 quota 检查；下载完成后仍必须验证
  实际字节数等于 `bytes`，且实际 bytes 的 SHA-256 等于 `digest`。
- `w/h` 是 `PositiveSafeInteger` 像素。
- `duration` 是正有限秒数。
- `name/mimeType` 是非空、不可信的展示字符串，不能用于路径、安全判定或主动内容执行。
- 每个 object 都是 closed schema；与媒体 kind 无关的字段必须省略。

## 2. 单资源类型

```ts
interface ImageContent {
  digest: Sha256Hex;
  w: PositiveSafeInteger;
  h: PositiveSafeInteger;
}

interface NamedMediaContent {
  digest: Sha256Hex;
  name: string;
  mimeType: string;
}

interface FileContent extends NamedMediaContent {}

interface VideoContent extends NamedMediaContent {
  w: PositiveSafeInteger;
  h: PositiveSafeInteger;
  duration: PositiveFiniteNumber;
}

interface AudioContent extends NamedMediaContent {
  duration: PositiveFiniteNumber;
}
```

`IMAGE`、`VIDEO`、`AUDIO` 和 `FILE` 必须各引用恰好一个 digest；消息外层结构的 `assets` 必须包含
恰好一个同 digest descriptor。

## 3. 单资源 content 示例

下列左侧 object 是对消息外层结构的 `content` 执行一次 JSON 解析后的结果；传输时必须再编码成 JSON
string。示例 digest 使用重复字符只是为了便于阅读，长度均为 64 个小写十六进制字符。

### 3.1 IMAGE

```json
{
  "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "w": 1600,
  "h": 900
}
```

对应消息外层字段：

```json
{
  "contentType": "IMAGE",
  "content": "{\"digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"w\":1600,\"h\":900}",
  "assets": [
    {
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bytes": 345678
    }
  ]
}
```

### 3.2 VIDEO

```json
{
  "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "name": "demo.mp4",
  "mimeType": "video/mp4",
  "w": 1920,
  "h": 1080,
  "duration": 12.5
}
```

### 3.3 AUDIO

```json
{
  "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "name": "voice.m4a",
  "mimeType": "audio/mp4",
  "duration": 8.25
}
```

### 3.4 FILE

```json
{
  "digest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "name": "report.pdf",
  "mimeType": "application/pdf"
}
```

VIDEO、AUDIO 和 FILE 的消息外层结构与 IMAGE 示例相同：`contentType` 使用对应值，`content` 是上述
object 的 JSON string，`assets` 包含一个 digest 相同的 descriptor；其 `bytes` 是资源的声明长度。

## 4. GALLERY

```ts
interface GalleryItemBase {
  digest: Sha256Hex;
}

interface GalleryImageItem extends GalleryItemBase {
  kind: 'IMAGE';
  w: PositiveSafeInteger;
  h: PositiveSafeInteger;
}

interface GalleryVideoItem extends GalleryItemBase {
  kind: 'VIDEO';
  name: string;
  mimeType: string;
  w: PositiveSafeInteger;
  h: PositiveSafeInteger;
  duration: PositiveFiniteNumber;
}

interface GalleryAudioItem extends GalleryItemBase {
  kind: 'AUDIO';
  name: string;
  mimeType: string;
  duration: PositiveFiniteNumber;
}

interface GalleryFileItem extends GalleryItemBase {
  kind: 'FILE';
  name: string;
  mimeType: string;
}

type GalleryItem =
  | GalleryImageItem
  | GalleryVideoItem
  | GalleryAudioItem
  | GalleryFileItem;

interface GalleryContent {
  items: GalleryItem[];
}
```

`items` 必须非空并保持展示顺序。同一 digest 可以被多项引用并共享唯一 descriptor；所有 item digest
的去重集合必须与消息外层结构的 `assets` digest 集合完全相等。

### 4.1 混合 GALLERY 示例

```json
{
  "items": [
    {
      "kind": "IMAGE",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "w": 1600,
      "h": 900
    },
    {
      "kind": "VIDEO",
      "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "name": "demo.mp4",
      "mimeType": "video/mp4",
      "w": 1920,
      "h": 1080,
      "duration": 12.5
    },
    {
      "kind": "AUDIO",
      "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "name": "voice.m4a",
      "mimeType": "audio/mp4",
      "duration": 8.25
    },
    {
      "kind": "FILE",
      "digest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "name": "report.pdf",
      "mimeType": "application/pdf"
    }
  ]
}
```

消息外层结构的 `assets` 必须包含上述四个 digest，每个只出现一次。若多个 item 使用同一 digest，
`assets` 仍只包含一个 descriptor。

## 5. 必须拒绝

consumer MUST 拒绝至少以下情况：

- 单资源类型的 digest 或 descriptor 数量不是一个；
- content digest 与 `assets` digest 集合不同；
- digest、descriptor bytes、w、h 或 duration 不符合对应数值类型；
- `name/mimeType` 缺失或为空；
- GALLERY `items` 为空；
- item 缺少其 kind 的必填字段；
- item 带有其他 kind 才允许的字段，例如 IMAGE 带 `duration`；
- object 含未知字段。
