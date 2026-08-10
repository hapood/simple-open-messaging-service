# SOMS Federation Protocol v1

状态：`FINAL`
协议标识：`1`
S2S API 前缀：`/s2s/v1`

本文是 Federation v1 的规范性正文。SOMS 的数据库字段、worker、队列、配置和本地产品限制见
实现参考，不构成本协议要求。

规范词 `MUST`、`MUST NOT`、`SHOULD`、`SHOULD NOT` 和 `MAY` 按 RFC 2119/RFC 8174
解释。

## 1. 范围、角色与术语

- **server/domain**：以 DNS domain 标识、运行 Federation v1 的服务器。
- **peer**：本服务器已经建立或正在建立 identity trust edge 的另一 server。
- **origin**：某个群身份及其 roster 的权威 server；不是每条消息作者的同义词。
- **mirror**：非 origin server 保存的群副本。
- **publisher/consumer**：分别提供 feed/resource 与拉取、验证、提交它们的 server。
- **durable fact/change**：与业务事务一起提交、可在提示丢失后重新拉取的状态或消息发现记录。
- **revision hint**：只负责唤醒 consumer 的非持久、可丢失通知。
- **cursor**：consumer 已安全提交的 source revision；不能因提示或失败响应提前推进。
- **reset**：管理员授权的 destructive identity lifecycle；普通断线或 DNS 变化不属于 reset。

## 2. 版本与兼容性

本节已定稿。

Federation v1 的所有 S2S 数据面端点都位于 `/s2s/v1/*`。公开发现端点固定为
`/.well-known/soms`，因为调用方在读取发现文档前不能依赖 API 前缀。

`/.well-known/soms.protocolVersions` MUST 是非空 JSON number array，元素是严格递增、无重复的正
安全整数。节点只有完整支持某个 major 的全部必选行为时才能发布它。双方取版本数组交集的最高值；
交集为空则不建立联邦。选定版本由 `/s2s/v<major>` 路径明确表达，实现 MUST NOT 在各个 state、
message 或 command body 中重复版本字段。v1 身份 claim 中固定的 `protocolVersion: 1` 只把该
连续性证明绑定到已经选定的 v1 握手，不能替代 well-known 的多版本发现。

`software` 只用于诊断。consumer MUST NOT 根据产品名、软件版本或构建号启用、禁用或改变 v1
wire behavior。实现只有在完整支持本规范的全部必选行为时，才可以在 `protocolVersions` 中发布 `1`。

v1 不使用 capability negotiation，也没有可选 endpoint 分支。增加可选响应字段必须先满足对应
schema 的兼容规则；删除或重命名字段、改变字段含义、改变 endpoint、鉴权、状态码、幂等或 cursor
语义均属于不兼容变化，MUST 使用新的 `/s2s/v2` major version。错误修订、非规范性说明和不改变
可观察 wire behavior 的实现优化 MAY 在 v1 内发布。

## 3. Federation v1 HTTP Surface

本节已定稿。下表是完整 v1 surface；同步面严格只有两个 GET feed 和一个 POST revision hint。

| Method | Absolute path                       | 角色与用途                                                    |
| ------ | ----------------------------------- | ------------------------------------------------------------- |
| `GET`  | `/.well-known/soms`                 | server 发布身份、公钥和协议版本。                             |
| `POST` | `/s2s/v1/ignite`                    | 双方首次接触时固定身份并原子初始化 cursor。                   |
| `GET`  | `/s2s/v1/identity`                  | 已知 peer 获取 nonce-bound 身份连续性证明。                   |
| `POST` | `/s2s/v1/feed-revisions`            | 发送可丢失、可重复、可乱序的 state/message revision wake-up。 |
| `GET`  | `/s2s/v1/state-feed`                | 拉取压缩后的 profile、关系方向和群权威快照。                  |
| `GET`  | `/s2s/v1/message-feed`              | 拉取 durable message discovery change。                       |
| `POST` | `/s2s/v1/call`                      | 中继临时 call lifecycle、WebRTC SDP/ICE 与视频升级 frame。    |
| `GET`  | `/s2s/v1/users/:account`            | 首次显式查询本服务器用户的公开 profile。                      |
| `GET`  | `/s2s/v1/media/:digest`             | 按精确消息/thread 所有权授权下载 CAS 资源，支持单 Range。     |
| `GET`  | `/s2s/v1/forward-bundles/:bundleId` | 按消息可见性获取不可变 forward closure。                      |

