# SOMS Federation Protocol v1

状态：`REVIEW`
协议标识：`1`
S2S API 前缀：`/s2s/v1`

本文是 Federation v1 的基础协议，定义版本、HTTP 接口面（HTTP surface）、传输、Federation 共享类型
（Shared Federation Types）、
请求签名、通用响应、错误分类、重试和 cursor 基础语义。各 operation 的业务 body、
授权和状态机由它引用的规范性文档定义。SOMS 的数据库字段、worker、队列、配置和
本地产品限制不构成协议要求。

规范词 `必须（MUST）`、`不得（MUST NOT）`、`应该（SHOULD）`、`不应该（SHOULD NOT）` 和 `可以（MAY）` 按 RFC 2119/RFC 8174
解释。

## 0. 规范文档与优先级（Normative Documents and Precedence）

Federation v1 的规范性要求由本文及其明确引用的 [传输与安全](./transport-security.md)、
[服务器认可](./recognition.md)、State Feed、Message Feed、通话、resource 与错误码文档共同组成。本文负责
共享协议契约（protocol contract）；operation 文档可以（MAY）在
不改变本文安全底线的前提下收紧它所属 operation 的字段、状态和授权要求。如果两份
规范性正文对同一外部可观察协议行为给出不同要求，这是规范缺陷，实现必须（MUST）以 fail-closed 方式处理，不得（MUST NOT）自行
选择较宽松的解释。

`schema/` 中的 JSON Schema、HTTP manifest 和向量在 v1 文档收敛期间是验证制品，不能覆盖
规范性正文。发布 `FINAL` 前，必须（MUST）将其与正文逐字段对齐，并由 conformance 检查
防止漂移。

## 1. 范围、角色与术语（Scope, Roles, and Terminology）

- **server**：实现 Federation v1、发送或接收 S2S 请求的协议参与者。
- **server domain**：server 的稳定 Federation identity，以 canonical `Domain` 表示。DNS、SRV 解析出的
  host、port 或 IP 只决定连接位置，不是 server domain。
- **peer**：相对于本 server，正在建立或已经建立双向认可关系（bidirectional recognition relationship）的远端 server。
- **origin**：某个群身份及其 roster 的权威 server。它是身份授权角色，不是每条消息作者或
  每次传输的 publisher 的同义词。
- **mirror**：非 origin server 保存的群副本。
- **publisher**：在某个 operation 或同步方向中提供 feed、resource 或 authoritative state 的 server。
- **consumer**：在某个 operation 或同步方向中请求、验证并提交 publisher 数据的 server。同一个
  server 在不同 operation 或相反同步方向中可以（MAY）同时承担 publisher 和 consumer。
- **durable fact**：由 server 持久保存的业务事实，例如关系方向、群 roster 快照或消息副本。它的
  正确性和生命周期由业务状态决定，不依赖 revision hint 是否送达。
- **durable change**：publisher 为特定 peer 持久分配、用于发现或同步 durable fact 的有序 feed
  记录。它拥有 source revision，并按 cursor、确认和 retention 规则提供；删除 change 不等于删除
  对应的 durable fact。
- **revision hint**：只负责唤醒 consumer 的非持久、可丢失通知。
- **cursor**：consumer 已安全提交的 source revision；不能因提示或失败响应提前推进。
- **reset**：管理员授权的 destructive identity lifecycle；普通断线或 DNS 变化不属于 reset。
- **传输格式（wire format）**：通过 HTTP 实际传输的 method、path、query、header 和 body bytes 的表示形式；不包括
  数据库结构、内部 object 或本地执行方式。

## 2. 版本与兼容性（Versioning and Compatibility）

Federation v1 的所有 S2S 数据面端点都位于 `/s2s/v1/*`。公开发现端点固定为
`/.well-known/soms`，因为调用方在读取发现文档前不能依赖 API 前缀。

`/.well-known/soms` 是跨版本发现文档（cross-version discovery document），不是某个 Federation 主版本
（Federation major version）独占的
响应。`protocolVersions` 是 Federation 永久的跨版本引导字段（cross-version bootstrap field）：任何
现在或未来的主版本只要使用 `/.well-known/soms`，都必须（MUST）支持并返回该字段，且不得（MUST NOT）
删除、重命名、改变类型或改变选择语义。它必须（MUST）是非空 JSON number array，元素是严格递增、
无重复的正安全整数，并且必须（MUST）完整列出节点当前启用且完整实现的所有 Federation 主版本。节点
不得（MUST NOT）发布只实现了部分必选行为的主版本。

