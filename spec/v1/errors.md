# SOMS Federation v1 错误码注册表

状态：`RELEASE CANDIDATE`（`v1.0-rc.1`）
规范性：本文分别定义 S2S HTTP 失败分类、HTTP `200` 业务结果、稳定 `code`、结构化 `data` 和调用方动作。

## 错误封装（Error Envelope）

除 `healthy` 的隐私状态结果和原始媒体响应（raw media response）外，S2S JSON operation 的非零结果
必须（MUST）使用：

```ts
interface FederationError<T = null> {
  code: number;
  message: string;
  data?: T | null;
}
```

`code` 必须（MUST）是下表中的非零 JSON 安全整数。`message` 必须（MUST）是 string，只供人类诊断；
consumer 不得（MUST NOT）解析其文本决定行为。`data` 的存在性和 shape 由本文件“结构化错误数据”一节
定义。未知顶层字段必须（MUST）被忽略，且不得（MUST NOT）改变错误分类、调用方动作、identity 或 cursor
语义。JSON 重复 member、编码和基础类型仍按 protocol.md 的公共 JSON 规则拒绝。

JSON response 必须（MUST）使用 `Content-Type: application/json`。HTTP status 只表达请求是否进入业务层以及
peer 关系能否继续；业务结果只由 `code` 表达，不借用 HTTP error status。发送方必须（MUST）使用下文规定的组合。

## HTTP 层（HTTP Layer）

Federation v1 JSON 接口只定义以下非成功 HTTP status：

|  HTTP | 层级语义                                             | Peer lifecycle                                                 |
| ----: | ---------------------------------------------------- | -------------------------------------------------------------- |
| `400` | HTTP、JSON 或协议结构无法进入业务处理                | 不改变                                                         |
| `401` | 请求认证、签名、certificate 或 identity binding 失败 | 不直接改变                                                     |
| `409` | 已认证的 federation 关系存在注册的不可自动恢复冲突   | 合法 fatal code 才进入 `halted`                                |
| `503` | 目标 peer 暂时无法提供 federation 服务               | 已建立 peer 进入 `degraded`；握手中的 peer 保持 `establishing` |

正常成功和所有普通业务结果都使用 HTTP `200`。业务结果包括资源不存在、权限或能力拒绝、配额耗尽、payload
业务上限、cursor 冲突和并发冲突；这些结果不得（MUST NOT）改变 peer lifecycle。网络失败、timeout 和
Healthy 的 `200 unavailable` 与 HTTP `503` 具有相同的可用性降级效果。

Raw media response 的 `206`、`416` 及相关 header 属于 HTTP Range 机制，是上述 JSON status 集合的明确例外。