`ignite` 和 `identity` 使用专门的身份验证流程；well-known 是公开 publisher；其余 S2S endpoint
使用已固定 peer 的 HTTP Message Signature。`identity` 同时是 demoted peer 的唯一恢复屏障：成功的
nonce-bound pinned-key 证明恢复已有 trust edge，不建立新身份。

`media/:digest` 的 digest 是资源 path parameter；消息 author/thread/source-seq 和可选 bundle
binding 是严格 query contract。请求者 domain 只从验证后的 HTTP Message Signature 得出，不接受
调用方重复声明。服务端必须证明该精确消息已经通过 durable discovery allocation 交付给签名 peer，
且 digest 属于该消息或它绑定的 forward closure。

未列入本节完整 surface 的路径不属于 Federation v1。

## 4. Discovery 与 Identity Document

`GET /.well-known/soms` 返回裸 JSON object，必选字段为：

- `software: string`：仅诊断使用；
- `protocolVersions: number[]`：严格递增、无重复的正安全整数；支持 v1 的节点必须包含 `1`；
- `rootKey: { fingerprint, ed25519 }`；
- `keys: [{ keyId, ed25519 }]`：v1 恰好一个 domain-bound Ed25519 signing key。

`fingerprint` 是 root public key 的 SHA-256 base64url fingerprint。v1 不支持在线 key rotation；
已经 pinned 的 root/signing identity 发生变化必须进入 identity loss。consumer MUST 忽略未知响应
字段，以允许 v1 增加纯附加诊断信息；不得据此形成可选 endpoint 或行为分支。

v1 不通过 well-known 发布运行时 limits。page、body、media、quota、群容量和 retention 等限制按
各 operation 的确定响应处理；本地数值不是其他实现必须复制的协议常量。

## 5. 网络发现、传输与签名安全

Federation peer 是服务器侧配置和信任的 domain identity，不是面向客户端的任意 URL 资源。

实现 MAY 通过 `_soms._tcp.<domain>` SRV 记录选择连接位置，并在没有可用 SRV 记录时回退到
domain apex。DNS/SRV 结果只决定本次连接位置，MUST NOT 改变已经 pinned 的 pairwise server ID、
root fingerprint 或 signing key。DNS 变化后出现 identity contradiction 时必须
fail closed，不能把域名当前控制者自动视为原 peer。

identity contradiction 发生后，自动流程 MUST 保持 `identity_lost`，不得因 DNS 再次变化而自动恢复。
DNS 已修复时，管理员 MAY 发起非破坏性原身份恢复：实现必须绕过已缓存的连接位置，重新获取
well-known，并用新 nonce 获取 `identity` proof；只有 root fingerprint、唯一 signing key、pairwise
server ID 与 identity-loss 前固定的全部证据精确相同时，才可恢复原 trust edge。该恢复 MUST 保留
`trustedAt`、cursor、mirror 与既有 authorization；任一身份字段不同都必须继续 fail closed。采用新
身份只能使用第 10 节的 destructive reset。

生产通信 MUST 使用 HTTPS 并验证连接目标的 TLS hostname；明确启用的 insecure HTTP 只适用于
隔离开发/测试环境。节点采用何种 DNS resolver、IP 分类、连接器或出站网络策略属于本地实现，
不得改变 v1 的 identity 与 signature 验证语义。

## 6. 请求契约与通用 Scalar

JSON 请求使用 UTF-8。wire identity 使用 `{ account, domain }`，数据库 ID 不得跨 S2S。domain
比较使用小写、移除末尾根点后的规范形式；account 按 v1 account grammar 规范化。