调用方必须（MUST）先读取 `protocolVersions`，取双方版本数组交集的最高值 `V`，再按 `V` 的规范验证
well-known 的共享字段和版本附加字段。交集为空则不建立联邦。选定版本由 `/s2s/v<V>` 路径明确表达，
实现不得（MUST NOT）在各个 state、message 或 command body 中重复版本字段。选定版本由 S2S path 中的
`/s2s/v<major>` 表达；Recognize body 不重复协议版本。

除永久必选的 `protocolVersions` 外，后续主版本应该（SHOULD）保留语义兼容的共享字段，并可以（MAY）
在同一 well-known object 中增加字段。同名字段在 `protocolVersions` 声明的所有主版本中必须（MUST）
保持相同类型和语义；若含义改变，新的主版本必须（MUST）使用新字段名。某个主版本新增的字段只由
选择该主版本的握手解释；选择 v1 的实现必须（MUST）忽略 v1 未定义的字段，且不得（MUST NOT）让它们
改变 v1 的身份、授权、endpoint 或安全行为。

可选的 `software` 只用于运维诊断。consumer 不得（MUST NOT）根据产品名、软件版本或构建号启用、禁用或
改变 v1 protocol behavior。实现只有在完整支持本规范的全部必选行为时，才可以（MAY）在
`protocolVersions` 中发布 `1`。

每个 `/s2s/v<major>` handler 必须（MUST）只接受本节点当前发布的主版本，不得（MUST NOT）把不支持的版本透明降级到
另一版本。节点从一次成功的 well-known refresh 得知某个已知 peer 与本节点不再存在共同版本后，
必须（MUST）停止向该 peer 发送并拒绝该 peer 的普通数据面请求；实现可以（MAY）重新协商其他共同版本或主动断开
连接，但不得（MUST NOT）因此删除 identity pin、cursor、mirror 或 authorization。节点不需要在每个请求前刷新
well-known；刷新频率和连接生命周期由实现决定，并且必须（MUST）有缓存、退避和限速以避免放大流量。

请求到达语法可识别但本节点未启用的 `/s2s/v<major>` 时，节点必须（MUST）拒绝，并应该（SHOULD）返回
HTTP `400` 和 `FEDERATION_PROTOCOL_VERSION_UNSUPPORTED`；不得（MUST NOT）把它路由到其他主版本的 handler。

v1 不使用 capability negotiation，也没有可选 endpoint 分支。增加可选响应字段必须（MUST）先满足对应
object 的兼容规则；删除或重命名字段、改变字段含义、改变 endpoint、鉴权、状态码、幂等或 cursor
语义均属于不兼容变化，必须（MUST）使用新的 `/s2s/v2` 主版本。错误修订、非规范性说明和不改变
外部可观察协议行为的实现优化 可以（MAY）在 v1 内发布。

## 3. Federation v1 HTTP 接口面（HTTP Surface）

下表是完整 v1 surface；同步面严格只有两个 GET feed 和一个 POST revision hint。
`鉴权上下文` 决定签名验证时如何获取 key 以及哪些 peer 状态可以（MAY）调用 operation；它不改变
第 6 节的签名 wire format。

| Method | Absolute path                       | 鉴权上下文         | Request                   | Success     | Response               |
| ------ | ----------------------------------- | ------------------ | ------------------------- | ----------- | ---------------------- |
| `GET`  | `/.well-known/soms`                 | 公开 TLS           | 无 query、无 body         | `200`       | 裸 discovery object    |
| `POST` | `/s2s/v1/recognize`                 | bootstrap signed   | JSON signer domain        | `200`       | 裸 recognize OK        |
| `POST` | `/s2s/v1/healthy`                   | status signed      | JSON signer domain        | `200`       | 裸 privacy-safe status |
| `POST` | `/s2s/v1/feed-revisions`            | lightweight signed | JSON revision hint        | `202`       | success ack envelope   |
| `GET`  | `/s2s/v1/state-feed`                | recognized signed  | feed query                | `200`       | success data envelope  |
| `GET`  | `/s2s/v1/message-feed`              | recognized signed  | feed query                | `200`       | success data envelope  |
| `POST` | `/s2s/v1/call`                      | recognized signed  | JSON call frame           | `200`       | success data envelope  |
| `GET`  | `/s2s/v1/users/:account`            | recognized signed  | path account              | `200`       | success data envelope  |
| `GET`  | `/s2s/v1/media/:digest`             | recognized signed  | path/query/optional Range | `200`/`206` | raw bytes              |
| `GET`  | `/s2s/v1/forward-bundles/:bundleId` | recognized signed  | path bundle ID            | `200`       | success data envelope  |

