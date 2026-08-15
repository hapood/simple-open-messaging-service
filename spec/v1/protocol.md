# Simple Open Chat Federation Protocol v1

- 状态：`RELEASE CANDIDATE`（`v1.0.0-rc.0`）
- 协议标识：`1`
- S2S API 前缀：`/s2s/v1`
- 跨版本发现路径：`/.well-known/socfp`
- DNS SRV 服务名：`_socfp._tcp`

本文是 Federation v1 的基础协议，定义版本、HTTP 接口面（HTTP surface）、传输、Federation 共享类型
（Shared Federation Types）、
请求签名、通用响应、错误分类、重试和 cursor 基础语义。各 operation 的业务 body、
授权和状态机由它引用的规范性文档定义。任何实现的数据库字段、worker、队列、配置和
本地产品限制不构成协议要求。

规范词 `必须（MUST）`、`不得（MUST NOT）`、`应该（SHOULD）`、`不应该（SHOULD NOT）` 和 `可以（MAY）` 按 RFC 2119/RFC 8174
解释。

## 0. 规范文档与优先级（Normative Documents and Precedence）

Federation v1 的规范性要求由本文及其明确引用的 [传输与安全](./transport-security.md)、
[服务器认可](./recognition.md)、[State Feed](./state-feed.md)、[Message Feed](./message-feed.md)、
[Message Tombstone Feed](./message-tombstone-feed.md)、
[资源接口](./resources.md)、[通话](./calls.md)与[错误码](./errors.md)文档共同组成。本文负责
共享协议契约（protocol contract）；operation 文档可以（MAY）在
不改变本文安全底线的前提下收紧它所属 operation 的字段、状态和授权要求。如果两份
规范性正文对同一外部可观察协议行为给出不同要求，这是规范缺陷，实现必须（MUST）以 fail-closed 方式处理，不得（MUST NOT）自行
选择较宽松的解释。

`schema/` 中的 JSON Schema、HTTP manifest 和向量在 v1 文档收敛期间是验证制品，不能覆盖
规范性正文。发布后续公开 release candidate 前，必须（MUST）将其与正文逐字段对齐，并由 conformance 检查
防止漂移。

## 1. 范围、角色与术语（Scope, Roles, and Terminology）

- **服务器（server）**：实现 Federation v1、发送或接收 S2S 请求的协议参与者。
- **服务器域名（server domain）**：服务器的稳定联邦身份，以规范化 `Domain` 表示。DNS、SRV 解析出的
  主机、端口或 IP 只决定连接位置，不是服务器域名。
- **对等节点（peer）**：相对于本服务器，正在建立或已经建立双向认可关系的远端服务器。
- **源站（origin）**：某个群身份、成员名册以及该群已接受 timeline（包括删除终态）的唯一权威服务器。
  第三方域成员仍是消息作者，但其 home server 只能向 origin 提交；只有 origin 能向群 mirror 发布已接受事实。
- **镜像（mirror）**：非源站服务器保存的群副本。mirror 只从 origin 消费该群的权威状态、消息和删除，
  不得把收到的群事实继续发布给第三个 peer。
- **提交（submission）**：成员 home server 向群 origin 发送本域成员的消息或撤回请求。提交不是面向群
  mirror 的权威事实；origin 必须先验证并持久接受，才可进入权威分发。
- **权威分发（authoritative distribution）**：群 origin 把已接受的群事实直接发布给持有该群 mirror 的
  peer。它不是任意 peer 间的 relay，也不存在 mirror-to-mirror 的下一跳。
- **发布方（publisher）**：在某个操作或同步方向中提供源（feed）、资源或权威状态的服务器。
- **源节点（source）**：在 feed 或 query 语境下承担发布方角色的服务器。`source` 不是另一种身份或
  信任角色；离开 feed/query 语境时使用 `publisher`。
- **消费方（consumer）**：在某个操作或同步方向中请求、验证并提交发布方数据的服务器。同一服务器在
  不同操作或相反同步方向中可以（MAY）同时承担发布方和消费方。

Federation v1 的数据平面采用固定权威拓扑：P2P authored message/withdraw 由作者 home server 直接发布给
对端；群数据只有“成员 home → origin”的提交腿和“origin → mirrors”的权威分发腿。识别关系形成 mesh
连接能力，不表示任意已识别 peer 可以转发另一个 authority 的事实。

- **持久事实（durable fact）**：由服务器持久保存的业务事实，例如关系方向、群成员名册快照或消息副本。
  它的正确性和生命周期由业务状态决定，不依赖修订提示是否送达。
- **持久变更（durable change）**：发布方为特定对等节点持久分配、用于发现或同步持久事实的有序源记录。
  它拥有源修订号（source revision），并按 cursor 和压缩投影规则提供。读取不是确认（ACK）；删除源记录
  也不等于删除对应的持久事实。