revision、HWM 和 cursor 使用匹配 `^(0|[1-9][0-9]*)$` 的十进制字符串，不使用 JSON number。
timestamp 使用 Unix epoch milliseconds，并且必须是非负安全整数。SHA-256 digest 是 64 位小写
十六进制字符串。nonce 使用 22–128 位 base64url 字符。

资源 identity 放 path，分页和消息授权坐标放 query，POST command 放 JSON body，HTTP Message
Signature、Range 和内容摘要放 header。重复 query key、缺失必选值、空值、非法编码或越界数值均
视为 malformed request。signer domain 必须与 body 中声明的 `origin`/`from.domain` 一致。

除 well-known、ignite 和 identity 的专门流程外，全部 S2S 请求必须由已 pinned 且 trusted 的 peer
按 RFC 9421 签名；签名覆盖 method、authority、path/query 和 body digest。

## 7. 响应、错误与 Caller Action

`well-known`、`ignite` 和 `identity` 成功响应是各自 Schema 定义的裸 JSON object；其中 identity
claim 的 detached signature 直接覆盖规范化 claim。其他 JSON success/error 使用
`{ code, message, data? }` envelope；`code: 0` 表示成功。业务结果可使用
HTTP 200 配合非零稳定 code，protocol/security/malformed/quota/liveness 错误保留对应 HTTP status。
consumer 不得仅凭 JSON body 把 401/403、identity conflict 或 5xx 当作普通业务拒绝。
所有允许出现在 S2S JSON error envelope 中的稳定 code 及 caller action 由
[Federation v1 错误码注册表](./errors.md) 定义；`message` 仅供诊断，不能作为机器分支条件。

`feed-revisions` 和 `call` 成功返回 202；这表示当前 command 已被接受处理，不表示对端 durable
feed 已完全排空。网络错误和 5xx MAY 重试；malformed、binding、authorization 和 identity
conflict MUST NOT 原样无限重试。cursor 只能在 response 完整验证且本地副作用与 cursor 同事务
提交后推进。

`media/:digest` 是 raw binary response：完整响应为 200，单 Range 为 206，不可满足 Range 为 416；
错误保持 HTTP status。JSON envelope 不包裹 binary body。

## 8. Durable State 与生命周期

`state-feed` 承载 `PROFILE`、`P2P_META`、`GROUP_INVITE_INTENT`、`GROUP_JOIN_INTENT` 和
origin-authoritative `GROUP_META`。方向事实按 stable key 与 business revision 合并；相同或更旧
revision 是完整 no-op。P2P 只有双方方向均为 `FRIEND` 才成立；群 roster 最终以 origin 的
`GROUP_META` 为准。

`state-feed` 的完整 page、五种 event body、字段约束与合并语义由
[Federation v1 State Feed](./state-feed.md) 定义；`message-feed` 的完整 page、11 种 content type、
媒体、转发与全部 SYSTEM event 由 [Federation v1 Message Feed](./message-feed.md) 定义。二者与本文
共同构成 v1 规范性正文，概要不能覆盖其字段级要求。

一对一实时通话采用 WebRTC media/JSEP，并以签名 `/s2s/v1/call` frame 承载 SOMS 联邦信令。完整 frame、
生命周期、失败语义、codec 基线以及同一连接上的 AUDIO→VIDEO 单向升级由
[Federation v1 语音与视频通话](./calls.md) 定义。实时 frame 不进入 feed；终态历史是普通 `CALL`
message。

关系撤销、退群、踢出、解散和 profile/roster 更新必须通过 durable state 或 structured SYSTEM
message 收敛，不能依赖 revision hint。SYSTEM message 只携结构化 event 与 stable identity，自然
语言由客户端渲染。普通消息 payload 不得获得 system-event authority。

权限撤销停止未来 allocation，但不删除已经分配给 peer 的历史 proof。历史读取和 media 授权按
durable allocation 验证；服务器本地的群容量、quota 和保留策略不是 wire 常量。