四种 signed 上下文使用同一 HTTP Message Signature profile，但验证权限不同：

- **bootstrap signed**：只用于 `recognize`。接收方从 signer domain 当前的 well-known 取得 root key 和
  有效 signing key certificate，验证 HTTP signature 和 domain binding 后，才能在一个事务中提交该方向的
  认可事实。一次请求不得（MUST NOT）被解释成双向认可。
- **status signed**：只用于 `healthy`。接收方只使用已有的 pinned/recognition identity 尝试验签；已认可但
  尚未收敛的 peer 可以（MAY）得到 `degraded`，未知、未被本方认可或无权请求者统一得到 privacy-safe
  `unavailable`，不得（MUST NOT）借查询触发首次认可。
- **lightweight signed**：只用于 `feed-revisions`。接收方在返回该 signer 的 Recognize `OK` 前必须（MUST）
  原子开放该方向门禁；signer 只有收到 `OK` 后才可以（MAY）发送。它不要求完整 healthy，但不能授权其他数据面。
- **recognized signed**：signer 必须（MUST）已有 pinned root、完整双向认可事实和当前有效的 signing key
  certificate，并通过 operation 自身的业务授权。接收方不得（MUST NOT）仅因本地缓存的可用性视图为
  `degraded` 而拒绝请求；成功验证并处理的请求/响应往返可以（MAY）按 recognition.md 清除纯传输降级。
  `blocked`、`identity_lost` 和 `incompatible` 仍是协议或策略硬门禁。Call 对已有活动
  binding 的安全终止规则由 calls.md 进一步定义。

上述硬门禁必须（MUST）保留各自的 wire 结果，不得（MUST NOT）合并成通用“未信任”错误：`blocked` 使用
`FEDERATION_PEER_BLOCKED`，`identity_lost` 使用 identity 错误，`incompatible` 使用
`FEDERATION_PROTOCOL_VERSION_UNSUPPORTED`。三者的 retry、管理员动作和 identity 安全含义不同。


`media/:digest` 的 digest 是资源 path parameter；消息 author/thread/source-seq 和可选 bundle
binding 是严格 query contract。请求者 domain 只从验证后的 HTTP Message Signature 得出，不接受
调用方重复声明。服务端必须（MUST）证明该精确消息已经通过 durable discovery allocation 交付给签名 peer，
且 digest 属于该消息或它绑定的 forward closure。

未列入本节完整 surface 的路径不属于 Federation v1。
`recognize`、`healthy` 的字段、双向状态、pin、重试、隐私与完整 HTTP 示例由
[Federation v1 服务器认可](./recognition.md) 定义。

内部 peer lifecycle 是 `unrecognized`、`degraded`、`healthy`、`blocked`、`identity_lost` 或
`incompatible`。它与 Healthy 返回的隐私投影视图不是同一个枚举：

- `unrecognized` 表示尚无可用的 pinned/recognition identity。
- `degraded` 是身份已认可但双向确认/服务可用性尚未收敛，或发生临时传输故障的可恢复状态；主动发起方
  必须（MUST）在发送第一个 Recognize HTTP request 前进入该状态。
- `healthy` 是双向认可和双方服务准备均确认的完整可用状态。
- `blocked` 是管理员策略明确阻止；`identity_lost` 是 pinned root identity 冲突；两者都不是网络降级。
- `incompatible` 表示当前没有共同协议版本；版本重新出现时可以（MAY）在保留身份和认可事实的前提下恢复。


`healthy`/`degraded` 是本地可用性与调度信息，不单独构成普通 operation 的授权条件。operation gate 必须
（MUST）由 pinned identity、方向确认事实、版本、策略和业务授权共同计算；完整状态和转换以
recognition.md 为准。

Recognize 接收方必须（MUST）在返回 `OK` 前原子开放该方向的 `feed-revisions` 接收门禁。发送反向
Recognize 的 server 必须（MUST）在发出 HTTP request 前完成本地服务准备，使对方随后发起的 Healthy
查询至少返回 `degraded`，而不是 `unavailable`。具体提交边界和竞态时序以 recognition.md 为准。

