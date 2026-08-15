# Simple Open Chat Federation Protocol v1 传输与安全（Transport and Security）

状态：`RELEASE CANDIDATE`（`v1.0.0-rc.0`）

本文定义 Federation v1 的发现文档、root identity、签名密钥证书、网络发现、TLS、HTTP request target、
Content-Digest 和 HTTP Message Signature profile。它是 [Simple Open Chat Federation Protocol v1](./protocol.md)
明确引用的规范性组成部分；operation 文档不能放宽本文的身份、传输或签名安全要求。

规范词 `必须（MUST）`、`不得（MUST NOT）`、`应该（SHOULD）`、`不应该（SHOULD NOT）` 和
`可以（MAY）` 按 RFC 2119/RFC 8174 解释。

## 1. Well-Known 发现与签名密钥（Well-Known Discovery and Signing Keys）

### 1.1 公开发现模式（Public Discovery Mode）

无 query 的 `GET /.well-known/socfp` 是公开 discovery request，不使用 HTTP Message Signature。成功响应
必须（MUST）使用 `Content-Type: application/json` 并返回以下裸 JSON object：

```ts
interface DiscoveryDocumentV1View {
  software?: string;
  protocolVersions: number[];
  rootKey: {
    ed25519: Base64Ed25519Key;
  };
  keys: SigningKeyCertificate[];
}
```

上面的 interface 是选择 v1 后必须（MUST）验证的视图，不表示跨版本 well-known 只能包含这些字段。
例如同时发布 `[1, 2]` 的节点可以（MAY）保留全部 v1 共享字段并增加 v2 字段；v1 consumer 忽略新增
字段，v2 consumer 则按 v2 规范验证其必选性和含义。

`software` 是可选、不可信的 opaque diagnostic string。若存在，UTF-8 编码后 必须（MUST）为 1–128 bytes，
不得（MUST NOT）包含 Unicode control character；建议使用 `product/version`，但 consumer 不得（MUST NOT）解析或依赖其
格式，不得（MUST NOT）用它进行版本协商、能力判断、身份验证、授权或实现特例。它始终是不可信的诊断输入。

`protocolVersions` 必须（MUST）符合[主协议](./protocol.md)第 2 节。`rootKey` 是服务器身份锚对象（server identity anchor object），
本身只是包含 root 公钥的对象容器；真正的 Ed25519 root 公钥值位于 `rootKey.ed25519`。

`keys` 必须（MUST）是非空数组，可同时包含旧、当前和尚未生效的 signing key certificate。同一文档中
`keyId` 不得（MUST NOT）重复，并且至少一个 certificate 必须（MUST）在响应生成时有效。root key 和 HTTP signing key
是不同的角色，不得（MUST NOT）以两者 public key 相等作为协议要求。