通用、无结构化恢复数据的完整错误示例是：

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"code":50007,"message":"request body is malformed","data":null}
```

对于不携带结构化恢复数据的 code，`data` 也可以（MAY）省略。consumer 必须（MUST）按 `code` 而不是
`message` 识别错误。

consumer 收到 status/code 冲突时必须（MUST）拒绝响应 `data` 和业务副作用，不得（MUST NOT）用 code 把
`200` 业务结果提升为 HTTP lifecycle 信号，也不得（MUST NOT）仅因冲突响应删除 pin、cursor 或已经提交的
认可事实。

HTTP `200` 中的未知非零 code 必须（MUST）视为当前 operation 的业务失败，不得（MUST NOT）接受 `data`、
提交业务副作用或推进 cursor。非 `200` response 中的未知 code 或 status/code 冲突不得提供细类语义；consumer
只按 HTTP 大类处理：`503` 仍触发可用性降级，`400`/`401` 仍只拒绝当前请求，`409` 未携带已注册 fatal code
时不得触发 `halted`。未知 code 不得触发 identity replacement、destructive reset 或永久授权变更。

### 对等节点生命周期映射（Peer Lifecycle Mapping）

peer lifecycle 动作必须（MUST）同时由响应来源、HTTP status 和必要时的 stable code 决定：

| 类别             | Wire 特征                                                                                          | Peer lifecycle 动作                                          |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 硬停止           | hostname-verified 目标 peer/authority 返回 HTTP `409`，且 envelope 是本注册表明确列出的 fatal code | 记录精确 code 和证据，进入 `halted`，停止自动通信            |
| 可重试可用性失败 | timeout、断连、HTTP `503` 或 Healthy 的有效 `unavailable`                                          | 已建立 peer 进入 `degraded`；握手未完成则保持 `establishing` |
| 当前请求失败     | HTTP `400`、`401`，或 HTTP `200` 非零业务 code                                                     | 按 code 修正或处理当前 operation；不直接改变 peer lifecycle  |

HTTP `409` 本身不足以触发 `halted`。只有 `FEDERATION_PEER_BLOCKED`、
`FEDERATION_IDENTITY_MISMATCH` 或 `FEDERATION_PROTOCOL_VERSION_UNSUPPORTED` 与 HTTP `409` 的组合才是 peer
关系硬停止。status/code 冲突、未知 code 或无法证明来源为目标 peer 的响应都不得（MUST NOT）触发 `halted`。

## 稳定错误码注册表（Stable Code Registry）

|  code | 名称                                               | HTTP | 调用方动作                                                                                                                         |
| ----: | -------------------------------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------- |
| 10000 | `VALIDATION_FAILED`                                |  200 | 修正业务请求；不得（MUST NOT）原样重试。                                                                                           |
| 10001 | `NOT_FOUND`                                        |  200 | 当前资源不存在；仅在业务状态改变后重试。                                                                                           |
| 10004 | `FORBIDDEN`                                        |  200 | 当前业务身份无权访问资源；不得（MUST NOT）原样重试。                                                                               |
| 10005 | `RATE_LIMITED`                                     |  503 | 对端临时限流；按本地有上限、带 jitter 的退避策略重试。                                                                             |
| 10999 | `INTERNAL`                                         |  503 | 保留 pin 和 cursor，退避重试。                                                                                                     |
| 50001 | `FEDERATION_RECOGNITION_REQUIRED`                  |  401 | 缺少 operation 所需的 pinned identity 或双向认可事实；停止数据面请求并补齐缺失认可。纯传输 `degraded` 不得（MUST NOT）产生此错误。 |
| 50002 | `FEDERATION_BAD_SIGNATURE`                         |  401 | 停止原样重试并审计 signature、digest、keyId 或 certificate；不得（MUST NOT）接受响应数据。                                         |
| 50003 | `FEDERATION_BINDING_VIOLATION`                     |  401 | 修正 signer/body/address binding；不得（MUST NOT）原样重试。                                                                       |
| 50007 | `FEDERATION_MALFORMED`                             |  400 | 修正 JSON/header profile、基础类型、时间参数、query、media type 或 content coding；不得（MUST NOT）原样重试。                      |
| 50009 | `FEDERATION_PEER_BLOCKED`                          |  409 | Fatal：记录 remote-blocked 原因并进入 `halted`，停止自动通信。                                                                     |
| 50010 | `FEDERATION_GROUP_AUTHOR_LEFT`                     |  200 | 该 author 路径已终止；停止此 stream，不影响其他 stream。                                                                           |
| 50011 | `FEDERATION_QUOTA_EXCEEDED`                        |  200 | 按 `data.retryAfter` 秒数退避；不得（MUST NOT）把 peer 置为 degraded 或推进失败 page cursor。                                      |
| 50012 | `FEDERATION_PAYLOAD_TOO_LARGE`                     |  200 | 已解析 item 超出 operation limit；仅在 operation 允许拆分或缩小请求时重构后重试。                                                  |
| 50013 | `FEDERATION_CAPABILITY_DISABLED`                   |  200 | 对端策略禁用该业务类别；停止自动重试，等待配置变化。                                                                               |
| 50014 | `FEDERATION_LOCAL_IDENTITY_LOST`                   |  503 | 对端暂时无法安全提供 federation 服务；保留原 pin 并退避重试。                                                                      |
| 50015 | `FEDERATION_IDENTITY_MISMATCH`                     |  409 | Fatal：保留原 pin，记录 identity contradiction 并进入 `halted`；不得（MUST NOT）自动采用新身份。                                   |
| 50019 | `FEDERATION_FEED_CURSOR_UNAVAILABLE`               |  200 | 不应用 page；验证并原子保存 `data.resumeAfter`。用于 bootstrap、明显越界 cursor，以及 message query 已清理正文。                   |
| 50020 | `FEDERATION_PROTOCOL_VERSION_UNSUPPORTED`          |  409 | Fatal：记录版本原因并进入 `halted`；不得（MUST NOT）透明降级。                                                                     |
| 50021 | `FEDERATION_RANGE_NOT_SATISFIABLE`                 |  416 | 当前单 Range 不可满足；按 media 规则读取 `Content-Range`，不得（MUST NOT）把资源解释为不存在。                                     |
| 50023 | `FEDERATION_PROFILE_NOT_DISCLOSED`                 |  200 | 用户选择不向当前 peer 展示公开资料；停止原样重试。publisher 可改用 `NOT_FOUND` 隐藏账号是否存在。                                  |
| 50024 | `FEDERATION_MESSAGE_QUERY_RATE_LIMITED`            |  200 | Message query 请求过频；不推进 query cursor，至少等待 `data.retryAfter` 秒后带 jitter 重试，不改变 peer lifecycle。                |
| 50025 | `FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE` |  200 | Message query 暂时不能产生一致 page；不推进 query cursor，至少等待 `data.retryAfter` 秒后带 jitter 重试，不改变 peer lifecycle。   |
| 70001 | `CALL_NOT_ALLOWED`                                 |  200 | 未知 callSid，或隐私合并后的账号、关系、block、租户及呼叫准入失败；终止本次呼叫，不得（MUST NOT）把 peer 置为 degraded。           |
| 70004 | `CALL_BUSY`                                        |  200 | 对端参与者正忙；终止或稍后使用新 `callSid` 发起，不得（MUST NOT）重放同一 incoming frame。                                         |
| 70007 | `CALL_CANCELLED`                                   |  200 | 通话已由 caller 取消；本地收敛为 cancelled，停止媒体、计时器和依赖 frame，不得（MUST NOT）把 peer 置为 degraded。                  |
| 70008 | `CALL_TERMINATED`                                  |  200 | 通话已由其他终态结束；本地收敛为 terminal，停止媒体、计时器和依赖 frame，不得（MUST NOT）把 peer 置为 degraded。                   |

`FEDERATION_CAPABILITY_DISABLED` 是为兼容已发布 wire code 保留的稳定标识符；这里的 `capability` 只表示某类业务
操作被对端策略关闭，不表示 v1 存在能力协商（capability negotiation），也不能据此推导可选接口。

## 结构化错误数据（Structured Error Data）

除本节明确列出的 code 外，`data` 必须（MUST）省略或为 JSON `null`。下面的 object 都是 closed object，未知字段、
缺失字段、`null`、错误类型和非安全整数均必须（MUST）视为错误响应 malformed；consumer 不得（MUST NOT）
采用其中数据。

```ts
interface FederationQuotaExceededData {
  // 非负整数 delta-seconds；从完整接收响应时开始计算。
  retryAfter: SafeInteger;
}

