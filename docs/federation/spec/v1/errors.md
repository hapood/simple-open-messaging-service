# Federation v1 错误码注册表

状态：`REVIEW`
规范性：本文定义 S2S JSON error envelope 中可互操作的稳定 `code`、精确 HTTP status、结构化 `data` 和
caller action。

## Error envelope

除 `healthy` 的隐私状态结果和 raw media response 外，所有非成功 S2S JSON response 必须（MUST）使用：

```ts
interface FederationError<T = null> {
  code: number;
  message: string;
  data?: T | null;
}
```

`code` 必须（MUST）是下表中的非零 JSON 安全整数。`message` 必须（MUST）是 string，只供人类诊断；
consumer 不得（MUST NOT）解析其文本决定行为。`data` 的存在性和 shape 由本文件“结构化错误数据”一节
定义。未知顶层字段必须（MUST）被忽略，且不得（MUST NOT）改变错误分类、caller action、identity 或 cursor
语义。JSON 重复 member、编码和基础类型仍按 protocol.md 的公共 JSON 规则拒绝。

JSON error response 必须（MUST）使用 `Content-Type: application/json`。业务结果可以（MAY）使用 HTTP
`200` 配合下表明确允许的非零 code；protocol、security、malformed、quota、identity 和 liveness 错误必须
（MUST）使用下表的精确 HTTP status。HTTP status 给出大类，`code` 给出稳定细类；发送方必须（MUST）使用
下表规定的组合。