## 4. Well-Known 与密钥（Well-Known and Keys)

发现文档、root identity、signing key certificate 与轮换的规范性定义见
[传输与安全](./transport-security.md)第 1 节。

## 5. 网络、TLS 与 Authority（Network, TLS, and Authority)

SRV、连接目标、TLS hostname、logical authority、redirect 和身份恢复的规范性定义见
[传输与安全](./transport-security.md)第 2 节。
## 6. 通用协议规则（Common Protocol Rules）

### 6.1 JSON 编码与对象规则（JSON Encoding and Object Rules）

JSON body 必须（MUST）是不带 BOM 的 UTF-8，并发送 `Content-Type: application/json`。v1 不对 JSON request
使用 `Content-Encoding`；发送方不得（MUST NOT）压缩 JSON request，接收方必须（MUST）拒绝除 HTTP
`identity`（未编码）以外的 content coding。同一 JSON object 中重复的 member name 必须（MUST）被拒绝，不得（MUST NOT）使用“第一个值”或
“最后一个值”规则继续处理。

operation body 的顶层类型、必选字段、`null` 语义和未知字段策略由对应 operation 规范定义。
字段缺失、JSON `null`、空字符串和数值零是四种不同的 JSON representation，不得（MUST NOT）相互代替。除非
operation 明确允许，非有限 number、非安全整数和未知字段必须（MUST）作为 malformed 拒绝。
普通 JSON object 的 member 顺序没有业务语义；只有明确要求 canonical JSON 或固定字段顺序签名的
operation 可以（MAY）将序列化顺序纳入 digest 或 detached signature。

### 6.2 Federation 共享类型（Shared Federation Types）

operation 引用下表类型时，必须（MUST）遵守其格式、范围和规范化要求，不得（MUST NOT）重新定义或放宽。