| JSON key                        | 必选 | 角色与示例                                                                                                                                                                        |
| ------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `software`                      | 否   | 不可信诊断文本，例如 `example-server/1.4.2`；不参与任何协议判断                                                                                                                   |
| `protocolVersions`              | 是   | 完整支持的主版本集合，例如 `[1, 2]`                                                                                                                                               |
| `rootKey`                       | 是   | 长期服务器身份锚对象；是对象容器，不是独立的公钥值                                                                                                                                |
| `rootKey.ed25519`               | 是   | Ed25519 root public key，例如 `A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=`；不直接签普通 HTTP request                                                                           |
| `keys`                          | 是   | root 授权的 signing key certificate 数组；允许轮换 overlap                                                                                                                        |
| `keys[].keyId`                  | 是   | certificate 的 domain-bound 名称，例如 `a.example/key-1`；不是 public key 或秘密                                                                                                  |
| `keys[].ed25519`                | 是   | 在线 HTTP/claim signing public key，例如 `Kay64UG8yvCyLhqU000LxzYeUm0L/hLIl5S8kyKWbdc=`                                                                                           |
| `keys[].notBefore`/`notAfter`   | 是   | certificate 的半开有效区间 `[notBefore, notAfter)`，单位为 Unix epoch milliseconds                                                                                                |
| `keys[].authorizationSignature` | 是   | root private key 对第 1.3 节 certificate statement 的 Ed25519 signature；完整可验证示例见 [服务器认可](./recognition.md#10-完整-http-构造示例complete-http-construction-examples) |

选择 v1 的 consumer 必须（MUST）忽略 v1 未定义的 well-known 字段，但不得（MUST NOT）据此形成 v1
接口、授权或安全行为分支。v1 不通过 well-known 发布运行时 limits。page、body、media、quota、
群容量和 retention 等限制按各 operation 的确定响应处理。

### 1.2 根密钥验证与固定（Root Key Verification and Pinning）

root public key 不能通过 self-signature 自行建立首次信任。首次信任来自 hostname 验证成功的 HTTPS；
root signature 把可轮换 signing key 绑定到该 root；HTTP Message Signature 证明请求方持有 signing
private key。三者用途不得（MUST NOT）混淆。

root public key 的 strict base64 规则、逐字节固定、首次 Recognize 验证顺序、domain binding 和 pin 事务由
[Federation v1 服务器认可](./recognition.md#4-身份验证认可与固定identity-verification-recognition-and-pinning) 定义。不得（MUST NOT）仅因成功读取 well-known
就建立认可关系。

已建立 peer 的后续验证必须（MUST）使用本地 pinned root，而不是把新获取的 root 当作新的信任锚。重新获取
well-known 时，root public key 必须（MUST）与 pin 逐字节完全一致；不一致是 identity contradiction，
必须（MUST）进入 `halted`、记录 identity mismatch 原因并拒绝普通 S2S operation。v1 不支持在原认可关系上轮换
root key；采用新 root 必须（MUST）执行 destructive reset 和 fresh bidirectional Recognize。

### 1.3 根授权签名密钥证书（Root-Authorized Signing Key Certificate）

```ts
interface SigningKeyCertificate {
  keyId: KeyId;
  ed25519: Base64Ed25519Key;
  notBefore: EpochMilliseconds;
  notAfter: EpochMilliseconds;
  authorizationSignature: Base64Ed25519Signature;
}
```

`keyId` 的 domain 必须（MUST）等于 publisher 的 server domain，并且 `notBefore < notAfter`。因此
certificate statement 不重复 `domain` 字段；domain binding 由完整、canonical `keyId` 提供。同一 root
identity 下的 `keyId` 一旦发布就永久绑定到同一 `ed25519`，publisher 不得（MUST NOT）使用已用
`keyId` 标识另一把 public key。

`authorizationSignature` 是 root private key 对以下规范 certificate statement 的 Ed25519 signature。
statement 使用固定字段顺序、无额外空白的 JSON，编码为 UTF-8；`notBefore` 和 `notAfter` 使用
certificate 中的 JSON integer 字面值：

```text
{"keyId":"<key-id>","ed25519":"<base64-key>","usage":"socfp-http-message-signature","notBefore":<epoch-ms>,"notAfter":<epoch-ms>}
```

上面的 statement 是 v1 验证 `authorizationSignature` 时使用的精确签名输入。后续主版本可以（MAY）
继续复用这个共享 certificate 核心，也可以（MAY）增加自己的 certificate 字段；但不得（MUST NOT）
改变现有字段或 `authorizationSignature` 的 v1 含义。新增字段若影响 key authorization，新主版本
必须（MUST）定义新的、可独立验证的签名字段或签名结构。well-known 中不需要独立的
`certificateVersion`，因为适用要求由已选择的 Federation 主版本决定。

consumer 必须（MUST）使用 discovery document 的 root public key（已建立 peer 使用已 pinned root public key）
验证 `authorizationSignature`。certificate 只在 `notBefore <= now < notAfter` 时可用于生成或验证
HTTP Message Signature。过期或尚未生效的 certificate 不得（MUST NOT）用于接受请求，但未生效 certificate
可以（MAY）预先缓存。

### 1.4 签名密钥轮换与按需发现（Signing Key Rotation and On-Demand Discovery）

计划轮换时，publisher 应该（SHOULD）先在 `keys` 中发布新 certificate，使新 key 的 `notBefore` 早于
旧 key 的 `notAfter`，并在 overlap 期间保留两个 certificate。publisher 不得（MUST NOT）在 certificate 的
`notAfter` 之前从 well-known 移除它，也不得（MUST NOT）使用尚未到 `notBefore` 或已过 `notAfter` 的 key
发送请求。

consumer 可以（MAY）缓存已经 pinned root 验证的 certificate 直到 `notAfter`。收到未缓存的 `keyid` 时，
consumer 应该（SHOULD）在 per-domain 限速下立即重新获取 well-known，验证 pinned root、certificate 和有效期后
再验证原 HTTP request。well-known 暂时不可达是可重试的 key-fetch failure，不是 identity loss。
请求使用未发布、root 授权无效或当前无效的 `keyid` 时，接收方必须（MUST）拒绝该请求。

经 pinned root 正确授权的 signing key 增加、激活、过期和移除是正常轮换，不得（MUST NOT）改变
peer identity、首次认可确认时间、cursor、mirror 或已有 authorization。root public key 与已 pinned 值逐字节
不一致仍是 identity contradiction，必须（MUST）以 fail-closed 方式处理。

## 2. 网络发现、传输与签名安全（Network Discovery, Transport, and Signature Security）

Federation peer 是服务器侧配置和信任的 domain identity，不是面向客户端的任意 URL 资源。

### 2.1 强制 SRV 解析（Mandatory SRV Resolution）

给定 canonical peer `Domain` 值 `D`，实现必须（MUST）查询 exact owner name `_socfp._tcp.D` 的 DNS SRV
RRset。发布有效 SRV record 是 server 启用 Federation 的必选条件；v1 不允许绕过 SRV 后直接解析
`D`，也不定义默认 `443` 或本地直连配置等替代发现路径：

1. 收到非空、语法有效的 SRV RRset 时，按 RFC 2782 的最低 `priority` 优先和同 priority `weight`
   随机选择规则处理。`priority`、`weight` 必须（MUST）是 `0..65535`；非 `.` target 的 `port` 必须（MUST）是
   `1..65535`，target 必须（MUST）是可规范化为[主协议](./protocol.md)第 6.2 节 `Domain` 的 DNS hostname。target 不得（MUST NOT）是 IPv4
   或 IPv6 address literal；带方括号的 IPv6、十进制 IPv4 及其他直接 IP 表示均无效。target 可以（MAY）位于
   `D` 之外，但按 RFC 2782 不得（MUST NOT）是 CNAME alias。
2. 对选中的 target 解析 A/AAAA，并连接该 target 的选定 port。每个可连接 target 必须（MUST）至少解析出一个
   可用的 A 或 AAAA record，不要求同时支持 IPv4 和 IPv6。v1 不规定地址族或同族地址的优先级；调用方
   可以（MAY）根据本地路由、历史成功率、连接延迟和当前网络状况选择、交错或并行尝试连接。连接失败后
   应该（SHOULD）继续尝试尚未尝试的地址和 SRV record，并继续遵守 SRV priority/weight 语义。A/AAAA 结果
   只是 hostname 的替代连接地址，不是 SRV target、peer identity、TLS name 或 HTTP authority。
   target 没有任何可用 A/AAAA 结果时，该 record 不可连接；不得（MUST NOT）把 target 文本按其他 IP 表示法解释。
3. publisher 必须（MUST）保证同一 SRV target 发布的全部 A/AAAA 地址，以及同一 SRV RRset 中用于同一
   logical peer domain 的全部 target，提供相同的 Federation identity、协议版本和一致的 durable
   state，并共享 operation 定义的幂等 key、recognition 与 cursor 状态。调用方从 IPv4 切换到 IPv6、
   从 IPv6 切换到 IPv4 或切换 target，不得（MUST NOT）使同一合规重试产生第二份业务副作用。
4. 地址级并行只表示并行建立连接。除非对应 operation 明确定义该请求可用相同幂等 key 安全重试，
   调用方不得（MUST NOT）因多个地址可达而并行发送同一个有副作用的 HTTP request。连接结果不确定后的重试
   仍必须（MUST）遵守[主协议](./protocol.md)第 7.4 节和对应 operation 的幂等规则。
5. SRV 查询得到确定的 `NXDOMAIN` 或 `NODATA` 表示 `D` 当前未发布 Federation 服务。调用方不得（MUST NOT）
   发起 Federation 请求，也不得（MUST NOT）尝试 `D:443` 或其他推测位置；仅可在 negative DNS TTL 到期或管理员
   明确触发后重新查询。
6. DNS timeout、`SERVFAIL`、`REFUSED` 或其他临时解析失败是可重试的 discovery failure。调用方必须（MUST）
   退避并保留已有 pin、cursor 和 mirror，不得（MUST NOT）把它解释成未发布服务或 identity loss。
7. sole SRV target `.` 明确表示该 domain 不提供 SOCFP；该特殊 record 的 port 应该（SHOULD）为
   `0`，且不得（MUST NOT）发起连接。`.` 与其他 target 混合、IP literal、非法 hostname/port 或无法唯一解释的
   RRset 是配置错误。
8. 尝试完有效 RRset 中的可用 target 仍无法连接时，本次操作以连接失败结束，不得（MUST NOT）改为直接解析 `D`、
   尝试裸 IP 或其他常见 port，也不得（MUST NOT）从 well-known/HTTP redirect 猜测替代位置。

SRV/A/AAAA 的正负缓存不得（MUST NOT）超过 DNS resolver 提供的有效 TTL；TTL 到期后的重新解析可以（MAY）改变连接
位置，但不得（MUST NOT）改变 peer identity。v1 不要求 DNSSEC，因为 DNS/SRV 只提供不可信 routing input；实现
可以（MAY）使用 DNSSEC、固定 resolver、IP/egress policy 或其他本地加固，但不得（MUST NOT）用 DNS 结果跳过 HTTPS、root
pin 或 request signature 验证。

最小有效发布示例：

```dns
_socfp._tcp.chat.example. 3600 IN SRV 0 0 443 chat.example.
chat.example.            3600 IN A   192.0.2.10
chat.example.            3600 IN AAAA 2001:db8::10
```

这里同时列出 A 和 AAAA 只是双栈示例；部署者只发布其中任意一种也符合 v1。SRV target 是
`chat.example`，不是 `192.0.2.10` 或 `[2001:db8::10]`。target 也可以（MAY）按前述规则委派给其他有效
hostname；无论 target 是什么，服务端在选定 port 上都必须（MUST）提供对 logical peer domain
`chat.example` 有效的 TLS certificate。

### 2.2 逻辑 Authority、TLS 与重定向（Logical Authority, TLS, and Redirects）

SRV 只把 TCP 连接委派到 target `T` 和 port `P`。逻辑请求目标始终是 peer domain `D`：

- TCP 连接到 `T:P`，但 TLS SNI 必须（MUST）发送 `D`，TLS certificate hostname 必须（MUST）按 `D` 验证，不得（MUST NOT）改为
  验证 SRV target `T`。
- HTTPS request authority、HTTP/2/3 `:authority` 和 HTTP/1.1 `Host` 必须（MUST）为 `D`；当 `P != 443` 时
  必须（MUST）为 `D:P`。SRV target `T` 不得（MUST NOT）出现在 request authority 中。
- HTTP Message Signature 的 `@authority` 必须（MUST）覆盖上述实际发送的 logical authority。
- well-known 和全部 S2S operation 不得（MUST NOT）自动跟随 HTTP redirect。任何 `3xx` 都是当前 operation
  失败；不得（MUST NOT）把 redirect target 当作新 peer、建立 pin、接受 response data 或推进 cursor。

例如 `_socfp._tcp.chat.example` 返回 target `edge.provider.example`、port `8443` 时，client 连接
`edge.provider.example:8443`，但发送 TLS SNI `chat.example`，验证 certificate 中的
`chat.example`，发送 `Host: chat.example:8443`，并签名 `"@authority": chat.example:8443`。

DNS/SRV 结果只决定连接位置，不得（MUST NOT）改变已经 pinned 的 root identity 或双向认可事实。DNS
变化后出现 identity contradiction 时必须（MUST）以 fail-closed 方式处理，不能把域名当前控制者自动视为原 peer。

### 2.3 身份恢复与传输要求（Identity Recovery and Transport Requirements）

identity contradiction 发生后，自动流程必须（MUST）保持 `halted`，不得（MUST NOT）因 DNS 再次变化而自动恢复。
DNS 已修复时，管理员可以（MAY）发起非破坏性原身份恢复。恢复时必须（MUST）重新解析连接位置，并通过
主机名验证成功的 HTTPS 重新取得发现文档（discovery document）。只有其中的 root public key 与 identity
contradiction 前的 pin 逐字节一致，且当前 signing key certificate 能由该 root
正确验证时，才可恢复原认可关系。signing key 或 certificate 集合可因正常轮换而不同，不要求与
旧缓存逐项相等。该恢复必须（MUST）保留双向认可事实、首次确认时间、cursor、mirror 与既有
authorization；root identity 不同必须（MUST）继续 fail closed。采用新 root identity 只能按
[主协议](./protocol.md)第 10 节的安全底线执行 destructive reset；具体管理流程不属于 Federation v1。

身份连续性不依赖额外的公开证明接口（proof endpoint）：接收入站请求时，由 HTTP Message Signature 证明对端
持有当前 signing private key，并由已 pinned root 对 certificate 的签名把该 key 绑定到原 Federation
identity；主动连接和读取响应时，由已验证 hostname 的 HTTPS 认证当前域名端点，well-known 中的
root 则必须（MUST）与本地 pin 一致。任一检查失败都不得（MUST NOT）开放普通 S2S operation。

Federation v1 通信必须（MUST）使用 HTTPS 并验证逻辑 peer domain 的 TLS hostname；使用明文 HTTP 的交互
不符合 Federation v1。节点采用何种 DNS resolver、IP 分类、连接器或出站网络策略属于本地实现，
不得（MUST NOT）改变 v1 的 identity 与 signature 验证语义。

## 3. 请求构造总览（Request Construction Overview）

除公开 well-known 外，发送方必须（MUST）按以下唯一顺序构造 v1 request：

1. 按 operation 规范选择 method、path template、query fields 和 body shape，并选择符合第 1.3、1.4 节的 signing key。
2. 按第 3.1 节构造最终 method、path、query 和 authority。
3. 按第 3.2 节把 body 序列化为最终 UTF-8 bytes，并计算 `Content-Digest`；无 body 时使用空 byte string。
4. 生成 `created`、`expires` 和 `Date`，再按第 3.3 节构造全部请求头。
5. 按第 3.4 节构造 `Signature-Input`、签名基串和 `Signature`。
6. 原样发送第 2–5 步确定的 request target、header values 和 body bytes；签名后不得（MUST NOT）重新
   序列化 body、改写 URI、改变 authority 或修改任何已覆盖 header。

具体 operation 决定业务字段位于 path、query 还是 body；本节只规定这些值如何转换为唯一的 HTTP 表示。

### 3.1 请求目标构造（Request Target Construction）

method 必须（MUST）与 operation 规范给出的大小写完全一致。path template 中作为结构分隔符的 `/`
必须（MUST）原样发送；每个 path variable 必须（MUST）独立进行 URI percent-encoding，不能先拼接再编码。
未保留字符 `ALPHA / DIGIT / "-" / "." / "_" / "~"` 不编码，其他 UTF-8 byte 使用大写十六进制
`%HH`；变量值中的 `/` 必须（MUST）编码为 `%2F`，空格必须（MUST）编码为 `%20`，不得（MUST NOT）编码为 `+`。

query 的 `?`、field 之间的 `&` 和 key/value 之间的 `=` 是结构字符，必须（MUST）原样发送。operation
文档按出现顺序列出固定 ASCII query key，发送方必须（MUST）使用该顺序，并对每个 value 独立应用上述
percent-encoding。不得（MUST NOT）发送 operation 未定义的空 query marker；没有 query 时 request target
不携带 `?`，但签名派生组件 `@query` 按下文固定为单个字符 `?`。

重复 query key、未知 key、缺失必选值、空值、非法 percent-encoding 或越界值均是 malformed request。
`@path` 是收到的 absolute path，不含 query。`@query` 是以 `?` 开头的原始 query；没有 query 时
固定为单个字符 `?`。验签时不得（MUST NOT）对 path 或 query 重新排序、解码再编码或规范化。

`@authority` 是按第 2.2 节构造并实际发送的 logical HTTP request authority：小写 peer domain，
非默认 HTTPS 端口必须（MUST）保留，HTTPS `443` 必须（MUST）省略。HTTP/2 和 HTTP/3 使用
`:authority`；HTTP/1.1 使用 `Host`。SRV target 不得（MUST NOT）出现在 `@authority` 中；signer identity
始终从已验证 `keyid` 得出，不从 authority 推导。

### 3.2 请求体与内容摘要（Request Body and Content Digest）

有 body 的 operation 必须（MUST）先按[主协议](./protocol.md)第 6.1 节和对应 operation 的字段顺序要求生成最终 UTF-8 bytes；
无 body 的 operation 使用长度为零的 byte string。`Content-Digest` 必须（MUST）按 RFC 9530 对这组精确
bytes 计算，固定为 `sha-256=:<base64-sha256>:`。验证完成前，发送方和接收方均不得（MUST NOT）通过
JSON 重建、重新序列化、空白整理或 Unicode/数字规范化替换这些 bytes。

`Content-Digest` 本身不认证发送方，因为任何人都能为替换后的 body 重新计算摘要。HTTP Message Signature
不直接包含 body bytes，而是覆盖 `content-digest` header：摘要把 body bytes 绑定到 header，签名再把该
header 与 method、request target、authority 和时间绑定到 signer。接收方必须（MUST）同时验证摘要和签名；
不得（MUST NOT）把其中任意一个视为另一个的替代品。

### 3.3 已签名请求头（Signed Request Headers）

除公开 well-known 外，全部 v1 request（包括 `recognize` 和 `healthy`）必须（MUST）使用以下固定 HTTP
Message Signature profile。[主协议](./protocol.md)第 3 节的鉴权上下文只改变 key resolution 和
recognition/authorization gate，不改变本节
wire format。

| Header            | 要求                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| `Content-Type`    | 有 JSON body 时 必须（MUST）为 `application/json`；无 body 时 不得（MUST NOT）发送 |
| `Accept`          | 可以（MAY）发送 `application/json`；不参与签名，不改变 v1 response shape           |
| `Date`            | 必须（MUST）发送 IMF-fixdate，表示与 `created` 相同的整秒                          |
| `Content-Digest`  | 必须（MUST）发送；按第 3.2 节对最终 body bytes 计算，无 body 时覆盖空 byte string  |
| `Signature-Input` | 必须（MUST）发送；恰好一个 label `sig1`                                            |
| `Signature`       | 必须（MUST）发送；恰好一个 label `sig1`                                            |
| `Range`           | 仅 media operation 可以（MAY）发送；单 bytes range，不参与 v1 request signature    |

header name 大小写不敏感，但签名组件名使用上表给出的小写形式。`Date`、`Content-Digest`、
`Signature-Input` 或 `Signature` 任一出现多个 field line、多个 dictionary member 或无法无歧义
解析的合并值时，接收方必须（MUST）拒绝请求。`Content-Length`、`User-Agent` 和 hop-by-hop header 不参与
v1 签名。

### 3.4 HTTP 消息签名构造（HTTP Message Signature Construction）

| 项目      | Federation v1 固定值或规则                                                                          |
| --------- | --------------------------------------------------------------------------------------------------- |
| 签名标准  | RFC 9421 wire format，单一 label `sig1`                                                             |
| 算法      | `ed25519`                                                                                           |
| 覆盖组件  | `"@method" "@path" "@query" "@authority" "date" "content-digest"`，顺序固定                         |
| `keyid`   | signer 在 well-known 发布且符合鉴权上下文的 signing key ID；第一个 `/` 前是 canonical signer domain |
| `created` | Unix epoch seconds 安全整数                                                                         |
| `expires` | Unix epoch seconds 安全整数，`created <= expires <= created + 300`                                  |
| `alg`     | 固定为 `"ed25519"`                                                                                  |

完成第 3.1、3.2 节的 request target、body bytes 和 `Content-Digest` 后，发送方必须（MUST）按以下
顺序构造时间字段和签名：

1. 设 `created = floor(nowMilliseconds / 1000)`、`expires = created + 300`，并以 `created` 表示的同一
   UTC 整秒构造 `Date`。
2. 按下列精确参数顺序构造 `Signature-Input`。
3. 使用最终 method、raw path、raw query、authority、`Date` 和 `Content-Digest` 构造 RFC 9421 签名基串。
4. 使用 `keyid` 对应的 Ed25519 signing private key 签名基串，并构造 `Signature`。

```text
sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=<seconds>;expires=<seconds>;keyid="<key-id>";alg="ed25519"
```

签名基串由 RFC 9421 构造，对应以下七行，行之间使用 `LF`，最后一行之后没有额外 `LF`：

```text
"@method": <uppercase-method>
"@path": <absolute-path-without-query>
"@query": <raw-query-with-leading-question-mark-or-question-mark-only>
"@authority": <HTTP-authority>
"date": <Date-header-value>
"content-digest": <Content-Digest-header-value>
"@signature-params": ("@method" "@path" "@query" "@authority" "date" "content-digest");created=<seconds>;expires=<seconds>;keyid="<key-id>";alg="ed25519"
```

`Signature` 的值是 `sig1=:<base64-ed25519-signature>:`。签名 base64 解码后 必须（MUST）恰好为 64 bytes。
固定、非秘密的完整样例见
[`schema/vectors/http-message-signature.json`](./schema/vectors/http-message-signature.json)。

### 3.5 验证顺序与失败边界（Verification Order and Failure Boundaries）

接收方必须（MUST）按以下安全边界验证 signed request；实现可以（MAY）合并不会改变可观察结果的内部步骤，
但不得（MUST NOT）在完成对应安全检查前执行后续业务副作用：

1. 限制 request line、header 和 body 大小，拒绝重复或无法唯一解析的安全 header。
2. 解析 `Signature-Input` 和 `Signature`，检查唯一 label、固定组件顺序、参数集合和 `alg`。
3. 从 `keyid` 提取 canonical signer domain，按[主协议](./protocol.md)第 3 节的鉴权上下文执行
   recognition/authorization gate 并选择 key；
   `recognized signed` 不得（MUST NOT）把纯传输 `degraded` 当作授权失败。
4. 检查 `created <= expires <= created + 300`、`Date` 解析后的 Unix epoch seconds 精确等于 `created`，并拒绝
   `created < now - 300`、`created > now + 60` 或 `expires < now`。
5. 用收到的原始 body bytes 验证 `Content-Digest`；该 Structured Fields dictionary 必须（MUST）恰好只含一个
   无参数 `sha-256` byte sequence。
6. 使用收到的 method、raw path、raw query、authority 和 header value 验证 Ed25519 signature。
7. 解析 JSON，验证 operation shape、Federation 共享类型、signer/body/resource binding 与业务授权。
8. 只在上述检查全部成功后执行 operation 副作用。

operation body 如果包含 `origin` 或 `{ account, domain }` 形式的 `from`，该 domain 必须（MUST）等于
signer domain。不携带这些字段的 operation 直接使用 signer domain 作为发送 server identity。

Header/profile 解析错误、digest 不匹配和 signature 不匹配不得（MUST NOT）降级为业务拒绝。具体 HTTP status、
stable code 和 caller action 由错误码注册表定义。

`healthy` 是状态查询 operation。request line、JSON 或签名结构无法解析时可以（MAY）返回通用 malformed
error；结构可解析时，peer 未知、身份无法由已有 pin 验证、binding/权限失败或本地状态不可公开都属于该
operation 的正常查询结果，必须（MUST）按 recognition.md 返回 HTTP `200` 的 `unavailable`，且不得
（MUST NOT）执行任何副作用。

Federation v1 不对普通 JSON response 再加 HTTP Message Signature；response 来源和完整性由已验证
hostname 的 TLS 连接提供。media operation 另行定义的 response digest 规则不受此句影响。

### 3.6 完整已签名请求示例（Complete Signed Request Example）

以下固定示例使用公开测试 public key
`A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=`，不得（MUST NOT）将对应测试 private key 用于生产：

```http
POST /s2s/v1/feed-heads HTTP/1.1
Host: b.example
Content-Type: application/json
Date: Tue, 14 Nov 2023 22:13:20 GMT
Content-Digest: sha-256=:jyei18yIj1UN70jxngwvAzEHm+S2VRlxbpRtAv4Wp3k=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:YB4YJhZ8Gx8fq4WI2wOszIppKsOZzrmiFMTcPoQqcS0Y9A/x0jPmwO4JrO+gAf17L01xosGsj4ppscoHdHPRAw==:

{"origin":"a.example","stateFeedEndId":"12","messageFeedEndId":"34","tombstoneFeedEndId":"9"}
```

body 最后一行的精确 UTF-8 bytes 同时用于 `Content-Digest` 和签名；示例排版中的末尾换行不属于 body。
`Host` 产生签名组件 `"@authority": b.example`，该 request 无 query，因此签名组件为
`"@query": ?`。完整签名基串及非秘密 private test key 见
[`schema/vectors/http-message-signature.json`](./schema/vectors/http-message-signature.json)。Recognize 和
Healthy 的 certificate、request、response 与签名基串完整示例见
[Federation v1 服务器认可](./recognition.md#10-完整-http-构造示例complete-http-construction-examples)。