## 9. Feed、投递、Cursor 与媒体恢复

以下发布、恢复与防回环规则是 v1 contract：

- feed 是按目标 peer 分配的 durable facts/changes，不是“排除请求方本人内容”的作者过滤视图。
- `state-feed` MAY 返回由请求方最初提出、随后被发布方持久化并确认、否定或升版的方向事实。
  consumer MUST 按 compacted key 和 business revision 幂等合并，不得把“作者是自己”当作丢弃条件。
- message item 的 `originSeq` MUST 是作者服务器分配的稳定源序列；publisher 的本地排序序列不得
  改写它。item 的 `createdAt` MUST 表示 publisher 将该副本持久化的时间。
- publisher 从 peer X 拉取并提交一条由 X authored 的消息后，MUST 把该消息分配回 X 的
  `message-feed`。该 self-authored item 是 durable delivery acknowledgement：`originSeq` 指明
  X 的哪条发布已被接收，`createdAt` 给出 publisher 的持久化时间。
- consumer 收到 self-authored item 时 MUST 用稳定 `(thread, author, originSeq)` 坐标关联原发布，
  MUST NOT 创建重复消息。consumer 如何保存或展示回执属于本地实现，不属于 wire contract。
- publisher 从 peer X 拉取由其他 domain authored 的 relay 消息时，MUST NOT 把同一 change 直接
  反射回 X；这不阻止它向作者服务器或其他已授权 audience 分配该消息。

`state-feed` 与 `message-feed` query 均包含必选 `after` 和可选 `take`。page 返回 source HWM、
`scannedThrough` 和 `hasMore`；consumer 从已提交 cursor 开始，先完整排空 state，再拉 message。
page 与 cursor 必须在一个事务中提交。重复 page 必须幂等；空 page 也可确认并推进到 source HWM。

`feed-revisions` 只携带 `origin`、`stateFeedRev` 和 `messageFeedRev`。提示可以丢失、重复、乱序；
consumer 对 revision 取 max，并通过启动和周期 reconciliation 主动拉取两个 feed。进程恢复顺序为
`identity → state-feed → message-feed`。

媒体消息可先作为 durable pending work 提交，再通过 `media/:digest` Range 下载。下载失败或 quota
pause 不得回滚已经提交的 feed cursor；任务必须可由持久状态恢复。forward bundle 是有界、不可变、
按 digest 验证的 closure。

## 10. 身份丢失与 Reset

首次 `ignite` 使用双方 nonce-bound identity claim 并固定 pairwise server ID、root fingerprint、
signing key 和双方 cursor floor。普通 demotion 保留这些 continuity evidence；已知
peer 仅通过 nonce-bound `identity` 恢复，不重新 ignite，也不改写最初 `trustedAt`。

任何 pinned identity contradiction 必须原子进入 fail-closed identity-loss 状态。v1 不支持在线 key
rotation，也不允许当前域名控制者、裸删 peer row 或普通重新发现继承旧授权。

若 DNS 修复后再次出现全部原 pin，管理员可按第 5 节执行非破坏性恢复。该操作不能更换任何身份
字段。只有管理员 destructive reset 可以冻结并删除该 peer 的 cursor、mirror、authorization 和
关联状态，并授予一次 fresh ignite。reset 必须可在崩溃后继续；一次性 re-init 权限消费后不能复用。

## 11. Conformance 与发布

五份规范正文定义 v1 合规性；JSON Schema、HTTP manifest、正反向量和离线 conformance CLI 与正文
一同发布，作为非规范性验证资源。工具与正文冲突时以正文为准并修复工具。

Conformance 不是 v1 endpoint、协商能力或节点运行时前提，协议也不规定实现者必须使用哪种测试
设施。随附 CLI 可检查 JSON shape、固定签名向量和 HTTP surface；事务、身份连续性与状态收敛仍需
实现者自行验证。SOMS 另外使用 unit、数据库和项目内双节点 E2E 检查自身实现，这些测试不是其他
实现必须复制的协议组成部分。