通用、无结构化恢复数据的完整错误示例是：

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"code":50007,"message":"request body is malformed","data":null}
```

对于不携带结构化恢复数据的 code，`data` 也可以（MAY）省略。consumer 必须（MUST）按 `code` 而不是
`message` 识别错误。

consumer 收到冲突组合时必须（MUST）先拒绝响应 `data` 和业务副作用，再按以下从高到低的动作优先级处理：
identity contradiction/lost；明确 block 或 authorization 拒绝；永久 malformed/binding/payload 拒绝；可重试
rate/quota；可重试 server failure；HTTP `200` 业务结果。较低优先级不得（MUST NOT）覆盖较高优先级，也不得
（MUST NOT）仅因冲突响应删除 pin、cursor 或已经提交的认可事实。未知非零 code 按本节定义处理。

未知非零 code 必须（MUST）视为当前 operation 失败，不得（MUST NOT）接受 `data`、提交业务副作用或推进
cursor。只有收到的 HTTP status 明确属于可重试类别时才可以（MAY）退避重试；未知 code 不得（MUST NOT）
单独触发 identity replacement、destructive reset 或永久授权变更。

|  code | 名称                                      | HTTP | Caller action                                                                                                                        |
| ----: | ----------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------ |
| 10000 | `VALIDATION_FAILED`                       |  400 | 修正非 Federation 专用的业务请求；不得（MUST NOT）原样重试。                                                                         |
| 10001 | `NOT_FOUND`                               |  404 | 当前非隐私合并资源不存在；仅在业务状态改变后重试。                                                                                    |
| 10004 | `FORBIDDEN`                               |  403 | 当前身份无权访问非隐私合并资源；不得（MUST NOT）原样重试。                                                                            |
| 10005 | `RATE_LIMITED`                            |  429 | 按 `Retry-After` 或退避重试；不得（MUST NOT）进入 identity-loss。                                                                     |
| 10999 | `INTERNAL`                                |  500 | 保留 pin 和 cursor，退避重试。                                                                                                       |
| 50001 | `FEDERATION_RECOGNITION_REQUIRED`         |  401 | 缺少 operation 所需的 pinned identity 或双向认可事实；停止数据面请求并补齐缺失认可。纯传输 `degraded` 不得（MUST NOT）产生此错误。    |
| 50002 | `FEDERATION_BAD_SIGNATURE`                |  401 | 停止原样重试并审计 signature、digest、keyId 或 certificate；不得（MUST NOT）接受响应数据。                                            |
| 50003 | `FEDERATION_BINDING_VIOLATION`            |  401 | 修正 signer/body/address binding；不得（MUST NOT）原样重试。                                                                          |
| 50006 | `FEDERATION_KEY_FETCH_FAILED`             |  503 | 保留原 pin 和 cursor，退避重试。                                                                                                     |
| 50007 | `FEDERATION_MALFORMED`                    |  400 | 修正 JSON/header profile、基础类型、时间参数、query、media type 或 content coding；不得（MUST NOT）原样重试。                         |
| 50009 | `FEDERATION_PEER_BLOCKED`                 |  403 | 进入 remote-blocked/`blocked`，停止自动业务流量，等待对端管理员改变策略。                                                             |
| 50010 | `FEDERATION_GROUP_AUTHOR_LEFT`            |  410 | 该 author 路径已终止；停止此 stream，不影响其他 stream。                                                                             |
| 50011 | `FEDERATION_QUOTA_EXCEEDED`               |  429 | 按 `data.retryAfter` 秒数退避；不得（MUST NOT）把 peer 置为 degraded 或推进失败 page cursor。                                         |
| 50012 | `FEDERATION_PAYLOAD_TOO_LARGE`            |  413 | 当前请求或 item 超出 operation limit；不得（MUST NOT）原样重试。仅在 operation 允许拆分或缩小请求时重构后重试。                      |
| 50013 | `FEDERATION_CAPABILITY_DISABLED`          |  403 | 对端策略禁用该类别；停止自动重试，等待配置变化。                                                                                     |
| 50014 | `FEDERATION_LOCAL_IDENTITY_LOST`          |  503 | 对端 S2S 身份材料不可用；保留原 pin，等待对端管理员恢复。                                                                             |
| 50015 | `FEDERATION_IDENTITY_MISMATCH`            |  409 | 立即 fail closed 为 `identity_lost`；不得（MUST NOT）自动采用新身份。                                                                 |
| 50016 | `FEDERATION_PEER_IDENTITY_LOST`           |  423 | 停止自动流量；等待管理员验证原 pin 恢复或执行 destructive reset。                                                                    |
| 50018 | `FEDERATION_MISSED_CONCURRENT`            |  409 | 保持 cursor，短暂退避后从同一 `after` 重试。                                                                                         |
| 50019 | `FEDERATION_MISSED_CURSOR_INVALID`        |  409 | 不应用 page；验证新 floor 后原子采用 `data.availableCursor`，再从该 cursor 继续。                                                     |
| 50020 | `FEDERATION_PROTOCOL_VERSION_UNSUPPORTED` |  400 | 刷新 well-known 并重新选择共同主版本；不得（MUST NOT）透明降级。                                                                     |
| 50021 | `FEDERATION_RANGE_NOT_SATISFIABLE`        |  416 | 当前单 Range 不可满足；按 media 规则读取 `Content-Range`，不得（MUST NOT）把资源解释为不存在。                                      |
| 70001 | `CALL_NOT_ALLOWED`                        |  200 | 未知 callSid，或隐私合并后的账号、关系、block、租户及呼叫准入失败；终止本次呼叫，不得（MUST NOT）把 peer 置为 degraded。             |
| 70004 | `CALL_BUSY`                               |  200 | 对端参与者正忙；终止或稍后使用新 `callSid` 发起，不得（MUST NOT）重放同一 incoming frame。                                           |
| 70007 | `CALL_CANCELLED`                          |  200 | 通话已由 caller 取消；本地收敛为 cancelled，停止媒体、计时器和依赖 frame，不得（MUST NOT）把 peer 置为 degraded。                    |
| 70008 | `CALL_TERMINATED`                         |  200 | 通话已由其他终态结束；本地收敛为 terminal，停止媒体、计时器和依赖 frame，不得（MUST NOT）把 peer 置为 degraded。                     |

## 结构化错误数据

除本节明确列出的 code 外，`data` 必须（MUST）省略或为 JSON `null`。下面的 object 都是 closed object，未知字段、
缺失字段、`null`、错误类型和非安全整数均必须（MUST）视为错误响应 malformed；consumer 不得（MUST NOT）
采用其中数据。

```ts
interface FederationQuotaExceededData {
  // 非负整数 delta-seconds；从完整接收响应时开始计算。
  retryAfter: SafeInteger;
}

