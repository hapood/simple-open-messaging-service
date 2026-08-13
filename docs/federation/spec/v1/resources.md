# Federation v1 资源接口（Resources）

状态：`REVIEW`
规范性：本文全部为规范性要求，除非段落明确标记为“非规范性实现说明”。

本文定义 Federation v1 的用户资料、媒体和转发包三个读取 operation。实现必须（MUST）同时遵守：

- [主协议第 6.1、6.2 节](./protocol.md#6-通用协议规则common-protocol-rules)定义的 JSON、未知字段与
  Federation 共享类型；
- [主协议第 7.2、7.3 节](./protocol.md#7-响应错误与调用方动作responses-errors-and-caller-actions)定义的
  成功及错误 envelope；
- [传输与安全第 3.1–3.5 节](./transport-security.md#3-请求构造总览request-construction-overview)定义的
  request target、空 body digest、header、HTTP Message Signature 与验证顺序；
- [错误码注册表](./errors.md#稳定错误码注册表stable-code-registry)定义的 status/code 组合和调用方动作。

三个 operation 都使用主协议第 3 节的 `recognized signed` 鉴权上下文；签名覆盖完整 path 和原始 query，
服务器必须（MUST）在读取资源或产生成功响应前完成签名、认可关系及本文规定的资源授权。本文下列字段表、
限制和示例是规范的一部分，不由非规范性 JSON Schema 补充或替代。

## 1. 公共请求规则（Common Request Rules）

三个 operation 的公共 HTTP profile 是：

| 项目                            | 规范值或要求                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------- |
| Method                          | `GET`                                                                             |
| Request body                    | 不允许；精确长度为零 bytes                                                        |
| `Content-Type`                  | 不得（MUST NOT）发送                                                              |
| `Content-Length`                | 可以省略或发送 `0`；不参与 v1 签名                                                |
| `Date`                          | 必须发送；与 `Signature-Input.created` 表示同一 UTC 整秒                          |
| `Content-Digest`                | 必须固定为零长度 body 的 `sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:` |
| `Signature-Input` / `Signature` | 必须发送；使用传输与安全第 3.4 节的唯一 `sig1` profile                            |
| 固定签名组件                    | `"@method" "@path" "@query" "@authority" "date" "content-digest"`，顺序不得改变   |
| Request authentication          | 主协议 `recognized signed`                                                        |
| JSON success/error response     | `application/json`；分别使用主协议成功 envelope 与 errors.md error envelope       |
| Media bytes success response    | `application/octet-stream`；不使用 JSON envelope                                  |

发送一个 JSON object、`null`、`{}`、换行或任何其他 byte 都不是“空 GET body”。非零 body、GET 上的
`Content-Type`、错误的空 body digest 或重复安全 header 必须（MUST）在业务授权前按
[errors.md 共享验证失败映射](./errors.md#共享验证失败映射shared-validation-failure-mapping)拒绝。

除媒体 operation 明确列出的 query 与 `Range` 外，请求不得（MUST NOT）携带其他 query parameter；同名
parameter 重复、空值、无法 percent-decode、非规范编码或未知 parameter 必须（MUST）以 HTTP
`400 FEDERATION_MALFORMED` 拒绝。path parameter 必须先按传输与安全第 3.1 节逐变量编码；接收方只执行
一次 UTF-8 percent-decoding，再按本文 grammar 验证，不得（MUST NOT）二次 decoding、大小写折叠或
decode 后重新编码再验签。

公共签名、认可或服务器故障按 errors.md 返回。本文所称 HTTP `200` 业务错误均使用规范 JSON error
envelope；consumer 必须（MUST）先按 `Content-Type` 和 envelope 判定错误，不得（MUST NOT）把它当作成功
资源。JSON 成功响应使用 protocol.md 的 success data envelope。

## 2. 用户资料（User Profile）

### 2.1 Operation 与参数

```http
GET /s2s/v1/users/:account
```

| 项目           | 要求                                               |
| -------------- | -------------------------------------------------- |
| Path variable  | `account: UserAccount`                             |
| Query          | 不允许                                             |
| Request body   | 第 1 节定义的零长度 body                           |
| Success        | HTTP `200` success data envelope；data 见第 2.2 节 |
| Business error | HTTP `200 NOT_FOUND` 或 `200 FEDERATION_PROFILE_NOT_DISCLOSED`；其他公共错误见第 2.3 节 |

`account` 必须（MUST）是 `UserAccount`，不得（MUST NOT）是 `GroupAccount`。请求不得携带 query 或 body。
该 operation 只解析 publisher 自己域名下的本地用户；请求者不得通过 path、query 或 header 指定另一
domain。任意已满足 `recognized signed` 的 peer 可以（MAY）查询该公开资料，不从查询本身获得 P2P、群、
消息或媒体权限。

### 2.2 成功响应

成功为 HTTP `200`、`Content-Type: application/json`，`data` 是以下 closed object：

```ts
interface PublicUserCard {
  account: UserAccount;
  domain: Domain;
  displayName: string;
  avatar: null | {
    b64: string;
    w: PositiveSafeInteger;
    h: PositiveSafeInteger;
  };
  profileRev: SafeInteger;
}
```

字段限制如下；长度按 Unicode code point 计，不按 UTF-8 byte 或 UTF-16 code unit 计：

| 字段          | 要求                                                                                |
| ------------- | ----------------------------------------------------------------------------------- |
| `account`     | 必须等于 path `account`；符合主协议 `UserAccount` grammar                           |
| `domain`      | 必须等于响应服务器的 canonical logical authority；符合主协议 `Domain` grammar       |
| `displayName` | 1–30 个 Unicode code point；不得含未配对 surrogate                                  |
| `avatar`      | `null`，或下述 closed avatar object                                                 |
| `avatar.b64`  | RFC 4648 padded Base64；长度 4–1,048,576 characters；严格解码后必须是非空图片 bytes |
| `avatar.w/h`  | 各自为 `PositiveSafeInteger`；`w * h <= 16000000`                                   |
| `profileRev`  | `SafeInteger`；同一用户单调非递减                                                   |

`account` 必须（MUST）等于规范化后的 path account，`domain` 必须（MUST）等于响应签名服务器的逻辑
authority。`avatar.b64` 是不带 `data:` prefix 的标准 Base64；解码必须（MUST）成功，`w`、`h` 是原图的
正整数像素尺寸，并必须（MUST）等于解码图片的实际宽高；不匹配时 consumer 必须拒绝该 profile，不能只
把声明尺寸用于预分配或展示。`avatar: null` 明确表示没有头像。`profileRev` 是该用户资料的单调非递减修订号；同一
`account/domain` 的较小或相等 revision 不得（MUST NOT）覆盖 consumer 已提交的较新资料。

未知 data 字段必须（MUST）拒绝。consumer 不得（MUST NOT）根据头像声明尺寸或展示名授予身份、
关系或资源访问权限。

本 operation 是按精确 account 查询的最小公共身份卡，只暴露定位与显示所需的 account、domain、展示名、
头像和 revision。它不得返回 `bio`、关系方向、所属群、presence、联系方式、删除原因或其他 peer 的可见性
信息。更完整的好友资料与群成员展示快照只通过 state-feed 在对应可见性成立时发布。v1 不提供模糊用户
搜索或账号枚举 operation。

### 2.3 错误与提交

- path account malformed：HTTP `400 FEDERATION_MALFORMED`。
- 账号不是 publisher 的现存本地用户：HTTP `200 NOT_FOUND`。
- 用户选择不向当前 peer 展示公开资料：publisher 可以（MAY）返回 HTTP
  `200 FEDERATION_PROFILE_NOT_DISCLOSED`。为避免暴露账号是否存在，publisher 也可以（MAY）将该结果隐私合并为
  HTTP `200 NOT_FOUND`；consumer 必须（MUST）接受两种行为，且不得（MUST NOT）据此判定账号是否存在。
- 公共签名、认可、identity、策略及服务故障：按 errors.md。

重复读取无副作用。consumer 必须（MUST）完整验证 envelope、字段、domain/account binding 与 Base64 后，
才能按 `profileRev` 原子提交；失败响应不得（MUST NOT）改变已保存资料。

### 2.4 完整 HTTP 示例

以下请求使用传输与安全第 3.6 节公布的非秘密测试 key，在固定时间 `1700000000` 对零长度 body 实际签名：

```http
GET /s2s/v1/users/alice HTTP/1.1
Host: b.example
Date: Tue, 14 Nov 2023 22:13:20 GMT
Content-Digest: sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:7Sw4YpBdQ16AZg4H90xMjZc3FhFbBfIBmo9L1kEzvIbnUfI5hLNhF2U6bPdFx+V4YLOqadmO3HxFapgJm+T9Dg==:
```

请求在 header 终止行后没有 body；没有 query，因此签名组件 `@query` 的值是 `?`。成功响应示例：

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"code":0,"message":"successful","data":{"account":"alice","domain":"b.example","displayName":"Alice","avatar":null,"profileRev":7}}
```

带头像的成功响应示例使用一个可严格解码的 1×1 PNG；`b64` 只包含 Base64 payload，不含
`data:image/png;base64,` prefix、空白或换行，末尾 `=` padding 属于字段值：

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "code": 0,
  "message": "successful",
  "data": {
    "account": "alice",
    "domain": "b.example",
    "displayName": "Alice",
    "avatar": {
      "b64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=",
      "w": 1,
      "h": 1
    },
    "profileRev": 8
  }
}
```

该 `b64` 解码为 68-byte、1×1、8-bit gray+alpha PNG，SHA-256 是
`b25378c2a1ade010d0a902ae86923f9f4e4ca9a918589ad3b07281299aaf8620`。SHA-256 不随 profile
传输，此处只用于让示例可以独立复核；consumer 仍必须实际解码图片并核对 `w/h`。

不存在的本地用户使用业务错误，而不是 HTTP `404`：

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"code":10001,"message":"user nobody not found","data":null}
```

## 3. 媒体资源（Media Resource）

### 3.1 Operation 与精确授权坐标

```http
GET /s2s/v1/media/:digest?fromAccount=:fromAccount&fromDomain=:fromDomain&toAccount=:toAccount&seq=:seq[&bundleId=:bundleId]
```

| 项目           | 要求                                                        |
| -------------- | ----------------------------------------------------------- |
| Path variable  | `digest: Sha256Hex`                                         |
| Query          | 第 3.1 节定义的四个必选、一个条件可选字段                   |
| Request header | 第 1 节公共 header；另可带一个第 3.2 节定义的 `Range`       |
| Request body   | 第 1 节定义的零长度 body                                    |
| Success        | HTTP `200` 完整 raw bytes，或 HTTP `206` 单 Range raw bytes |
| Error          | JSON error envelope；status/code 见第 3.3 节                |

参数是 closed set，且具有以下契约：

| 参数          | 位置  | 必选 | grammar 与语义                                                                |
| ------------- | ----- | ---- | ----------------------------------------------------------------------------- |
| `digest`      | path  | 是   | `Sha256Hex`；所请求完整资源 bytes 的 SHA-256                                  |
| `fromAccount` | query | 是   | `UserAccount`；精确消息作者 account                                           |
| `fromDomain`  | query | 是   | `Domain`；精确消息作者 domain                                                 |
| `toAccount`   | query | 是   | `Account`；P2P 时为签名 peer 的接收者，群聊时为 `GroupAccount`                |
| `seq`         | query | 是   | `DecimalString` 且数值不超过 `SafeInteger`；精确 outer message 的 `originSeq` |
| `bundleId`    | query | 否   | 非空、26 字符以内的 opaque string；仅在 digest 来自该转发 closure 时出现      |

Federated media content 不携带可下载 URL。consumer 必须先校验 content 中的显式 digest 与 outer
`assets` descriptor，再只从 outer `FederatedMessage` 派生本表坐标；不得使用 publisher-local `seq`、
`feedId`、展示 metadata 或自行猜测的 message 坐标。LINK 的页面 `url` 也不参与本 operation。

query key 的 wire 顺序固定为 `fromAccount`、`fromDomain`、`toAccount`、`seq`、可选 `bundleId`；不得
（MUST NOT）排序为其他顺序。`seq` 的数值范围是 `0..9007199254740991`。`bundleId` 按 UTF-8 编码后不得
超过 26 bytes，且不得包含 NUL 或 `/`；需要 percent-encoding 的 byte 按传输与安全第 3.1 节处理。

签名者 domain 只能（MUST）来自已验证的 HTTP Message Signature，不在 query 中重复声明。publisher 必须
（MUST）证明：由 `(fromAccount, fromDomain, toAccount, seq)` 唯一定位的未删除消息曾持久分配给签名
peer 对应的 thread audience，并且 `digest` 直接绑定该消息；若出现 `bundleId`，还必须（MUST）证明该
bundle 绑定同一消息且 digest 位于该 bundle 的完整 closure。仅拥有 digest、曾收到 feed page、猜中
bundle ID 或当前存在联邦关系均不足以授权。feed change 被确认或物理清理不得（MUST NOT）单独撤销已
持久分配消息的历史读取 proof；消息/资源删除或 audience 授权事实终止后的行为按其持久状态决定。

### 3.2 Range 请求与成功响应

不带 `Range` 时，成功响应为 HTTP `200` 和完整 bytes。服务器必须（MUST）发送：

- `Content-Type: application/octet-stream`
- `Content-Length: <完整长度>`
- `Accept-Ranges: bytes`

v1 支持一个 RFC 9110 byte range，包括 `bytes=start-end`、`bytes=start-` 与 `bytes=-suffixLength`。
成功单 Range 为 HTTP `206`，并必须（MUST）发送 `Content-Length`、`Accept-Ranges: bytes` 及精确
`Content-Range: bytes <start>-<end>/<完整长度>`。服务器不得（MUST NOT）压缩或转换 bytes。

`Content-Digest` 可以（MAY）出现在 `206`，其值必须（MUST）是当前 response body bytes 的
`sha-256` structured field。无论该 header 是否存在，consumer 都必须（MUST）按 offset 无重叠、无空洞地
重组，并在提交前验证完整 bytes 的 SHA-256 等于 path `digest`。连接中断、长度/range/digest 不一致或
未知 content coding 必须（MUST）丢弃当前 range，不得提交损坏内容。

语法有效但不可满足的单 Range 返回 HTTP `416`、JSON error envelope
`FEDERATION_RANGE_NOT_SATISFIABLE`，并必须（MUST）发送
`Content-Range: bytes */<完整长度>`。malformed Range、多 Range 或 v1 不支持的 range-unit 必须（MUST）
以 HTTP `400 FEDERATION_MALFORMED` 拒绝，不得静默降级为完整 `200`。

### 3.3 媒体错误

在发送任何资源 byte 前，publisher 必须（MUST）按下表分类；`message` 文本不是分类依据：

| 条件                                                                                                                   | HTTP / code                            | Consumer 动作                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| path、query、percent-encoding 或 Range malformed；重复/未知/乱序 query；多 Range                                       | `400 FEDERATION_MALFORMED`             | 修正请求；不得原样重试；不改变 peer lifecycle                                                      |
| pinned identity、双向认可或签名不满足公共验证                                                                          | errors.md 对应 `401` code              | 拒绝响应数据；按注册表处理；不得从错误文本推断文件状态                                             |
| 找不到由 `(fromAccount, fromDomain, toAccount, seq)` 指定且已分配给 signer 的消息，或 signer 不属于其 durable audience | `200 FORBIDDEN`                        | 视为永久业务拒绝；不得将 peer 置为 `degraded`，不改用猜测的消息坐标重试                            |
| 授权消息存在，但 digest 未绑定该消息                                                                                   | `200 NOT_FOUND`                        | 当前资源不存在；仅在消息/资源状态改变或人工重试后再请求                                            |
| `bundleId` 未绑定该 outer FORWARD message，或 digest 不在该 root closure                                               | `200 NOT_FOUND`                        | 拒绝该 asset；不得改用 child ID、inner sender 或其他 publisher 猜测下载                            |
| digest binding 存在，但 CAS 记录已删除、标记 deleted、blob 文件缺失或无法作为完整资源读取                              | `200 NOT_FOUND`                        | 保留消息/closure；把 asset 标为 unavailable/retryable-by-state-change，不得将 peer 置为 `degraded` |
| 单 Range grammar 合法，但起点超出当前长度或 `start > end`                                                              | `416 FEDERATION_RANGE_NOT_SATISFIABLE` | 验证 `Content-Range` 后停止当前 offset；不得解释为文件不存在                                       |
| publisher 暂时无法读取存储或提供服务，且不能确定资源已不存在                                                           | `503 INTERNAL`                         | 保留授权坐标和 cursor，按 errors.md 有上限退避重试并将已建立 peer 置为 degraded                    |

`NOT_FOUND` 只说明 publisher 在当前已授权坐标下不能提供该 digest，不证明该 digest 在其他消息、bundle 或
server 上不存在。publisher 不得（MUST NOT）把“请求者没有 message/audience proof”降格为 `NOT_FOUND`，
否则会把授权失败伪装成资源状态；也不得把确定的本地 blob 缺失提升为 `503` 并导致无限自动重试。

收到有效 `NOT_FOUND` 后，consumer 可以（MAY）按本地产品策略处理对应的本地消息副本（mirror message），
例如保留不可用附件占位、隐藏附件入口或标记等待人工修复；v1 不规定唯一的展示或保留策略。但该本地处理
不得（MUST NOT）被解释为 publisher 发出的消息删除或 tombstone，不得传播为远端删除，也不得绕过本节授权
坐标从其他 publisher 按 digest 猜测下载。

错误响应必须（MUST）是 `application/json`，不得（MUST NOT）夹带资源 bytes。consumer 不得根据
`NOT_FOUND` 与 `FORBIDDEN` 的 message 文本推断资源是否存在。publisher 已发送 `200/206` header 和部分
bytes 后发生磁盘读取或连接错误时，已经不能改发 JSON envelope；必须（MUST）终止 stream。consumer
必须丢弃未达到声明 `Content-Length` 或 digest 校验失败的当前 range，并从同一 offset 按本地有上限策略重试。

### 3.4 完整 Range HTTP 示例

示例完整资源是 16 bytes ASCII `hello federation`，其 SHA-256 为 path digest。请求者 `a.example` 获取
publisher `b.example` 上 `alice` 发给本方用户 `bob`、source sequence `42` 的前 5 bytes：

```http
GET /s2s/v1/media/d831d6f2797f986eb5453ea3c86e1b6ac7eac94ba35edd17730b939536059afa?fromAccount=alice&fromDomain=b.example&toAccount=bob&seq=42 HTTP/1.1
Host: b.example
Date: Tue, 14 Nov 2023 22:13:20 GMT
Content-Digest: sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:
Range: bytes=0-4
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:6YAuNShBJXwELU+pYCbi+PijcgbC+rvmdio7U6mLEKSuVs1nreRH++To7aIduclGuBCy9XJ5kRRBQULPlPNPBQ==:
```

`Range` 不在 v1 签名组件中，但仍受本文 single-range grammar 约束。成功响应的 body 是精确 5 bytes
`hello`，示例 `Content-Digest` 覆盖这 5 bytes，而 path digest 覆盖完整 16 bytes：

```http
HTTP/1.1 206 Partial Content
Content-Type: application/octet-stream
Content-Length: 5
Content-Range: bytes 0-4/16
Accept-Ranges: bytes
Content-Digest: sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:

hello
```

对同一资源请求 `Range: bytes=16-20` 的不可满足响应是：

```http
HTTP/1.1 416 Range Not Satisfiable
Content-Type: application/json
Content-Range: bytes */16

{"code":50021,"message":"requested range is not satisfiable","data":null}
```

## 4. 转发包（Forward Bundle）

### 4.1 Operation、参数与授权

```http
GET /s2s/v1/forward-bundles/:bundleId
```

| 项目           | 要求                                                               |
| -------------- | ------------------------------------------------------------------ |
| Path variable  | `bundleId`；第 4.1 节定义的 bounded opaque ID                      |
| Query          | 不允许                                                             |
| Request body   | 第 1 节定义的零长度 body                                           |
| Success        | HTTP `200` success data envelope；data 是完整 `ForwardWireClosure` |
| Business error | HTTP `200 NOT_FOUND` 或 `FEDERATION_PAYLOAD_TOO_LARGE`             |

`bundleId` 必须（MUST）是非空、26 字符以内的 opaque string；其比较区分大小写。请求不得携带 query 或
body。publisher 必须（MUST）证明该 bundle 绑定至少一条未删除的 FORWARD message，且该消息已持久分配
给签名 peer 对应的 thread audience。bundle ID 的知识、子 bundle 引用或当前 recognition 本身均不授权。
path 解码后的 `bundleId` 按 UTF-8 编码不得超过 26 bytes，且不得包含 NUL 或 `/`。

### 4.2 成功响应与 closure 不变量

成功为 HTTP `200`、`Content-Type: application/json`，`data` 是
[Message 第 11 节](./message.md#11-forward)定义的 `ForwardWireClosure` closed object。该节列出的
closure、bundle、manifest、message、sender、quote、asset 与 `accessContext` 字段、必选性和类型全部适用；
除这些字段规则外，还必须（MUST）满足：

- `rootBundleId` 必须等于 path `bundleId`，并且在 `bundles[].id` 中恰好出现一次。
- `bundles[].id` 必须唯一；每个 `manifest.bundleId` 必须等于其 enclosing bundle 的 `id`。
- `manifest.children` 中的每个 ID 必须在 `bundles` 中恰好解析一次；从 root 可达的 bundle 必须正好等于
  返回集合，不得存在缺失 child、额外 bundle、环、重复 child 引用或多 parent child。
- 每个 `manifestDigest` 必须等于对应 manifest 的 canonical JSON SHA-256；consumer 必须先验证 digest，
  再信任 messages、children 或 assets。
- `bundles` 最多 500 项；每个 manifest 最多 100 条 message；closure UTF-8 JSON body 最多 2 MiB。
  超限不得（MUST NOT）返回截断的成功 closure。
- 叶 bundle 的 `depth` 必须（MUST）为 1，parent depth 必须（MUST）为直接 children 最大 depth 加 1；
  `bundles[].depth` 与 `manifest.depth` 必须一致，root depth 不得超过 3。
- 顶层 `assets` 必须是完整 closure 中资产的去重集合；每个 bundle 的 `assets` 只列出该 bundle manifest
  引用的资产。相同 digest 的 descriptor 必须一致。
- consumer 通过 outer `ForwardCardContent` 获取 closure 时，所有 manifest 的 message 数之和必须等于
  card `messageCount`，顶层去重 asset 数必须等于 card `assetCount`；不一致时拒绝整个 closure。
- `accessContext` 若出现仅供诊断；consumer 不得（MUST NOT）用其中的本地 numeric ID 授权或定位自己的
  thread。

canonical manifest 和 `manifestDigest` 唯一按 [Message 第 11.1 节](./message.md#111-manifest-canonicalization-与-digest)
的 RFC 8785 JCS 规则及固定测试向量计算。consumer 不得（MUST NOT）直接对收到的、可能带缩进或不同
member 顺序的 response substring 计算 digest。

closure 是不可变 snapshot。对同一 publisher 与 `bundleId` 重复成功读取必须（MUST）返回语义相同、
digest 相同的 closure。二进制资产不内联，使用第 3 节媒体 operation，并携带同一 `bundleId` 及原
FORWARD message 的精确授权坐标。

### 4.3 Closure 资产获取（Closure Asset Retrieval）

`GET /s2s/v1/forward-bundles/:bundleId` 只返回 JSON closure，不内联 `ForwardAsset` 的 bytes。consumer 必须（MUST）
先完整验证并提交第 4.2 节 closure，再对实际需要且本地尚未具备的 digest 使用第 3 节 media operation。
每个 asset request 的参数必须（MUST）从承载该 closure 的 outer `FederatedMessage` 和已验证 closure 派生：

| Media 参数    | 唯一来源与要求                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `digest`      | 某个 `bundles[].assets[]` 中的 `ForwardAsset.digest`；顶层 `assets` 只是去重摘要，不能单独授权         |
| `fromAccount` | outer `FederatedMessage.author.account`                                                                |
| `fromDomain`  | outer `FederatedMessage.author.domain`                                                                 |
| `toAccount`   | P2P：outer `thread.participants` 中由 consumer signer domain 托管的账号；GROUP：outer `thread.account` |
| `seq`         | outer `FederatedMessage.originSeq`，编码为 `DecimalString`                                             |
| `bundleId`    | outer `ForwardCardContent.bundleId`，且必须等于 closure `rootBundleId`                                 |

`bundleId` 必须始终使用 remote root bundle ID；即使 asset 只由某个 child manifest 引用，也不得（MUST NOT）
改用 child `bundles[].id`。inner `ForwardManifestMessage.sender`、inner message `id`、`accessContext`、asset
`extension`、`filename` 或 `mime` 都不进入授权 query。publisher 必须（MUST）重新证明 root bundle 与 outer
FORWARD message 的绑定、outer message 对签名 peer 的 durable thread audience，以及 digest 位于该 root 的
完整 closure；其中任一条件不成立都不得返回 bytes。

同一 digest 在多个 bundle 中出现时 consumer 可以（MAY）只下载一次；多个 asset 的下载顺序无协议语义。
Range retry 必须（MUST）保持全部授权 query 不变，只改变 `Range`。asset 下载失败不使已经验证的 closure
变为合法或非法，也不得（MUST NOT）把缺失 bytes 伪装成成功本地化；consumer 可以持久保存 retry work，
但只有重组后的完整长度等于 `ForwardAsset.bytes` 且完整 digest 验证成功后才能把该 asset 标记为可用。
第 3.3 节错误映射完整适用；`NOT_FOUND` 表示当前 asset bytes 不可取得，不授权 consumer 从任意其他
publisher 按 digest 猜测下载。

例如，假设 outer FORWARD message 中与资产授权有关的字段如下；这是字段摘录，不是可独立验证的完整
`FederatedMessage`：

```json
{
  "author": { "account": "alice", "domain": "b.example" },
  "thread": {
    "type": "P2P",
    "participants": [
      { "account": "alice", "domain": "b.example" },
      { "account": "bob", "domain": "a.example" }
    ]
  },
  "originSeq": 42,
  "contentType": "FORWARD",
  "content": "{\"version\":1,\"bundleId\":\"01hzy3m8x7v6t5r4q2p1n0k9jc\",\"summaryLines\":[\"Alice: hello\"],\"messageCount\":1,\"assetCount\":1}"
}
```

且验证后的 closure 包含 digest
`d831d6f2797f986eb5453ea3c86e1b6ac7eac94ba35edd17730b939536059afa`，则 consumer `a.example` 的第一个
Range request 是：

```http
GET /s2s/v1/media/d831d6f2797f986eb5453ea3c86e1b6ac7eac94ba35edd17730b939536059afa?fromAccount=alice&fromDomain=b.example&toAccount=bob&seq=42&bundleId=01hzy3m8x7v6t5r4q2p1n0k9jc HTTP/1.1
Host: b.example
Date: Tue, 14 Nov 2023 22:13:20 GMT
Content-Digest: sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:
Range: bytes=0-8388607
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:j+HRgnN5UrLHamIKxt7FBEha9Q0Cw0RAfhTGBZXuJn5dxQPkwHOfJzdR/u9Y5qsMrCnldUBU0gtyxJVelo6xBw==:
```

上例的 8 MiB range 是合法示例，不是协议固定 chunk size；publisher 可以（MAY）把尾 range clamp 到资源
实际末尾，并按第 3.2 节返回精确 `Content-Range`。

### 4.4 错误与提交

- path parameter malformed：HTTP `400 FEDERATION_MALFORMED`。
- bundle 不存在、已不可见或没有对签名 peer 的 message/audience binding：HTTP `200 NOT_FOUND`。
- closure 超出公开上限：HTTP `200 FEDERATION_PAYLOAD_TOO_LARGE`，不得返回部分 closure。
- 公共签名、认可、identity、策略及服务故障：按 errors.md。

bundle 的有效 `NOT_FOUND` 同样允许（MAY）consumer 按本地策略处理对应的 mirror message，例如保留不可展开
的转发卡片、隐藏入口或标记修复；这不是源站消息删除信号，不得（MUST NOT）据此生成、传播或推断 message
tombstone。consumer 也不得用 card 摘要或已经保存的部分 closure 伪造完整 bundle。

consumer 必须（MUST）在一个提交边界内验证整个 closure 的 closed shape、大小、图闭合、无环、全部
manifest digest 与 descriptor 一致性；任一失败必须（MUST）拒绝整个 closure，不得保存可授权的部分图。

### 4.5 完整 HTTP 示例

以下是一个只有一条纯文本消息、没有 child 或 asset 的最小 closure。请求签名同样由公开测试 key 实际生成：

```http
GET /s2s/v1/forward-bundles/01hzy3m8x7v6t5r4q2p1n0k9jc HTTP/1.1
Host: b.example
Date: Tue, 14 Nov 2023 22:13:20 GMT
Content-Digest: sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:slzsnwcoWsHW5o63VWAaCis5u/akBYIblV5PbwKoj6I2v8wcqIZ/hHnRfOiwTWkiTwpLGB/mUSWw9QZCGhp9BQ==:
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "code": 0,
  "message": "successful",
  "data": {
    "schemaVersion": 1,
    "rootBundleId": "01hzy3m8x7v6t5r4q2p1n0k9jc",
    "bundles": [
      {
        "id": "01hzy3m8x7v6t5r4q2p1n0k9jc",
        "depth": 1,
        "manifestDigest": "c5562ebda1bd03bc489d7c5ff2c2cf02365a8a430ea1776719d5fb5d2ed3d65c",
        "manifest": {
          "schemaVersion": 1,
          "bundleId": "01hzy3m8x7v6t5r4q2p1n0k9jc",
          "depth": 1,
          "children": [],
          "messages": [
            {
              "id": 1,
              "sender": {
                "displayName": "Alice",
                "account": "alice",
                "domain": "b.example"
              },
              "contentType": "PURE_TEXT",
              "content": "{\"text\":\"hello\"}",
              "sentAt": 1700000000000
            }
          ]
        },
        "assets": []
      }
    ],
    "assets": []
  }
}
```

`manifestDigest` 是上述 `manifest` 按 Message 第 11.1 节 JCS 规则序列化后的真实 SHA-256；
HTTP 示例为了可读性使用缩进，这些响应 bytes 本身不参与 `manifestDigest`。不可见 bundle 的响应示例：

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"code":10001,"message":"forward bundle not visible to peer","data":null}
```