interface FederationCapabilityDisabledData {
  category: 'messages' | 'files' | 'requests' | 'signals';
}

interface FederationFeedCursorUnavailableData {
  // 下一次请求必须原样用作 exclusive `after`。
  resumeAfter: DecimalString;
}

interface FederationQueryRetryData {
  // 从完整收到响应时开始计算的非负整数秒。
  retryAfter: SafeInteger;
}
```

`FEDERATION_QUOTA_EXCEEDED` 必须（MUST）携带 `FederationQuotaExceededData`，其中
`retryAfter >= 0`。operation 本身定义受限的业务类型；响应不得携带 category、limit、计量单位、窗口或
服务端策略参数。实现可以把具体配额原因写入仅供诊断的 `message`，consumer 不得解析该文本决定行为。
`FEDERATION_CAPABILITY_DISABLED` 必须（MUST）携带
`FederationCapabilityDisabledData`。
`FEDERATION_FEED_CURSOR_UNAVAILABLE` 必须（MUST）携带
`FederationFeedCursorUnavailableData`。省略 `after` 时，`resumeAfter` 必须是该 operation 当前有效的
exclusive 起点；所有 operation 的起点都必须非负。携带 `after` 时有且只有两种可采用的修正：旧 message
正文已清理时 `resumeAfter > after`；请求位置
明显大于当前 operation end 时 `resumeAfter < after`。相等值无进展，必须拒绝。三个压缩 feed 不得因历史
删除或压缩使用该结果；tombstone query 不得以清理为由跳过永久删除事实。

`FEDERATION_MESSAGE_QUERY_RATE_LIMITED` 和
`FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE` 必须（MUST）携带
`FederationQueryRetryData`，且只能由 `GET /s2s/v1/messages` 使用。两者都是已经通过 HTTP 与身份认证后的
业务暂缓，不得用于掩盖 signature、binding、授权或 malformed 错误，也不得用于 tombstone query、三个 feed
或整个 federation 服务不可用。它们不使用 HTTP `Retry-After` header。

完整 wire 示例：

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"code":50011,"message":"message query quota exceeded","data":{"retryAfter":60}}
```

该业务结果只承诺当前 operation 至少等待 `60` 秒后可以重试；它不公开配额阈值、单位、窗口或算法。
下例是 message query
中请求正文已清理区间的有效修正：

```json
{
  "code": 50019,
  "message": "requested message history is no longer retained",
  "data": { "resumeAfter": "120" }
}
```