interface FederationMissedCursorInvalidData {
  // 均为 protocol.md DecimalString，按任意精度非负十进制整数比较。
  startChangeId: DecimalString;
  availableCursor: DecimalString;
  allocatedThrough: DecimalString;
}
```

`FEDERATION_QUOTA_EXCEEDED` 必须（MUST）携带 `FederationQuotaExceededData`。
`FEDERATION_MISSED_CURSOR_INVALID` 必须（MUST）携带 `FederationMissedCursorInvalidData`，并满足
`startChangeId <= availableCursor <= allocatedThrough`。consumer 还必须（MUST）验证新的 floor 相对本地已知
floor 单调前进；任一检查失败都不得（MUST NOT）推进 cursor。

完整 wire 示例：

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 30

{"code":50011,"message":"peer quota exceeded","data":{"retryAfter":60}}
```

该响应的有效退避是 `60` 秒。Cursor 截断示例是：

```json
{
  "code": 50019,
  "message": "requested cursor is below retained floor",
  "data": {
    "startChangeId": "101",
    "availableCursor": "120",
    "allocatedThrough": "250"
  }
}
```

上例是有效响应。下面是对应的无效反例：

```json
{
  "code": 50019,
  "message": "requested cursor is below retained floor",
  "data": {
    "startChangeId": "101",
    "availableCursor": "100",
    "allocatedThrough": "250"
  }
}
```

反例不满足 `startChangeId <= availableCursor`；consumer 必须（MUST）拒绝采用它。该反例用于防止实现只
检查字段类型而遗漏跨字段不变量。

HTTP `Retry-After` 在 Federation v1 中只接受 protocol.md 定义的非负十进制 delta-seconds。响应同时携带
`Retry-After` 和 `data.retryAfter` 时，consumer 必须（MUST）使用两者中较大的有效值；任一值 malformed 时
不得（MUST NOT）采用较短值，应使用本地有上限、带 jitter 的退避。

## 共享验证失败映射

除 operation 文档明确给出更严格映射外，signed request 的公共 HTTP 验证管线必须（MUST）按下表处理。
本表只消除多个 code 之间容易产生歧义的公共验证失败，不重复 lifecycle、discovery 或 operation 业务错误。
实现不能根据框架默认行为把这些条件改成其他 4xx。

| 条件                                                                 | HTTP / code                                      |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| JSON/header/query/path shape、重复安全 header、签名 profile 或时间参数非法 | `400 FEDERATION_MALFORMED`                       |
| `Content-Type`、content coding 或字符编码不符合 v1                    | `400 FEDERATION_MALFORMED`                       |
| request/header/body 超过 operation 或本地公开上限                     | `413 FEDERATION_PAYLOAD_TOO_LARGE`               |
| Content-Digest 不匹配、Ed25519 验证失败、keyId 未授权或 certificate 无效 | `401 FEDERATION_BAD_SIGNATURE`                   |
| signer 与 body、address、resource identity 不绑定                     | `401 FEDERATION_BINDING_VIOLATION`               |
| pinned identity 或双向认可事实不足，但不存在 identity contradiction   | `401 FEDERATION_RECOGNITION_REQUIRED`            |
| 纯传输 `degraded`，其余 recognition/identity/authorization 均有效     | 继续处理；不得（MUST NOT）仅因此返回错误          |

Block、identity contradiction/lost、协议版本、key fetch、local identity、rate/quota 和 server failure 的映射
直接使用上方错误码主表及对应 operation 文档，不在本表重复。

`media` 的不可满足 Range 使用 HTTP `416` 和 `FEDERATION_RANGE_NOT_SATISFIABLE`，`data` 为 `null`，
并按 media operation 要求发送 `Content-Range: bytes */<current-length>`；这不表示资源本身不存在。

未列出的 SOMS 本地客户端业务码不属于 Federation v1 wire registry，S2S publisher 不得（MUST NOT）把它们
作为协议错误发送。增加新的稳定错误语义属于 additive v1 修订；改变已有 code 的含义、重试性或 identity
action 属于不兼容变化。

`POST /s2s/v1/healthy` 是状态查询 operation。对可解析请求的未知 peer、未被本方认可、无权限、binding
或已有 identity 验证失败，`unavailable` 是 recognition.md 定义的正常查询结果，不属于本注册表的 error。
通用 malformed HTTP/JSON、独立于 peer 是否存在的限流和临时 server failure 仍可以（MAY）分别使用
`FEDERATION_MALFORMED`、`RATE_LIMITED` 和 `INTERNAL`。
