# Federation v1 错误码注册表

状态：`FINAL`
规范性：本文定义 S2S JSON error envelope 中可互操作的稳定 `code` 与 caller action。

错误响应使用 `{ "code": integer, "message": string, "data"?: unknown }`。`message` 只供诊断，
consumer MUST NOT 解析其文本决定行为。HTTP status 给出大类，`code` 给出稳定细类；二者冲突时按
更安全的动作处理，不得把 identity/security 错误降级成普通业务拒绝。

| code  | 名称                                | 通常 HTTP | Caller action |
| ----: | ----------------------------------- | --------: | ------------- |
| 10000 | `VALIDATION_FAILED`                 |       400 | 修正请求；不得原样重试。 |
| 10001 | `NOT_FOUND`                         |       404 | 当前资源不存在；仅在业务状态改变后重试。 |
| 10004 | `FORBIDDEN`                         |       403 | 当前身份无权访问；不得原样重试。 |
| 10005 | `RATE_LIMITED`                      |       429 | 按 `Retry-After` 或退避重试；不得 identity-loss。 |
| 10999 | `INTERNAL`                          |       500 | 保留 cursor，退避重试。 |
| 50001 | `FEDERATION_PEER_NOT_TRUSTED`       |       401 | 停止该请求；不能通过普通重试建立 trust。 |
| 50002 | `FEDERATION_BAD_SIGNATURE`          |       401 | 停止原样重试并审计签名/keyId；不得接受响应数据。 |
| 50003 | `FEDERATION_BINDING_VIOLATION`      |       401 | 修正 signer/body/address binding；不得原样重试。 |
| 50006 | `FEDERATION_KEY_FETCH_FAILED`       |       503 | 保留原 pin 和 cursor，退避重试。 |
| 50007 | `FEDERATION_MALFORMED`              |       400 | 修正 shape、scalar、signature input 或 query；不得原样重试。 |
| 50009 | `FEDERATION_PEER_BLOCKED`           |       403 | 停止自动重试，等待对端管理员改变策略。 |
| 50010 | `FEDERATION_GROUP_AUTHOR_LEFT`      |       410 | 该 author 路径已终止；停止此 stream，不影响其他 stream。 |
| 50011 | `FEDERATION_QUOTA_EXCEEDED`         |       429 | 按 `data.retryAfter`/退避重试；不得 demote 或推进失败 page cursor。 |
| 50012 | `FEDERATION_PAYLOAD_TOO_LARGE`      |       413 | 当前 item 永久失败；不得重复传输相同 payload。 |
| 50013 | `FEDERATION_CAPABILITY_DISABLED`    |       403 | 对端策略禁用该类别；停止自动重试，等待配置变化。 |
| 50014 | `FEDERATION_LOCAL_IDENTITY_LOST`    |       503 | 对端 S2S 身份不可用；保留原 pin，等待对端管理员恢复。 |
| 50015 | `FEDERATION_IDENTITY_MISMATCH`      |       409 | 立即 fail closed 为 identity-loss；禁止自动采用新身份。 |
| 50016 | `FEDERATION_PEER_IDENTITY_LOST`     |       423 | 停止自动流量；等待管理员原 pin 恢复或 destructive reset。 |
| 50017 | `FEDERATION_IDENTITY_PROOF_INVALID` |       401 | 丢弃 proof；不得用其恢复 trust，修正后重新开始 nonce 流程。 |
| 50018 | `FEDERATION_MISSED_CONCURRENT`      |       409 | 保持 cursor，短暂退避后从同一 `after` 重试。 |
| 50019 | `FEDERATION_MISSED_CURSOR_INVALID`  |       409 | 不应用 page；验证 `startChangeId <= availableCursor <= allocatedThrough` 且 floor 单调前进后，原子采用 `data.availableCursor` 继续。 |
| 70001 | `CALL_NOT_ALLOWED`                  |       200 | 当前参与者关系不允许该 call frame；终止本次呼叫，不得 demote peer。 |
| 70004 | `CALL_BUSY`                         |       422 | 对端参与者正忙；终止或稍后发起新呼叫，不得重放同一 incoming frame。 |

未列出的 SOMS 本地客户端业务码不属于 Federation v1 wire registry，S2S publisher MUST NOT 把它们
作为协议错误发送。增加新的稳定错误语义属于 additive v1 修订；改变已有 code 的含义、重试性或
identity action 属于不兼容变化。