上例是有效的正文保留 floor 响应。下面是对应的无效反例：

```json
{
  "code": 50019,
  "message": "requested message history is no longer retained",
  "data": { "resumeAfter": "100" }
}
```

假设 query `after=100` 且该位置并未超过 source 当前 end，反例的 `resumeAfter` 没有严格前进；consumer
必须（MUST）拒绝采用它。若请求本身明显超过当前 end，则 source 返回严格更小的有效位置属于另一种
越界修正，不适用本例。

Federation v1 的业务配额只使用 `data.retryAfter`，不得（MUST NOT）为它发送 HTTP `Retry-After`，以免把业务
结果误解成 HTTP 可用性失败。该值 malformed 时 consumer 必须（MUST）忽略它并使用本地有上限、带 jitter 的退避。

## 共享验证失败映射（Shared Validation Failure Mapping）

除 operation 文档明确给出更严格映射外，signed request 的公共 HTTP 验证管线必须（MUST）按下表处理。
本表只消除多个 code 之间容易产生歧义的公共验证失败，不重复 lifecycle、discovery 或 operation 业务错误。
这些条件不得（MUST NOT）映射为其他 4xx。

| 条件                                                                       | HTTP / code                              |
| -------------------------------------------------------------------------- | ---------------------------------------- |
| JSON/header/query/path shape、重复安全 header、签名 profile 或时间参数非法 | `400 FEDERATION_MALFORMED`               |
| `Content-Type`、content coding 或字符编码不符合 v1                         | `400 FEDERATION_MALFORMED`               |
| request/header/body 在解析前已超过公开的 HTTP/JSON 上限                    | `400 FEDERATION_MALFORMED`               |
| Content-Digest 不匹配、Ed25519 验证失败、keyId 未授权或 certificate 无效   | `401 FEDERATION_BAD_SIGNATURE`           |
| signer 与 body、address、resource identity 不绑定                          | `401 FEDERATION_BINDING_VIOLATION`       |
| pinned identity 或双向认可事实不足，但不存在 identity contradiction        | `401 FEDERATION_RECOGNITION_REQUIRED`    |
| 纯传输 `degraded`，其余 recognition/identity/authorization 均有效          | 继续处理；不得（MUST NOT）仅因此返回错误 |

Block、identity contradiction、协议版本、local identity、业务 quota 和 server failure 的映射
直接使用上方错误码主表及对应 operation 文档，不在本表重复。

`media` 的不可满足 Range 使用 HTTP `416` 和 `FEDERATION_RANGE_NOT_SATISFIABLE`，`data` 为 `null`，
并按 media operation 要求发送 `Content-Range: bytes */<current-length>`；这不表示资源本身不存在。
[资源接口第 3.3 节](./resources.md#33-媒体错误)进一步区分 audience/message proof 不足的 `FORBIDDEN`、
digest binding 或 CAS blob 不存在的 `NOT_FOUND`、不可满足 Range 与临时存储故障。前三者不得（MUST NOT）
使 peer degraded；只有注册的 HTTP `503` 可用性失败触发该 lifecycle 动作。

media 的 HTTP `200` 可能是 `application/octet-stream` 完整资源成功，也可能是 `application/json` 非零业务
error envelope。consumer 必须（MUST）同时按请求是否携带 Range、HTTP status、`Content-Type` 与 envelope
判别，不得（MUST NOT）把 JSON error bytes 写入 CAS。response header 已发送后发生的 stream failure 不再
具有可发送 JSON error 的边界；publisher 必须终止 stream，consumer 必须丢弃不完整 range 并通过长度与
digest 校验发现失败。

资源 `NOT_FOUND` 对应的 mirror message 如何展示、保留或标记属于 consumer 本地策略；它本身不是 message
删除或 tombstone。具体边界见 resources.md 第 3.3、4.4 节。

未列出的 SOMS 本地客户端业务码不属于 Federation v1 wire registry，S2S publisher 不得（MUST NOT）把它们
作为协议错误发送。增加新的稳定错误语义属于 additive v1 修订；改变已有 code 的含义、重试性或 identity
action 属于不兼容变化。

`POST /s2s/v1/healthy` 是状态查询 operation。对可解析请求的未知 peer、未被本方认可、无权限、binding
或已有 identity 验证失败，`unavailable` 是 recognition.md 定义的正常查询结果，不属于本注册表的 error。
通用 malformed HTTP/JSON 使用 `400 FEDERATION_MALFORMED`；独立于 peer 是否存在的临时限流和 server failure
统一使用 HTTP `503`，并分别使用 `RATE_LIMITED` 或 `INTERNAL` 提供诊断细类。