- **Feed-head 提示（feed-head hint）**：携带一致的 feed inclusive 终点，只负责唤醒消费方，可丢失。
- **游标（cursor）**：消费方已安全提交的源修订号；不能因提示或失败响应提前推进。
- **重置（reset）**：管理员授权的破坏性身份生命周期；普通断线或 DNS 变化不属于重置。
- **传输格式（wire format）**：通过 HTTP 实际传输的 method、path、query、header 和 body bytes 的表示形式；不包括
  数据库结构、内部 object 或本地执行方式。

## 2. 版本与兼容性（Versioning and Compatibility）

SOCFP 区分 wire protocol major 与规范发布包版本。wire 只协商正整数 major，例如 `1`；URL 使用
`/s2s/v1`，发现文档使用 `protocolVersions: [1]`。规范文本、Schema、向量和 conformance 工具组成的
发布包使用 Semantic Versioning，例如 `1.0.0-rc.0` 或 `1.0.0`；该版本不得出现在 S2S body、URL 或
版本选择算法中，也不得作为 capability negotiation。v1 的 patch release 只能包含不改变对端可观察
wire 行为的勘误和制品修正；任何 wire 行为变化都必须进入新的整数 major。

Federation v1 的所有 S2S 数据面端点都位于 `/s2s/v1/*`。公开发现端点固定为
`/.well-known/socfp`，因为调用方在读取发现文档前不能依赖 API 前缀。

`/.well-known/socfp` 是跨版本发现文档（cross-version discovery document），不是某个 Federation 主版本
（Federation major version）独占的
响应。`protocolVersions` 是 Federation 永久的跨版本引导字段（cross-version bootstrap field）：任何
现在或未来的主版本只要使用 `/.well-known/socfp`，都必须（MUST）支持并返回该字段，且不得（MUST NOT）
删除、重命名、改变类型或改变选择语义。它必须（MUST）是非空 JSON number array，元素是严格递增、
无重复的正安全整数，并且必须（MUST）完整列出节点当前启用且完整实现的所有 Federation 主版本。节点
不得（MUST NOT）发布只实现了部分必选行为的主版本。

调用方必须（MUST）先读取 `protocolVersions`，取双方版本数组交集的最高值 `V`，再按 `V` 的规范验证
well-known 的共享字段和版本附加字段。交集为空则不建立联邦。选定版本由 `/s2s/v<V>` 路径明确表达；
各 state、message 或 command body 不得（MUST NOT）重复版本字段，Recognize body 也不重复协议版本。

除永久必选的 `protocolVersions` 外，后续主版本应该（SHOULD）保留语义兼容的共享字段，并可以（MAY）
在同一 well-known object 中增加字段。同名字段在 `protocolVersions` 声明的所有主版本中必须（MUST）
保持相同类型和语义；若含义改变，新的主版本必须（MUST）使用新字段名。某个主版本新增的字段只由
选择该主版本的握手解释；选择 v1 的实现必须（MUST）忽略 v1 未定义的字段，且不得（MUST NOT）让它们
改变 v1 的身份、授权、接口或安全行为。

可选的 `software` 只用于运维诊断。consumer 不得（MUST NOT）根据产品名、软件版本或构建号启用、禁用或
改变 v1 protocol behavior。实现只有在完整支持本规范的全部必选行为时，才可以（MAY）在
`protocolVersions` 中发布 `1`。

每个 `/s2s/v<major>` handler 必须（MUST）只接受本节点当前发布的主版本，不得（MUST NOT）把不支持的版本透明降级到
另一版本。节点从一次成功的 well-known refresh 得知某个已知 peer 与本节点不再存在共同版本后，
必须（MUST）记录版本原因、进入 `halted`、停止自动通信并拒绝该 peer 的普通数据面，但不得（MUST NOT）因此删除
identity pin、cursor、mirror 或 authorization。如何恢复属于本地管理行为。节点不需要在每个请求前刷新
well-known；刷新频率和连接生命周期由实现决定，但请求行为不得（MUST NOT）形成紧密轮询或流量放大。

请求到达语法可识别但本节点未启用的 `/s2s/v<major>` 时，节点必须（MUST）拒绝，并应该（SHOULD）返回
HTTP `409` 和 `FEDERATION_PROTOCOL_VERSION_UNSUPPORTED`；不得（MUST NOT）把它路由到其他主版本的 handler。

v1 核心接口没有可选 endpoint 分支；第 2.1 节的 extension capability 只协商非核心扩展。增加核心响应
字段必须（MUST）先满足对应 object 的兼容规则；删除或重命名字段、改变字段含义、改变接口、鉴权、状态码、幂等或 cursor
语义均属于不兼容变化，必须（MUST）使用新的 `/s2s/v2` 主版本。错误修订、非规范性说明和不改变
外部可观察协议行为的实现优化可以（MAY）在 v1 内发布。

### 2.1 Extension capability