| 名称                     | v1 传输 grammar 与语义                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Domain`                 | ASCII 小写 DNS name，总长 1–253，label 长 1–63，只允许 `a-z`、`0-9`、`-`，label 首尾不得（MUST NOT）为 `-`，on the wire 不带末尾根点 |
| `UserAccount`            | 规范化的小写 ASCII 用户账号；匹配 `^[a-z0-9][a-z0-9._-]{1,29}$`，总长 2–30 characters                                                |
| `GroupAccount`           | `!` 加规范化的小写 ASCII 群组账号；匹配 `^![a-z0-9]{2,30}$`，总长 3–31 characters                                                    |
| `Account`                | `UserAccount` 或 `GroupAccount`；大小写敏感且只接受上述小写形式；operation 必须（MUST）拒绝不符合其资源类型的 account                |
| `Address`                | closed JSON object `{ "account": Account, "domain": Domain }`                                                                        |
| `DecimalString`          | 字面值 `"0"` 或不以 `0` 开头的非空 ASCII 十进制 digit string；不得（MUST NOT）改用 JSON number                                       |
| `PositiveDecimalString`  | 首字符为 `1..9`、后续字符为 `0..9` 的非空 string                                                                                     |
| `SafeInteger`            | JSON integer，范围 `0..9007199254740991`                                                                                             |
| `EpochMilliseconds`      | Unix epoch milliseconds，编码为 `SafeInteger`                                                                                        |
| `Sha256Hex`              | `^[a-f0-9]{64}$`                                                                                                                     |
| `Base64Ed25519Key`       | RFC 4648 padded base64，解码后恰好 32 bytes                                                                                          |
| `Base64Ed25519Signature` | RFC 4648 padded base64，解码后恰好 64 bytes                                                                                          |
| `KeyId`                  | `Domain "/" KeyName`，`KeyName` 匹配 `^[A-Za-z0-9._-]{1,64}$`；第一个 `/` 前的完整字符串是 signer domain                             |
| `CanonicalUuid`          | 小写 RFC 4122 文本形式，版本 nibble 为 `1..8`，variant nibble 为 `8`、`9`、`a` 或 `b`                                                |

v1 on the wire 只接受上表的规范化 `Domain` 和 `Account`。发送方必须（MUST）以小写 ASCII 发送两者；
`Account` 必须（MUST）来自已经规范化的 Federation account ID，不得（MUST NOT）把 display name 或未经
身份映射的原始用户输入直接写入 S2S 请求。用户输入中的大小写、空白、Unicode domain 或末尾根点必须（MUST）
在进入 S2S 边界前由发送方完成确定性规范化或拒绝。接收方必须（MUST）拒绝含大写字母、空白、Unicode
或其他非规范形式的 transmitted `Domain`/`Account`，不得（MUST NOT）在接收后小写化、修剪或通过宽松
规范化把两个不同 transmitted value 当作同一身份。数据库 ID 不得（MUST NOT）作为 server 间身份坐标。

### 6.3 请求构造总览（Request Construction Overview)

请求构造的规范性定义见 [传输与安全](./transport-security.md)第 3 节。

### 6.4 请求目标构造（Request Target Construction)

规范性定义见 [传输与安全](./transport-security.md)第 3.1 节。

### 6.5 请求体与内容摘要（Request Body and Content Digest)

规范性定义见 [传输与安全](./transport-security.md)第 3.2 节。

### 6.6 已签名请求头（Signed Request Headers)

规范性定义见 [传输与安全](./transport-security.md)第 3.3 节。

### 6.7 HTTP 消息签名构造（HTTP Message Signature Construction)

规范性定义见 [传输与安全](./transport-security.md)第 3.4 节。

### 6.8 验证顺序与失败边界（Verification Order and Failure Boundaries)

规范性定义见 [传输与安全](./transport-security.md)第 3.5 节。

### 6.9 完整已签名请求示例（Complete Signed Request Example)

固定示例见 [传输与安全](./transport-security.md)第 3.6 节。
## 7. 响应、错误与调用方动作（Responses, Errors, and Caller Actions）

### 7.1 媒体类型与响应种类（Media Types and Response Kinds）

`well-known`、`recognize` 和 `healthy` 的成功响应是它们各自 operation 规范定义的裸 JSON object。
其余 JSON operation 的成功响应使用本节 envelope。JSON response 必须（MUST）使用
`Content-Type: application/json`；不得（MUST NOT）使用 HTTP `204`。

`media/:digest` 是唯一的 raw binary response：完整响应为 `200`，满足的单 Range 为 `206`，
不可满足 Range 为 `416`。在任何 bytes 发出前发生的错误使用 JSON error envelope 并保留
错误 HTTP status；一旦已发出成功 header 或 body bytes，中途读取失败 必须（MUST）中断连接，不得（MUST NOT）在
binary body 后追加 JSON。

### 7.2 成功响应封装（Success Envelope）

携带业务结果的成功响应必须（MUST）为：

```json
{
  "code": 0,
  "message": "successful",
  "data": {}
}
```

`code` 必须（MUST）是 JSON integer `0`。`message` 必须（MUST）是 string，仅供人类诊断；consumer 不得（MUST NOT）按其文本
分支。`data` 必须（MUST）存在，其 shape 由 operation 定义。consumer 必须（MUST）忽略未知的顶层诊断字段，
但不得（MUST NOT）用它们改变成功、授权、幂等或 cursor 语义。

只表示已接受、不携带业务结果的 ack operation 使用：

```json
{
  "code": 0,
  "message": "successful"
}
```

v1 中 `feed-revisions` 是 ack operation。其他 operation 不得（MUST NOT）自行省略 `data`；如果其语义上没有结果，
operation 规范 必须（MUST）明确定义 `data: null`。

### 7.3 错误响应封装（Error Envelope）

所有 JSON error response 必须（MUST）符合
[Federation v1 错误码注册表](./errors.md)定义的 `FederationError` envelope。稳定 code、精确 HTTP status、
结构化 `data`、未知字段/code、status/code 冲突和 caller action 均以该注册表为唯一权威来源，operation
文档不得（MUST NOT）重新定义通用 envelope。

`healthy` 的固定 `unavailable` 是成功解析后的状态结果，不是 error envelope；raw media response 的成功与
中途失败边界仍按第 7.1 节处理。

### 7.4 重试与提交边界（Retry and Commit Boundaries）

`feed-revisions` 成功返回 202；这表示 revision hint 已被接受，不表示对端 durable feed 已完全排空。
`call` 在 frame 已完成同步验证和临时状态处理后返回 200；它不表示 endpoint 已收到事件或媒体已连通。
网络错误、无法解析的 proxy response 和允许重试的 `5xx` 可以（MAY）使用完全相同的业务请求重试，
但必须（MUST）重新生成 `Date`、`created`、`expires` 和 HTTP signature。malformed、binding、authorization 和
identity conflict 不得（MUST NOT）原样无限重试。`Retry-After` 出现时必须（MUST）是非负十进制 delta-seconds；
consumer 应该（SHOULD）遵守它，并在缺失时使用有上限、带 jitter 的指数退避。

cursor 只能在 response 完整验证且本地副作用与 cursor 同事务提交后推进。HTTP 超时、连接中断、
非零 code、malformed success body 或未知 code 均不得（MUST NOT）推进 cursor。operation 文档必须（MUST）定义其重复请求的
幂等 key 和可观察结果；不得（MUST NOT）仅因 HTTP request 换了新签名就将同一业务命令当作新命令。

## 8. 持久状态与生命周期（Durable State and Lifecycle）

`state-feed` 承载 `PROFILE`、`P2P_META`、`GROUP_INVITE_INTENT`、`GROUP_JOIN_INTENT` 和
origin-authoritative `GROUP_META`。方向事实按 stable key 与 business revision 合并；相同或更旧
revision 是完整 no-op。P2P 只有双方方向均为 `FRIEND` 才成立；群 roster 最终以 origin 的
`GROUP_META` 为准。

`state-feed` 的完整 page、五种 event body、字段约束与合并语义由
[Federation v1 State Feed](./state-feed.md) 定义；`message-feed` 的完整 page、10 种 content type、
媒体与转发由 [Federation v1 Message Feed](./message-feed.md) 定义。二者与本文
共同构成 v1 规范性正文，概要不能覆盖其字段级要求。

一对一实时通话采用 WebRTC media/JSEP，并以签名 `/s2s/v1/call` frame 承载 SOMS 联邦信令。完整 HTTP
operation、frame、生命周期、失败语义以及同一连接上的 AUDIO→VIDEO 单向升级由
[Federation v1 语音与视频通话](./calls.md) 定义。实时 frame 不进入 feed；终态历史是普通 `CALL`
message。

关系撤销、退群、踢出、解散和 profile/roster 更新必须（MUST）通过 durable state 收敛，不能依赖 revision
hint 或普通消息 payload。

权限撤销停止未来 allocation，但不删除已经分配给 peer 的历史 proof。历史读取和 media 授权按
各自的 thread audience 验证；message-feed allocation 不能替代媒体或 forward bundle 的资源授权。
服务器本地的群容量、quota 和保留策略不是 protocol constant。

## 9. Feed、投递、Cursor 与媒体恢复（Feeds, Delivery, Cursors, and Media Recovery）

以下发布、恢复与防回环规则是 v1 contract：

- feed 由按目标 peer 分配的 durable change 构成；change 引用或承载其可见的 durable fact，
  不是“排除请求方本人内容”的作者过滤视图。
- `state-feed` 可以（MAY）返回由请求方最初提出、随后被发布方持久化并确认、否定或升版的方向事实。
  consumer 必须（MUST）按 compacted key 和 business revision 幂等合并，不得（MUST NOT）把“作者是自己”当作丢弃条件。
- message item 的 `originSeq` 必须（MUST）是作者服务器分配的稳定源序列；publisher 的本地排序序列不得（MUST NOT）
  改写它。item 的 `createdAt` 必须（MUST）表示 publisher 将该副本持久化的时间。
- publisher 从 peer X 拉取并提交一条由 X authored 的消息后，必须（MUST）把该消息分配回 X 的
  `message-feed`。该 self-authored item 是 durable delivery acknowledgement：`originSeq` 指明
  X 的哪条发布已被接收，`createdAt` 给出 publisher 的持久化时间。
- consumer 收到 self-authored item 时 必须（MUST）用稳定 `(thread, author, originSeq)` 坐标关联原发布，
  不得（MUST NOT）创建重复消息。consumer 如何保存或展示回执属于本地实现，不属于 protocol contract。
- publisher 从 peer X 拉取由其他 domain authored 的 relay 消息时，不得（MUST NOT）把同一 change 直接
  反射回 X；这不阻止它向作者服务器或其他已授权 audience 分配该消息。

`state-feed` 与 `message-feed` query 均包含必选 `after` 和可选 `take`。page 返回 source HWM、
`scannedThrough` 和 `hasMore`；consumer 从已提交 cursor 开始，先完整排空 state，再拉 message。
page 与 cursor 必须（MUST）在一个事务中提交。重复 page 必须（MUST）幂等；空 page 也可确认并推进到 source HWM。
同一 `after` 可以（MAY）用于重试；低于 source 已确认 cursor 或 retained floor 的回溯必须（MUST）被拒绝。高于已
确认 cursor 且不超过 `allocatedThrough` 的请求表示 caller 主动确认跳过该区间。change ID 只要求
严格递增，不要求连续；`scannedThrough` 和下一条 item ID 都可以（MAY）跨越任意大的已删除或未分配空洞。

publisher 可以（MAY）物理删除已确认 cursor 之前的 message-feed change。若 peer 长期不消费，publisher
也 可以（MAY）按本地保留策略丢弃仍未确认的旧 allocation；这不删除 publisher 的 Message 正文。强制截断
必须（MUST）原子抬高 retained floor、acknowledged cursor 和 served cursor。旧 `after` 必须（MUST）返回
`FEDERATION_MISSED_CURSOR_INVALID`，其 `data.startChangeId` 与 `data.availableCursor` 指向新的
可用起点。consumer 验证新 floor 单调前进且不超过 `allocatedThrough` 后，必须（MUST）原子更新本地 cursor
并从 `availableCursor` 继续；不得（MUST NOT）要求 source 恢复已被策略删除的 change。

`feed-revisions` 只携带 `origin`、`stateFeedRev` 和 `messageFeedRev`。提示可以（MAY）丢失、重复、乱序；
consumer 对 revision 取 max，并通过启动和周期 reconciliation 主动拉取两个 feed。进程恢复时先确认
已缓存 peer 的 root identity 和可用 signing certificate，再依次排空 `state-feed` 与
`message-feed`。

媒体消息可先作为 durable pending work 提交，再通过 `media/:digest` Range 下载。下载授权 必须（MUST）
实时 join signer 对应的 thread audience，并验证 digest 与精确 Message 或其 forward closure 的绑定；
不得（MUST NOT）依赖可能已被 GC 的 message-feed change。下载失败或 quota pause 不得（MUST NOT）回滚已经提交的 feed
cursor；任务必须（MUST）可由持久状态恢复。forward bundle 是有界、不可变、按 digest 验证的 closure。

## 10. 身份连续性与重置要求（Identity Continuity and Reset Requirements）

本节定义 Recognize 和后续身份连续性不得（MUST NOT）突破的安全底线。`recognize` 的 domain body、
双向确认、失败重试、Healthy 隐私状态和原子转换由
[Federation v1 服务器认可](./recognition.md) 定义。

首次双向 Recognize 分别确认“A 认可 B”和“B 认可 A”，并固定双方 root public key；它不交换 cursor，
也不初始化业务 mirror。root identity 是后续连续性的长期锚；signing key 只是由 root 授权、可按第 4 节
在线轮换的请求签名 key。普通传输降级（transport degradation）必须（MUST）保留 identity pin、双向确认事实和同步状态，
不得（MUST NOT）自动重新 Recognize 或改写首次确认时间。

任何 pinned root identity contradiction 必须（MUST）原子进入 fail-closed `identity_lost` 状态。不允许当前
域名控制者、未经 pinned root 授权的 signing key、裸删 peer row 或普通重新发现继承旧授权。

若 DNS 或证书配置修复后再次发现原 pinned root，管理员可按第 5 节通过 HTTPS well-known 执行
非破坏性恢复。该操作不得（MUST NOT）更换 root identity 或既有双向认可事实，但允许 signing certificate 集合
已经发生正常轮换。只有管理员 destructive reset 可以（MAY）冻结并删除该 peer 的 cursor、mirror、
authorization 和关联状态，并授予一次 fresh bidirectional Recognize。reset 必须（MUST）可在崩溃后继续；一次性 re-init
权限消费后不能复用。

## 11. 合规性与发布（Conformance and Publication）

第 0 节的规范性文档集合定义 v1 合规性；JSON Schema、HTTP manifest、正反向量和离线
conformance CLI 与正文一同发布，作为非规范性验证资源。工具与正文冲突时以正文为准并修复工具。

Conformance 不是 v1 endpoint、协商能力或节点运行时前提，协议也不规定实现者必须（MUST）使用哪种测试
设施。随附 CLI 可检查 JSON shape、固定签名向量和 HTTP surface；事务、身份连续性与状态收敛仍需
实现者自行验证。SOMS 另外使用 unit、数据库和项目内双节点 E2E 检查自身实现，这些测试不是其他
实现必须（MUST）复制的协议组成部分。
