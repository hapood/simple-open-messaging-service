# Media Messages

Status: `DRAFT` — Final Review (`v1.0.0-draft.2`)

This document defines `IMAGE`, `VIDEO`, `AUDIO`, `FILE`, and `GALLERY`. See [Message Envelope](./envelope.md) for the shared outer message shape, asset descriptors, coordinates, and receive rules, and [Resources, Section 3](../resources.md#3-media-resources) for media HTTP operations.

## 1. Common rules

Media content carries no publisher display URL. Each resource is associated by `digest` with a descriptor in the outer message `assets`. Each `assets` entry uses the shared `BlobDescriptor { digest, bytes }` defined in [Message Envelope](./envelope.md#1-wire-types); `bytes` is the resource's sole declared length. The consumer constructs a media request from the validated message thread, author, sequence, and digest.

- `digest` MUST be `Sha256Hex`.
- Every content digest MUST have exactly one `BlobDescriptor` with the same digest in the outer message `assets`.
- A consumer may enforce local size and quota limits using `BlobDescriptor.bytes` before download. After download, it MUST still verify that the actual byte count equals `bytes` and that the SHA-256 of the actual bytes equals `digest`.
- Media content MUST NOT repeat the resource length as `size`, `bytes`, or any
  other field; the matching outer `BlobDescriptor.bytes` is authoritative.
- `width/height` are `PositiveSafeInteger` pixel dimensions.
- `duration` is a positive finite number of seconds.
- `name` is required for every media kind, including standalone images and
  GALLERY image items. It is the retained display filename, carried in message
  content rather than inferred from a CAS URL or download response. Publishers
  MUST preserve it across synchronization hops; it is covered by the message
  payload digest. It is not part of the CAS resource identity.
- `name/mimeType` are non-empty, untrusted display strings. They MUST NOT be used as paths, security assertions, or instructions to execute active content.
- Every object is a closed schema; fields unrelated to its media kind MUST be omitted.

## 2. Single-resource types

```ts
interface ImageContent {
  digest: Sha256Hex;
  name: string;
  width: PositiveSafeInteger;
  height: PositiveSafeInteger;
}

interface NamedMediaContent {
  digest: Sha256Hex;
  name: string;
  mimeType: string;
}

interface FileContent extends NamedMediaContent {}

interface VideoContent extends NamedMediaContent {
  width: PositiveSafeInteger;
  height: PositiveSafeInteger;
  duration: PositiveFiniteNumber;
}

interface AudioContent extends NamedMediaContent {
  duration: PositiveFiniteNumber;
}
```

Each `IMAGE`, `VIDEO`, `AUDIO`, and `FILE` MUST reference exactly one digest. The outer message `assets` MUST contain exactly one descriptor with that digest.

## 3. Single-resource content examples

Each object below is the result of parsing the outer message `content` once as JSON; on the wire it MUST be encoded as a JSON string. The example digests use repeated characters only for readability and are all 64 lowercase hexadecimal characters long.

### 3.1 IMAGE

```json
{
  "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "width": 1600,
  "height": 900,
  "name": "photo.png"
}
```

Corresponding outer message fields:

```json
{
  "contentType": "IMAGE",
  "content": "{\"digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"height\":900,\"name\":\"photo.png\",\"width\":1600}",
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
  "width": 1920,
  "height": 1080,
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

The outer message shape for VIDEO, AUDIO, and FILE follows the IMAGE example: `contentType` uses the corresponding value, `content` is the JSON string encoding of the object above, and `assets` contains one descriptor with the same digest. Its `bytes` is the resource's declared length.

## 4. GALLERY

```ts
interface GalleryItemBase {
  digest: Sha256Hex;
}

interface GalleryImageItem extends GalleryItemBase {
  kind: 'IMAGE';
  name: string;
  width: PositiveSafeInteger;
  height: PositiveSafeInteger;
}

interface GalleryVideoItem extends GalleryItemBase {
  kind: 'VIDEO';
  name: string;
  mimeType: string;
  width: PositiveSafeInteger;
  height: PositiveSafeInteger;
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

`items` MUST be non-empty and preserve display order. Multiple items may reference the same digest and share one descriptor. The deduplicated set of all item digests MUST exactly equal the digest set in the outer message `assets`.

### 4.1 Mixed GALLERY example

```json
{
  "items": [
    {
      "kind": "IMAGE",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "width": 1600,
      "height": 900,
      "name": "photo.png"
    },
    {
      "kind": "VIDEO",
      "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "name": "demo.mp4",
      "mimeType": "video/mp4",
      "width": 1920,
      "height": 1080,
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

The outer message `assets` MUST contain the four digests above, each exactly once. If multiple items use the same digest, `assets` still contains only one descriptor for it.

## 5. Required rejections

A consumer MUST reject at least the following cases:

- A single-resource type has other than one digest or descriptor.
- The content-digest set differs from the `assets` digest set.
- A digest, descriptor `bytes`, `width`, `height`, or `duration` violates its required type.
- Media content repeats the resource length instead of using only the outer descriptor.
- A required `name` or `mimeType` is absent or empty.
- GALLERY `items` is empty.
- An item lacks a field required by its kind.
- An item carries a field allowed only for another kind, such as `duration` on IMAGE.
- An object contains an unknown field.