`POST /s2s/v1/discover` 返回本服务器当前能够接收的 v1 `extensions` 数组和可选诊断 `software`。该接口
由路径绑定 v1，不重复返回 `protocolVersions`、root identity 或 signing keys；这些跨版本 bootstrap 信息
仍只属于 `/.well-known/socfp`。每个 extension 值是一个完整、不可变的 capability ID；
`socfp.*` 保留给本协议维护者，第三方 ID 使用其控制域名的反向域名前缀。ID 必须是小写 ASCII、最长
128 bytes，并以正整数 `.vN` 结尾；数组最多 64 项、不得重复，并按 ASCII lexicographic 顺序发送。
不兼容的 extension 变更必须使用新的 ID，不得改变已发布 ID 的含义。

capability 是单向接收声明。节点 B 在有效 v1 discover response 中声明 extension `E`，只表示 B 能接收并处理
发给 B 的 `E`；不表示 B 已经为 A 启用该能力，也不表示 B 会发送 `E`。A 只有在最近一次成功验证的 B v1
discover response 与最近有效 Health 的 `acceptedExtensions` 中都存在 `E` 时，才可以（MAY）在发给 B 的
message、state/profile 或 feed-head hint 中发送 `E` 定义的数据。B 是否可以向 A 反向发送 `E`，只由 A
对 B 返回的 discover response 与 Health 决定。发送方不得（MUST NOT）根据自身 capability、对端软件名、
旧缓存以外的猜测或另一方向的流量推断接收支持。

payload extension 使用可选 closed `extensions` 容器；容器的 key 是 capability ID，value 是 JSON object。
每个容器最多 64 项。发送方不得（MUST NOT）放入接收方未声明的 ID。已知 extension value 必须按该
extension 自己的 closed schema 校验。接收方必须（MUST）有界忽略未知 entry，不得因它改变 v1 identity、
authorization、membership、cursor、核心状态机或已知字段含义。实现必须在 JSON 解析前执行本地 body
byte 上限，并对解析深度、对象成员数和数组长度执行有限上限；这些本地上限不得成为远端可协商参数。

extension 不得新增 v1 合规所必需的行为，也不得放宽 v1 的签名、认可、授权或验证要求。某能力成为所有
节点正确互操作所必需时，必须进入新的整数 wire major。

`POST /s2s/v1/discover` 同时是能力查询和可丢失、可重复的轻量失效提示。request body 只携带 signer
`origin`；response 立即返回接收方自己的当前 capability view。发送方必须先更新自己的 discover response
再调用对端。成功响应只表示对端接受了刷新提示并返回自身能力，不表示已经反向获取发送方的新能力、启用
扩展或完成重新协商。接收方自主决定异步刷新时间；在刷新成功前继续使用上次已验证结果。新增 extension
只有刷新且后续 Health 接受后才能发送；删除 extension 被刷新观察到后必须立即停止新的发送。节点还应该
使用有上限、带抖动的周期 discover 保证提示丢失后最终收敛。

## 3. Federation v1 HTTP 接口面（HTTP Surface）

下表是完整 v1 surface；同步面包含三个 GET feed、两个 GET thread query、一个 POST feed-head hint 和一个
POST capability discover/exchange。
`鉴权上下文` 决定签名验证时如何获取 key 以及哪些 peer 状态可以（MAY）调用 operation；它不改变
第 6 节的签名 wire format。

| Method | Absolute path                       | 鉴权上下文         | Request                   | Success     | Response               |
| ------ | ----------------------------------- | ------------------ | ------------------------- | ----------- | ---------------------- |
| `GET`  | `/.well-known/socfp`                | 公开 TLS           | 无 query、无 body         | `200`       | 裸 discovery object    |
| `POST` | `/s2s/v1/recognize`                 | bootstrap signed   | JSON signer domain        | `200`       | 裸 recognize OK        |
| `POST` | `/s2s/v1/healthy`                   | status signed      | JSON signer domain        | `200`       | 裸 privacy-safe status |
| `POST` | `/s2s/v1/discover`                  | lightweight signed | JSON signer origin        | `200`       | 裸 v1 capability view  |
| `POST` | `/s2s/v1/feed-heads`                | lightweight signed | JSON feed-head hint       | `200`       | success ack envelope   |
| `GET`  | `/s2s/v1/state-feed`                | recognized signed  | feed query                | `200`       | success data envelope  |
| `GET`  | `/s2s/v1/message-feed`              | recognized signed  | feed query                | `200`       | success data envelope  |
| `GET`  | `/s2s/v1/message-tombstone-feed`    | recognized signed  | feed query                | `200`       | success data envelope  |
| `GET`  | `/s2s/v1/messages`                  | recognized signed  | thread data query         | `200`       | success data envelope  |
| `GET`  | `/s2s/v1/message-tombstones`        | recognized signed  | thread data query         | `200`       | success data envelope  |
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
- **lightweight signed**：用于 `feed-heads` 和 `discover`。接收方在返回该 signer 的 Recognize `OK` 前必须（MUST）
  原子开放该方向门禁；signer 只有收到 `OK` 后才可以（MAY）发送。它不要求完整 `available`，但不能授权其他数据面。
- **recognized signed**：signer 必须（MUST）已有 pinned root、完整双向认可事实和当前有效的 signing key
  certificate，并通过 operation 自身的业务授权。接收方不得（MUST NOT）仅因本地缓存的可用性视图为
  `degraded` 而拒绝请求；成功验证并处理的请求/响应往返可以（MAY）按 recognition.md 清除纯传输降级。
  `halted` 仍是协议或策略硬门禁，具体原因保留在 lifecycle 之外。Call 对已有活动
  binding 的安全终止规则由 calls.md 进一步定义。

上述硬门禁必须（MUST）保留导致 `halted` 的具体 wire 结果，不得（MUST NOT）合并成通用“未信任”错误：policy block
使用 `FEDERATION_PEER_BLOCKED`，identity contradiction 使用 identity 错误，版本不兼容使用
`FEDERATION_PROTOCOL_VERSION_UNSUPPORTED`。它们共享一个“停止自动通信”的 lifecycle，但原因和安全含义仍不同。

三个资源 operation 的 path/query、响应、授权、Range、closure 和错误契约由
[资源接口](./resources.md)完整定义；HTTP surface 表及本节概要不得覆盖其字段级要求。

未列入本节完整 surface 的路径不属于 Federation v1。
`recognize`、`healthy` 和 `discover` 的字段、双向状态、pin、重试与隐私由
[Federation v1 服务器认可](./recognition.md) 定义。

本地 peer lifecycle 是 `unrecognized`、`establishing`、`available`、`degraded` 或 `halted`。它与 Healthy 返回的
`available | degraded | unavailable` 隐私投影不是同一个枚举：

- `unrecognized` 表示尚无可用的 pinned/recognition identity。
- `establishing` 是 root 已固定，但双向 Recognize 或服务准备事实尚未收敛；主动发起方必须（MUST）在发送
  第一个 Recognize HTTP request 前进入该状态。
- `available` 是双向认可、服务准备和可达性全部收敛的完整可用状态。
- `degraded` 是双向认可已建立，但当前可达性发生可重试故障的状态。
- `halted` 是可验证硬失败后的统一非自动恢复状态；具体 HTTP 错误或本地安全原因单独保留，等待管理员处理。

`available`/`degraded` 是本地可用性与调度信息，不单独构成普通 operation 的授权条件。operation gate 必须
（MUST）由 pinned identity、方向确认事实、版本、策略和业务授权共同计算；完整状态和转换以
recognition.md 为准。

Recognize 接收方必须（MUST）在返回 `OK` 前原子开放该方向的 `feed-heads` 和 `discover`
接收门禁。发送反向
Recognize 的 server 必须（MUST）在发出 HTTP request 前完成本地服务准备，使对方随后发起的 Healthy
查询至少返回 `degraded`，而不是 `unavailable`。具体提交边界和竞态时序以 recognition.md 为准。

## 4. 公开发现与密钥（Well-Known and Keys）

发现文档、root identity、signing key certificate 与轮换的规范性定义见
[传输与安全](./transport-security.md)第 1 节。

## 5. 网络、TLS 与逻辑权威（Network, TLS, and Authority）

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

### 6.2 联邦共享类型（Shared Federation Types）

operation 引用下表类型时，必须（MUST）遵守其格式、范围和规范化要求，不得（MUST NOT）重新定义或放宽。

| 名称                     | v1 传输 grammar 与语义                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Domain`                 | ASCII 小写 DNS name，总长 1–253，label 长 1–63，只允许 `a-z`、`0-9`、`-`，label 首尾不得（MUST NOT）为 `-`，on the wire 不带末尾根点 |
| `UserAccount`            | 规范化的小写 ASCII 用户账号；匹配 `^[a-z0-9][a-z0-9._-]{0,29}$`，总长 1–30 characters                                                |
| `GroupAccount`           | `!` 加规范化的小写 ASCII 群组账号；匹配 `^![a-z0-9]{2,30}$`，总长 3–31 characters                                                    |
| `Account`                | `UserAccount` 或 `GroupAccount`；大小写敏感且只接受上述小写形式；operation 必须（MUST）拒绝不符合其资源类型的 account                |
| `Address`                | closed JSON object `{ "account": Account, "domain": Domain }`                                                                        |
| `DecimalString`          | 字面值 `"0"` 或不以 `0` 开头的非空 ASCII 十进制 digit string；不得（MUST NOT）改用 JSON number                                       |
| `SignedDecimalString`    | 字面值 `"0"`，或可选 `-` 加不以 `0` 开头的非空 ASCII 十进制 digit string；禁止 `-0`，不得（MUST NOT）改用 JSON number                |
| `PositiveDecimalString`  | 首字符为 `1..9`、后续字符为 `0..9` 的非空 string                                                                                     |
| `SafeInteger`            | JSON integer，范围 `0..9007199254740991`                                                                                             |
| `PositiveSafeInteger`    | JSON integer，范围 `1..9007199254740991`                                                                                             |
| `EpochMilliseconds`      | Unix epoch milliseconds，编码为 `SafeInteger`                                                                                        |
| `Sha256Hex`              | `^[a-f0-9]{64}$`                                                                                                                     |
| `Base64Ed25519Key`       | RFC 4648 padded base64，解码后恰好 32 bytes                                                                                          |
| `Base64Ed25519Signature` | RFC 4648 padded base64，解码后恰好 64 bytes                                                                                          |
| `KeyId`                  | `Domain "/" KeyName`，`KeyName` 匹配 `^[A-Za-z0-9._-]{1,64}$`；第一个 `/` 前的完整字符串是 signer domain                             |
| `CanonicalUuid`          | 小写 RFC 4122 文本形式，版本 nibble 为 `1..8`，variant nibble 为 `8`、`9`、`a` 或 `b`                                                |

v1 on the wire 只接受上表的规范化 `Domain` 和 `Account`。发送方必须（MUST）以小写 ASCII 发送两者；
RFC 6762 special-use `.local` namespace 不是全球稳定的服务器身份，因此 `local` 以及任何以 `.local` 结尾的
`Domain` 不得（MUST NOT）出现在 SOCFP wire 上。实现可以在本地存储中使用 `local` 作为内部标记，但必须在
联邦边界将其转换为该服务器真实的 `Domain`，且不得向 peer 暴露该标记。
`Account` 必须（MUST）来自已经规范化的 Federation account ID，不得（MUST NOT）把 display name 或未经
身份映射的原始用户输入直接写入 S2S 请求。用户输入中的大小写、空白、Unicode domain 或末尾根点必须（MUST）
在进入 S2S 边界前由发送方完成确定性规范化或拒绝。接收方必须（MUST）拒绝含大写字母、空白、Unicode
或其他非规范形式的 transmitted `Domain`/`Account`，不得（MUST NOT）在接收后小写化、修剪或通过宽松
规范化把两个不同 transmitted value 当作同一身份。数据库 ID 不得（MUST NOT）作为 server 间身份坐标。

#### 6.2.1 Account 永久绑定（Permanent Account Binding）

`Address` 是跨时间的永久身份坐标，不是可重新分配的显示名或可回收的用户名。一个 domain
首次将 `{ account, domain }` 作为某个用户或群的身份发布后：

- 该 `Address` 必须（MUST）在任何时刻都指向同一个逻辑实体，且其资源类型（用户或群）不得
  （MUST NOT）改变。
- 用户或群的 `account` 不得（MUST NOT）重命名、迁移或原地替换。改变 display name、profile、群主、
  roster 或其他可变属性不改变该绑定。
- 用户被删除、停用、无法再访问或以其他方式消失，以及群被解散、删除或不再可访问后，其
  `Address` 仍必须（MUST）永久保留绑定并视为已占用；不得（MUST NOT）释放、回收或重新分配给
  任何新用户或新群。
- 实现可以（MAY）不再对外返回已消失实体的 profile 或业务资源，但必须（MUST）持久保留足以防止
  `Address` 被再次分配的占用记录（tombstone/reservation）。物理删除业务资料不得（MUST NOT）删除该占用事实。

因此，consumer 看到同一 `Address` 的后续资料或群状态时，必须（MUST）将其解释为原实体的状态演进，
不得（MUST NOT）将其解释为 account 已转让给新实体。如果实现无法确认该永久绑定，必须（MUST）
fail closed，不得（MUST NOT）通过创建新实体来解决冲突。

### 6.3 已签名请求的构造与验证（Signed Request Construction and Verification）

请求目标、body digest、必选 header、HTTP Message Signature、验证顺序和固定示例的唯一规范性定义见
[传输与安全](./transport-security.md)第 3 节。operation 文档只定义 method、path/query 参数、body shape
和鉴权上下文，不得（MUST NOT）另设签名 profile 或改变共享验证顺序。

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

v1 中 `feed-heads` 是 ack operation。其他 operation 不得（MUST NOT）自行省略 `data`；如果其语义上没有结果，
operation 规范 必须（MUST）明确定义 `data: null`。

### 7.3 错误响应封装（Error Envelope）

所有 JSON error response 必须（MUST）符合
[Federation v1 错误码注册表](./errors.md)定义的 `FederationError` envelope。稳定 code、精确 HTTP status、
结构化 `data`、未知字段/code、status/code 冲突和 caller action 均以该注册表为唯一权威来源，operation
文档不得（MUST NOT）重新定义通用 envelope。

`healthy` 的固定 `unavailable` 是成功解析后的状态结果，不是 error envelope；raw media response 的成功与
中途失败边界仍按第 7.1 节处理。

### 7.4 重试与提交边界（Retry and Commit Boundaries）

`feed-heads` 成功返回 HTTP `200`；这表示 feed-head hint 已被接受，不表示对端 durable feed 已完全排空。
`call` 在 frame 已完成同步验证和临时状态处理后返回 200；它不表示终端已收到事件或媒体已连通。
网络错误、无法解析的 proxy response 和允许重试的 `5xx` 可以（MAY）使用完全相同的业务请求重试，
但必须（MUST）重新生成 `Date`、`created`、`expires` 和 HTTP signature。malformed、binding、authorization 和
identity conflict 不得（MUST NOT）原样无限重试。`Retry-After` 出现时必须（MUST）是非负十进制 delta-seconds；
consumer 应该（SHOULD）遵守它，并在缺失时使用有上限、带 jitter 的指数退避。

cursor 只能在 response 完成 operation 规定的验证且本地副作用与 cursor 同事务提交后推进。
operation 可以（MAY）明确把单个 item 定义为可隔离失败；该 item 按 operation 规则被隔离且未产生有效业务事实后，
不妨碍其他合法 item 与 cursor 提交。HTTP 超时、连接中断、
非零 code、malformed success body 或未知 code 均不得（MUST NOT）推进 cursor。operation 文档必须（MUST）定义其重复请求的
幂等 key 和可观察结果；不得（MUST NOT）仅因 HTTP request 换了新签名就将同一业务命令当作新命令。

## 8. 持久状态与生命周期（Durable State and Lifecycle）

`state-feed` 承载 home-owned `PROFILE`、source-scoped `MEMBER_PROFILE`、三个统一语义的方向 intent 和
origin-authoritative `GROUP_META`。方向事实按 stable key 与 business revision 合并；相同或更旧
revision 是完整 no-op。P2P 只有双方方向均为 `ACCEPTED` 才成立；群 roster 最终以 origin 的
`GROUP_META` 为准。

`state-feed` 的完整 page、六种 event body、字段约束与合并语义由
[Federation v1 State Feed](./state-feed.md) 定义；`message-feed` 的 `thread + messageEndSeq` 压缩索引和
`/messages` query 由 [Federation v1 Message Feed](./message-feed.md) 定义，十种 message content、媒体与
转发 body 由 [Message](./message.md) 定义；墓碑压缩索引与权威删除 query 由
[Federation v1 Message Tombstone Feed](./message-tombstone-feed.md) 定义。三者与本文
共同构成 v1 规范性正文，概要不能覆盖其字段级要求。

一对一实时通话采用 WebRTC media/JSEP，并以签名 `/s2s/v1/call` frame 承载本协议的联邦信令。完整 HTTP
operation、frame、生命周期、失败语义以及同一连接上的 AUDIO→VIDEO 单向升级由
[Federation v1 语音与视频通话](./calls.md) 定义。实时 frame 不进入 feed；终态历史是普通 `CALL`
message。

关系撤销、退群、踢出、解散和 profile/roster 更新必须（MUST）通过 durable state 收敛，不能依赖 revision
hint 或普通消息 payload。

权限撤销停止未来 allocation，但不删除已经分配给 peer 的历史 proof。历史读取和 media 授权按
各自的 thread audience 验证；message-feed allocation 不能替代媒体或 forward bundle 的资源授权。
服务器本地的群容量、quota 和保留策略不是 protocol constant。

## 9. 数据源、投递、游标与媒体恢复（Feeds, Delivery, Cursors, and Media Recovery）

以下发布、恢复与防回环规则是 v1 contract：

- feed 由按目标 peer 分配的 durable change 构成；change 引用或承载其可见的 durable fact，
  不是“排除请求方本人内容”的作者过滤视图。
- `state-feed` 可以（MAY）返回由请求方最初提出、随后被发布方持久化并确认、否定或升版的方向事实。
  consumer 必须（MUST）按 compacted key 和 business revision 幂等合并，不得（MUST NOT）把“作者是自己”当作丢弃条件。
- message item 的 `seq/createdAt` 是当前 publisher 的本地副本坐标和持久化时间。当前 publisher 作为
  timeline 权威源发布的消息，其 `originSeq/originCreatedAt` 必须为 `null/null`；拉取形成的非权威副本必须把直接 publisher 的
  `seq/createdAt` 保存为自己的 `originSeq/originCreatedAt`。
- consumer B 从 publisher A 拉取并成功持久一条消息后，应该（SHOULD）使 B 的持久化副本可由 A 通过 message query 读取，作为 processing receipt，
  分配回 A，推进 B 面向 A 的该 thread `messageEndSeq`，并以新 message-feed 索引 item 通知 A。A 随后通过
  B 的 `/messages` query 读回该副本；`(thread, author, originSeq)` 指明 A 先前发布的哪条消息已被 B 持久处理，
  B 的 publisher-local `seq/createdAt` 表达 B 的本地副本坐标和时间，`originSeq/originCreatedAt` 等于 A 原 item 的 `seq/createdAt`。因此 processing acknowledgement
  来自 query message，不是 message-feed item 本身。
- A 必须（MUST）用 receipt 的 `(thread, author, originSeq)` 关联自己先前发布的 `(thread, author, seq)`，不创建重复消息、不改写原消息，也不为其分配新的
  message-feed item。processing receipt 只对该副本的直接 publisher 可见；v1 的固定拓扑不存在 receipt 的后续分发步骤。
  receipt 是推荐的诊断能力，不是可靠 ACK；receipt 缺失只表示 A 尚未观察到成功持久副本，不能证明 B 未接收、已丢弃或以某个原因隔离。
- 群 origin 从成员 home server 接收第三方 authored submission 后，必须先验证作者、群成员资格和内容并
  持久接受；随后只能由 origin 向各 mirror 权威分发。mirror 只接受已知 group origin 作为该群分发 source，
  不得继续发布给其他 peer。v1 不携带 author server 的端到端 message signature；mirror 信任的是已认证
  group origin 对已接受群 timeline 的权威断言，而不是任意 thread participant 的转述。
- 同一 `(source domain, thread, seq)` 的 v1 item 不可变；重复 item 的 authored content、资源和
  坐标字段必须语义相同。v1 message wire 不传输 publisher-local `updatedAt`，也不用它表达编辑、撤回或删除；撤回与生效
  治理删除通过独立 `message-tombstone-feed` 表达。

### 9.1 Feed 坐标词汇

本规范中的 feed 坐标统一采用以下术语；不得用未限定含义的 `HWM` 同时指代其中多个值：

- `feedId`：source 在一个 feed 坐标空间中分配的正整数 item ID。state、message 与 tombstone 使用三个
  彼此独立的 per-peer 空间；ID 严格增加、不复用，但可以不连续。
- `after`：consumer 提供的 exclusive 扫描位置。source 不把它当作 ACK，也不验证其单调性。
- `through`：一次有界排空的 inclusive 上界；它不表示确认。
- `scannedThrough`：page 已连续扫描完成的 inclusive 边界，也是成功提交后下一次请求的 `after`。
- `resumeAfter`：省略 `after`、message query 旧正文已清理，或请求位置明显超出当前 end 时，
  source 返回的下一个有效 exclusive 请求位置。
- `stateFeedEndId` / `messageFeedEndId` / `tombstoneFeedEndId`：feed-heads 发布的三个独立 inclusive drain
  上界。它们是排空目标，不是 consumer cursor、业务 revision、thread 授权边界或
  关系终止位置，不得出现在 `P2P_INTENT` body 中。
- `messageEndSeq` / `tombstoneEndSeq`：某个 thread 可查询内容的 inclusive 上界；它们分属两个
  thread-local 坐标空间，不是 feed ID。

feed 和 thread query 的 cursor/end 使用非负十进制字符串，item ID 与业务 sequence 使用正整数。
`0` 表示第一个合法 ID 或 sequence 之前的 exclusive cursor，本身不是 item ID 或业务 sequence。
实现可以（MAY）从大于 `1` 的值开始分配，也可以（MAY）保留空洞；只要已分配的值严格增加、永不复用，
并且 bootstrap `resumeAfter` 不会使 consumer 漏掉当前应可见的数据。实现可以（MAY）返回满足上述条件的
任意非负 `resumeAfter`。

### 9.2 通用 Feed 规则

三个 feed 的 `after` 都可省略以查询当前可用起点，此时 source 返回
`FEDERATION_FEED_CURSOR_UNAVAILABLE` 和 `resumeAfter`，不返回 page。省略 `after` 时不得携带其他 page
参数。该 `resumeAfter` 是 feed 的 bootstrap base：从它开始排空必须能观察到当前对该 peer 可见的完整
压缩投影。source 不得简单返回当前 feed end 而跳过已存在的当前 item。三个 feed 都可包含
可选 `take` 和 inclusive feed-ID 上界 `through`。`take` 只是 consumer 建议扫描数，source 应参考但
可根据服务能力采用不同页大小；各 feed 的精确规则由其 operation 定义。带 `through` 的连续分页必须
保持该值不变；它只限制读取窗口，不是
确认、删除或历史降级操作。三个 feed 各有独立 per-peer allocator 和 consumer 本地 cursor，但 source 不维护
consumer ACK/cursor。page 返回 `scannedThrough`、feed end 和 `hasMore`。

所有 feed-ID 窗口统一使用左开右闭区间。请求 `after=A&through=T` 表示 `(A, T]`：`A` 已由 consumer
提交，必须排除；`T` 是本轮包含的上界。page 的实际完成窗口是 `(after, scannedThrough]`，因此
`feedId === scannedThrough` 被包含，`feedId === after` 不得再次应用。`through` 省略时只表示本次请求使用
source 冻结的当前 `*FeedEndId`，不改变左开右闭规则。本文中 HTTP byte range、时间区间及其他非 feed
坐标不受本约定约束。

page 与 consumer 本地 cursor 必须（MUST）在一个事务中提交。重复 page 必须（MUST）幂等；空 page 也可通过
`scannedThrough` 推进。source 不验证 `after` 是否等于上一个 page；consumer 自行保证本地 cursor 不后退。feed ID 只要求
严格递增，不要求连续；`scannedThrough` 和下一条 item ID 都可以（MAY）跨越任意大的已删除或未分配空洞。

三个 feed 都是持久压缩投影，不得因时间、容量或历史清理建立 retained floor。旧 stable-key item 可被
新 item 替换，但新 item 必须分配更大 feed ID。state feed 可按其 operation 规则省略已无可见性来源的
member 投影；P2P 关系终止后，message 和 tombstone feed 也可分别删除该 peer/thread 的当前
投影，而不回退各自的 feed end。两个 data feed 的 thread 集合独立，不要求对齐；从未撤回过的
thread 可以只有 message 投影。重建已删除的投影时必须分配新的、更大 feed ID。正文清理只
影响 message query；tombstone 事实永久保留，即使其当前发现索引投影已因失权被移除。

`feed-heads` 的核心字段是 `origin`、`stateFeedEndId`、`messageFeedEndId` 和 `tombstoneFeedEndId`，并可
携带第 2.1 节定义的可选 `extensions` 容器。三个 end 是独立压缩 feed 的 inclusive 扫描上界，只用于
唤醒和有界排空，不是 ACK、业务 revision 或 query seq；extension 不得改变这些核心字段的处理。
publisher 必须先提交 state 及其 feed 索引，再使依赖它的 data-feed item 可见。hint 可丢失、重复或乱序，
不得成为唯一恢复载体。

consumer 收到 hint `(S, M, D)` 后 MUST 使用各 feed 已提交的本地 cursor，按以下有界顺序排空：

```text
state-feed?after=<localStateCursor>&through=S
message-tombstone-feed?after=<localTombstoneFeedCursor>&through=D
message-feed?after=<localMessageFeedCursor>&through=M
```

必须先完整提交 state cursor 到 `S`，才能请求本轮两个索引 feed；不得并行拉取三个 feed。索引 item 只合并 thread end seq，实际内容通过
`/messages` 和 `/message-tombstones` 查询。对同一 thread，先排空 tombstone query，再排空 message query。
压缩可使某 item 在排空期间移到更大 feed ID；它必须通过后续 hint 或周期 reconciliation 被再次发现。
consumer 可对重复或乱序 hint 的三个坐标分别取数值最大值。
索引 feed 中某个 thread 投影的缺失不是删除通知，consumer 不得通过对比 message 与
tombstone 的 thread 集合推导状态。关系终止以 state feed 为主路径；若本地仍持有旧 end 并发起
query，当前授权失效所得的 `FORBIDDEN` 是兜底信号。consumer 应使该 thread 的当前待查询
目标失效、优先重新排空 state feed，但不回退全局 feed cursor 或已提交的 thread-local cursor。
启动和周期 reconciliation 即使没有收到 hint，也 MUST 先使用本地 state cursor 读取并排空 state feed，
再依次读取 tombstone 和 message feed；每个 feed 首个未携带 `through` 的成功 page 返回的 end 可固定为该次
drain target，该首 page 计入本轮，后续 page 使用该 target 作为 `through`。三个 end 不要求来自跨 feed 原子
snapshot。若索引 page 引用本地未知 thread，consumer MUST 回滚该索引 page、重新排空 state feed 后原样
重试，而不是丢弃 item 或推进索引 cursor。对同一个未改变的索引 page 只执行一次这种恢复；完整 state
排空后重试仍未知，必须把响应判为 protocol/binding conflict，保持索引 cursor、停止该 peer 的自动 data-feed
排空并审计，不得无限重试或跳过 item。publisher 的 state-before-data allocation 顺序与该恢复规则共同
避免“尚无 thread 却提交消息索引”。进程恢复时先确认已缓存 peer 的 root identity 和可用 signing
certificate，再开始排空。

媒体 content 只携带显式 digest，不携带 publisher 展示或下载 URL。媒体消息可先作为 durable pending
work 提交，再由 consumer 按 outer message 授权坐标构造 `media/:digest` Range 请求。下载授权 必须（MUST）
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

任何 pinned root identity contradiction 必须（MUST）保留旧 pin、记录原因并原子进入 fail-closed `halted`。不允许当前
域名控制者、未经 pinned root 授权的 signing key、裸删 peer row 或普通重新发现继承旧授权。

`halted` 之后的诊断、恢复、重置或重新认可属于本地管理行为，v1 不定义其端点或流程。在管理员明确处理前
不得（MUST NOT）自动恢复通信；任何新 root 都不得（MUST NOT）自动继承旧 identity 的认可事实或业务授权。

## 11. 合规性与发布（Conformance and Publication）

第 0 节的规范性文档集合定义 v1 合规性；JSON Schema、HTTP manifest、正反向量和离线
conformance CLI 与正文一同发布，作为非规范性验证资源。工具与正文冲突时以正文为准并修复工具。

Conformance 不是 v1 接口、协商能力或节点运行时前提，协议也不规定实现者必须（MUST）使用哪种测试
设施。随附 CLI 可检查 JSON shape、固定签名向量和 HTTP surface；事务、身份连续性与状态收敛仍需
实现者自行验证，具体测试策略不属于协议组成部分。
