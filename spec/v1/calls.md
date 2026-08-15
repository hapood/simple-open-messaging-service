# Simple Open Chat Federation Protocol v1 通话信令（Call Signaling）

状态：`RELEASE CANDIDATE`（`v1.0.0-rc.0`）

本文定义协议服务器之间一对一通话的完整协议契约（protocol contract）。Federation v1 只定义签名的
`POST /s2s/v1/call` 和其中的协议生命周期事件；媒体、SDP、ICE、STUN 和 TURN 遵循第 13 节列出的
外部标准，本文不重新定义它们。

本文建立在 Federation v1 [主协议](./protocol.md)定义的 Federation 共享类型（Shared Federation Types）和
JSON 响应封装（JSON envelope）、[传输与安全](./transport-security.md)定义的身份、HTTP Message Signature
和请求限制，以及 [错误码注册表](./errors.md)定义的业务 code 之上。实现本操作时必须（MUST）同时遵守这些规范性正文；
[`common.schema.json`](./schema/common.schema.json) 只是对应类型的非规范性机器可读验证资源，不能覆盖正文。

规范词 `必须（MUST）`、`不得（MUST NOT）`、`应该（SHOULD）`、`不应该（SHOULD NOT）` 和 `可以（MAY）` 按 RFC 2119/RFC 8174 解释。

## 1. 协议边界（Protocol Scope）

Federation v1 负责：

- 在 caller server 与 callee server 之间建立临时通话状态；
- 原样中继终端产生的 SDP、ICE 和协议 `video-state` 载荷（payload）；
- 同步振铃、接听、连接、结束以及 AUDIO→VIDEO 升级事件；
- 定义 frame 的顺序、重试、幂等、竞态收敛和有限墓碑记录（tombstone）。

音视频媒体不进入 `/s2s/v1/call`、state-feed 或 message-feed。联邦服务器不得（MUST NOT）解密、转码、
混合或转发媒体，也不得（MUST NOT）解析或改写 SDP/ICE 来替终端作协商决定。

WebRTC/JSEP 不定义本协议使用的应用层信令传输，因此 `/s2s/v1/call` 的投递、幂等和错误处理由本文
完整定义，不能从 SDP、ICE 或 WebRTC transport 推导。

## 2. 角色、身份与关联键（Roles, Identities, and Correlation Keys）

- **主叫用户（caller）**：使用主叫账号发起通话的用户。
- **被叫用户（callee）**：使用被叫账号接听或拒绝通话的用户。
- **主叫服务器（caller server）**：托管主叫用户账号、发送 `incoming` 并仲裁权威生命周期的服务器。
- **被叫服务器（callee server）**：托管被叫用户账号、接收 `incoming` 并参与该通话临时信令状态的服务器。
- **终端（endpoint）**：产生或消费 WebRTC 信令与媒体的通话参与端；按角色称为主叫终端或被叫终端。
- **callSid**：每次新通话在联邦传输（wire）上使用的 UUID，是通话关联键。主叫服务器必须（MUST）保证不同
  通话不复用该值，并在重试同一通话时保持该值不变。
- **`signal.payload.id`**：每个逻辑 signal 在联邦传输上使用的 UUID，是该 signal 的幂等键。发送服务器
  必须（MUST）保证同一通话中的不同逻辑 signal 使用不同值，并在重试同一 signal 时保持该值不变。
  `callSid` 和 `signal.payload.id` 都使用 `common.schema.json#/$defs/canonicalUuid` 的 grammar：符合
  RFC 9562、版本字段为 1..8、RFC variant，并使用带连字符的 `8-4-4-4-12` 小写规范形式。v1 不根据
  UUID 版本改变行为。本文不规定 ID 由终端还是服务器生成；服务器始终对其发送到联邦传输的 ID 负责。
  大写或无连字符写法不合法。

只有 `incoming` 携带账号，且账号位于其 closed `payload` 中：

- `payload.fromAccount` 属于已经验证的 HTTP signer domain；
- `payload.toAccount` 属于本次请求 authority 所代表的接收服务器 domain；
- domain 只从 HTTP Message Signature 和 request authority 得出，Call Frame 不重复携带 domain。

握手只确定 server identity，不能确定 server 内的目标用户，因此 `incoming.payload.toAccount` 必选。
接收方接受 `incoming` 后，必须（MUST）把 `(signer domain, callSid)` 绑定到 caller/callee 账号、双方角色和初始
`callType`。所有后续 frame 只使用 signer domain、`callSid` 和该活动绑定寻址，不再携带账号。

## 3. HTTP 操作（HTTP Operation）

| 项目                               | 值                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------- |
| 方法（Method）                     | `POST`                                                                    |
| 路径（Path）                       | `/s2s/v1/call`                                                            |
| 查询（Query）                      | 不允许查询参数                                                            |
| 请求媒体类型（Request media type） | `application/json`，UTF-8                                                 |
| 请求认证（Request authentication） | Federation v1 HTTP Message Signature（RFC 9421、Ed25519）                 |
| 签名方要求（Signer requirement）   | 使用主协议 `recognized signed` 上下文；纯传输 `degraded` 不是协议拒绝条件 |
| 请求体（Request body）             | 第 4 节定义的一个封闭 Call Frame JSON 对象                                |
| 成功（Success）                    | HTTP `200`，JSON 成功封装                                                 |
| 错误（Error）                      | 第 11 节及 Federation v1 错误码注册表                                     |

请求必须（MUST）携带 `Content-Type`、`Date`、`Content-Digest`、`Signature-Input` 和 `Signature`。这些 header
的精确格式、签名组件顺序、时间窗口和原始 body digest 规则由主协议第 6 节统一定义，不能为 call
operation 选择其他 label、算法或覆盖组件。`Accept`、`User-Agent` 和 `Content-Length` 不参与 Call
Frame 语义，也不参与 Federation v1 签名基串。

发送方可以（MAY）根据本地缓存的 peer health 延迟或取消新的本地呼叫，这是本地调度策略，不是 wire
authorization。接收方不得（MUST NOT）仅因自己的缓存状态为 `degraded` 而拒绝一个签名、双向认可事实和业务
授权均有效的 Call Frame；该有效请求本身可以（MAY）按 recognition.md 恢复纯传输降级。

`halted` 不是 health cache，而是统一硬门禁。进入该状态时，服务器必须（MUST）立即把该 peer 的全部活动通话
本地收敛为 `terminal/failed`，停止媒体、计时器和非 terminal 重试，并创建第 10 节 tombstone；不得
（MUST NOT）等待远端 `cancelled` 或 `ended`。实现必须（MUST）在 lifecycle 之外保留 policy、identity 或
version 原因；随后到达的 Call Frame 在查询 call binding 前返回该原因对应的注册 fatal error。

成功响应是：

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"code":0,"message":"successful","data":null}
```

`200/code=0` 表示接收服务器已经验证并按本文处理 frame；它不表示终端已收到事件，也不表示
媒体已连通。HTTP `200` 的非零业务 code 不是成功，发送方必须（MUST）按第 11 节处理。

## 4. 通话帧（Call Frame）

每个 request body 必须（MUST）是一个 closed JSON object。未知字段、缺失字段、错误类型、非法枚举以及不属于
当前 `op` 的条件字段都必须（MUST）以 `FEDERATION_MALFORMED` 拒绝。

```ts
type CallOp =
  | 'incoming'
  | 'accepted'
  | 'ringing'
  | 'declined'
  | 'cancelled'
  | 'ended'
  | 'missed'
  | 'signal'
  | 'connected'
  | 'video-upgraded';

type CallType = 'AUDIO' | 'VIDEO';
type CallSignalKind = 'offer' | 'answer' | 'ice' | 'video-state';
type EndReason = 'completed' | 'timeout' | 'failed';

// 带连字符的小写 RFC UUID；版本字段 1..8，RFC variant。精确 grammar 见第 2 节和 JSON Schema。
type CanonicalUuid = string;

// RFC 8866 SDP 文本，不是 JSON；kind 已经表达 offer/answer，因此 data 不再包一层
// RTCSessionDescriptionInit。
type SdpText = string;

// T 说明 JSON.parse 后的结构；on the wire 仍是未经服务器改写的 JSON string。
type JsonText<T> = string;

// WebRTC 1.0 RTCIceCandidateInit 的 JSON 可序列化字段。缺省值和字段语义由 WebRTC 1.0 定义。
interface RTCIceCandidateInit {
  candidate?: string; // default: ''
  sdpMid?: string | null; // default: null
  sdpMLineIndex?: number | null; // unsigned short；default: null
  usernameFragment?: string | null; // default: null
}

// 本协议定义的对象；这是 closed object，不能有其他字段。
interface VideoState {
  enabled: boolean;
}

// 0..Number.MAX_SAFE_INTEGER 范围内的 JSON integer，单位为毫秒。
type UnixEpochMilliseconds = number;

interface CallFrameBase {
  callSid: CanonicalUuid;
  op: CallOp;
  callType: CallType;
}

type CallSignalPayload =
  | { id: CanonicalUuid; kind: 'offer' | 'answer'; data: SdpText }
  | {
      id: CanonicalUuid;
      kind: 'ice';
      data: JsonText<RTCIceCandidateInit>;
    }
  | {
      id: CanonicalUuid;
      kind: 'video-state';
      data: JsonText<VideoState>;
    };

type CallFrame =
  | (CallFrameBase & {
      op: 'incoming';
      payload: { fromAccount: string; toAccount: string };
    })
  | (CallFrameBase & {
      op: 'ringing' | 'accepted' | 'declined' | 'cancelled' | 'missed';
    })
  | (CallFrameBase & { op: 'signal'; payload: CallSignalPayload })
  | (CallFrameBase & {
      op: 'connected';
      payload: { startedAt: UnixEpochMilliseconds };
    })
  | (CallFrameBase & { op: 'video-upgraded'; callType: 'VIDEO' })
  | (CallFrameBase & { op: 'ended'; payload: { endReason: EndReason } });
```

三个公共字段在每一个 frame 中都必选：

| 字段       | 类型与约束         | 语义                    |
| ---------- | ------------------ | ----------------------- |
| `callSid`  | 规范小写 RFC UUID  | 活动通话关联键          |
| `op`       | `CallOp`           | 本 frame 唯一协议操作 |
| `callType` | `AUDIO` 或 `VIDEO` | 当前通话业务类型        |

除 `video-upgraded` 外，活动通话中每个 frame 的 `callType` 必须（MUST）等于接收方保存的当前类型。升级协商
期间当前类型仍为 `AUDIO`；只有接受 `video-upgraded` 后才变为 `VIDEO`。v1 不允许变回 `AUDIO`。

`payload` 是由 `op` 决定结构的 closed JSON object，不是任意 JSON。只有 `incoming`、`signal`、
`connected` 和 `ended` 必须（MUST）携带它，其他 op 禁止携带它。

## 5. 生命周期状态机（Lifecycle State Machine）

caller server 负责终态竞态仲裁并产生权威通话结果；callee server 只维护协议处理所需的临时阶段，且不得
产生与 caller server 竞争的第二份权威结果。本文不规定任一方的数据库表或历史记录存储方式。
Federation lifecycle 阶段只有 `ringing`、`accepted`、`connected` 和 `terminal`；实现可以（MAY）使用
`accepting`、`cancelling` 等内部 pending 状态，但不得（MUST NOT）改变本文定义的外部可观察协议行为。

本文的“阶段”是 server 对 `(peer domain, callSid)` 已提交的协议生命周期状态，不是终端界面
文案，也不是 `RTCPeerConnection.signalingState`、`iceConnectionState` 或 `connectionState`。两台 server
在 frame 传输期间可以（MAY）短暂处于不同阶段；接收方在返回 `200/code=0` 前提交目标阶段，发送方收到该响应后
才认为该变更已经完成联邦提交。

| 阶段        | 进入条件                                     | 精确定义                                                                  |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `none`      | 尚未接受 `incoming`                          | 不存在活动绑定；非 `incoming` frame 不能据此创建通话                      |
| `ringing`   | 接受 `incoming`                              | 已建立活动绑定，等待被叫用户接听；不表示被叫终端一定已开始发声/震动       |
| `accepted`  | 接受 `accepted`                              | 被叫用户已接听，SDP/ICE 可以（MAY）继续协商，但权威媒体连接尚未建立       |
| `connected` | 接受 callee server 的 `connected(startedAt)` | 权威媒体连接已经建立；`startedAt` 固定，后续重复报告不能覆盖              |
| `terminal`  | 接受第一个合法 terminal frame 或本地权威终态 | 活动状态不可恢复；只保留第 10 节 tombstone，任何迟到 frame 都不能使其复活 |

`ringing` 这个名称同时用于一个阶段和一个 op，但含义不同：`ringing` **阶段**由 `incoming` 创建，表示“尚未
接听”；`ringing` **op**只是被叫终端已实际开始提醒用户的确认（acknowledgment），设置独立的 advisory
事实，不改变阶段。因此没有收到该 op 的通话仍处于 `ringing` 阶段，收到该 op 后也仍处于 `ringing` 阶段。

```text
none --incoming--> ringing --accepted--> accepted --connected--> connected
ringing   --declined/missed/cancelled-------------> terminal
accepted  --cancelled/ended(completed|timeout|failed)-> terminal
connected --ended(completed|failed)----------------> terminal

connected/AUDIO --video-upgraded--> connected/VIDEO
ringing(op)、signal: 不改变阶段
```

完整转换矩阵：

下表的“应用阶段”是首次产生效果的阶段；“成功 no-op”是合法重试或已经经过的历史事件。未列入这两栏的
活动阶段组合是非法转换，terminal 后的处理另见第 7、10 节。

| `op`             | 方向            | 应用阶段                  | 应用结果           | 成功 no-op                                      |
| ---------------- | --------------- | ------------------------- | ------------------ | ----------------------------------------------- |
| `incoming`       | caller → callee | `none`                    | 创建 `ringing`     | 活动阶段中的完全相同 binding                    |
| `ringing`        | callee → caller | `ringing`                 | 阶段不变，记录提示 | `ringing` 已记录，或已经 `accepted`/`connected` |
| `accepted`       | callee → caller | `ringing`                 | `accepted`         | 已经 `accepted`/`connected`                     |
| `connected`      | callee → caller | `accepted`                | `connected`        | 已经 `connected`；保留第一个 `startedAt`        |
| `video-upgraded` | caller → callee | `connected` 且当前 AUDIO  | 当前类型变为 VIDEO | 初始 AUDIO 且已经升级为 VIDEO                   |
| `declined`       | callee → caller | `ringing`                 | `terminal`         | 已经 terminal                                   |
| `missed`         | callee → caller | `ringing`                 | `terminal`         | 已经 terminal                                   |
| `cancelled`      | caller → callee | `ringing` 或 `accepted`   | `terminal`         | 已经 terminal                                   |
| `ended`          | 双向            | `accepted` 或 `connected` | `terminal`         | 已经 terminal                                   |
| `signal`         | 第 8 节         | 第 8 节                   | 阶段不变并转发     | 相同 `payload.id` 已经处理                      |

被叫服务器在本地确认被叫终端已开始实际提醒用户后必须（MUST）发送 `ringing`，在此之前不得
（MUST NOT）发送；仅接收 `incoming` 不足以产生该帧。由于本地确认和 S2S 发送都可能重试，双方服务器
必须（MUST）按第 7 节幂等处理重复 `ringing`。

`cancelled` 允许作用于 `accepted` 是规范性的竞态收敛规则：caller 在尚未观察到 `accepted` 时发出的
取消，即使到达 callee 时 callee 已进入或正在进入 `accepted`，仍然终止尚未连通的通话。caller server
一旦已经接受 `accepted`，本地用户后续结束必须（MUST）发送 `ended`，不得（MUST NOT）新发送 `cancelled`。

`payload.startedAt` 是被叫终端首次确认媒体连接已建立的 Unix epoch milliseconds，必须（MUST）是
`0..9007199254740991` 范围内的 JSON integer。主叫服务器不发送 `connected`；主叫终端的
本地 WebRTC 状态不能产生第二个联邦时间戳。

`payload.endReason` 的阶段约束：

| 值          | 允许阶段                  | 含义                                             |
| ----------- | ------------------------- | ------------------------------------------------ |
| `completed` | `accepted` 或 `connected` | 任一参与者在接听后主动正常挂断；可以尚未建立媒体 |
| `timeout`   | `accepted`                | 接听后在本地建链期限内未能进入 `connected`       |
| `failed`    | 两者均可                  | 非超时技术失败，或已连接媒体不可恢复地中断       |

## 6. 提交、顺序与竞态（Commit, Ordering, and Races）

### 6.1 单发送方顺序（Per-Sender Ordering）

发送服务器必须（MUST）按产生顺序串行发送同一 `(peer domain, callSid)` 的**状态变更**，并等待上一条 HTTP
response 后才发送依赖它的新状态。上一条失败时必须（MUST）先重试同一 frame 或按 caller action 终止，不能
越过失败继续发送依赖状态。`signal` 必须（MUST）等待此前由它依赖的状态变更成功；多个 `signal` 可以（MAY）并发。

`ringing` 是不改变阶段的 advisory frame，不属于上述串行依赖链。被叫终端的 `ringing` 与
`accept` 请求可以（MAY）并发；callee server 不得（MUST NOT）等待 `ringing` 的 S2S response 才处理或发送 `accepted`。
`ringing` 发送失败不得（MUST NOT）阻止 `accepted`，也不得（MUST NOT）使通话失败。若 `accepted` 先到达，随后到达的
`ringing` 按第 7 节作为历史事件返回 `200/code=0` no-op。

接收服务器必须（MUST）在返回 `200/code=0` 前完成状态校验和本地状态提交。发送 callee-authored 状态的服务器
可以（MAY）先进入内部 pending 状态，但只有收到 `200/code=0` 后才把该状态视为已在联邦提交。收到
`CALL_CANCELLED` 或 `CALL_TERMINATED` 时必须（MUST）终止对应 pending 通话，不能继续发送依赖 frame。
callee server 必须（MUST）等待 `signal(answer)` 的 HTTP 成功响应后才能发送依赖该 answer 的 `connected`。
该依赖不要求 ICE 串行；ICE 仍可并发投递并由终端处理乱序。

### 6.2 正常时序（Normal Sequence）

```text
主叫终端           主叫服务器            被叫服务器          被叫终端
      | local initiate   |                     |                    |
      |----------------->| [ringing]           |                    |
      |                  | S2S incoming        |                    |
      |                  |-------------------->| [ringing]          |
      |                  |<------- 200 --------| local ring         |
      |                  |                     |------------------->|
      |                  | S2S ringing (advisory, may overlap accept)
      |                  |<--------------------|                    |
      | local SDP offer  |                     |                    |
      |----------------->| S2S signal{offer}   | local SDP offer    |
      |                  |-------------------->|------------------->|
      |                  |                     | local accept       |
      |                  |                     |<-------------------|
      |                  |                     | [accepted/pending] |
      |                  | S2S accepted        |                    |
      |                  |<--------------------|                    |
      |                  | [accepted] --200--->| [accepted/committed]
      |                  |                     | local SDP answer   |
      |                  |                     |<-------------------|
      |                  | S2S signal{answer}  |                    |
      |                  |<--------------------|                    |
      | local SDP answer |                     |                    |
      |<-----------------|                     |                    |
      |                  |                     | callee media up    |
      |                  |                     |<-------------------|
      |                  |                     | [connected/pending]|
      |                  | S2S connected(startedAt)                 |
      |                  |<--------------------|                    |
      |                  | [connected] --200-->| [connected/committed]
      | local connected(startedAt)             |                    |
      |<-----------------|                     |                    |
```

初始 SDP offer 可以（MAY）在 `incoming` 成功后、callee 接听前发送。callee server 必须（MUST）先创建该通话的临时
状态并完成处理，之后才能返回 `incoming` 的 HTTP response；caller 收到该 response 后才能发送 offer，
所以 offer 不会先于其目标通话到达。被叫终端针对 offer 生成的 SDP answer 只能在
`accepted` 后发送。图中的 `local SDP answer` 是终端与其归属服务器之间的本地 API/event；
`S2S signal{answer}` 才是两个服务器之间、`payload.kind="answer"` 的 Call Frame。两者携带同一份 SDP
文本，但不是同一个协议操作；SDP answer 与 HTTP response 也不是同一概念。

图中的 `pending` 是允许的内部实现状态，不是新增 Federation lifecycle 阶段。即使 callee server 已经在本地处理 accept
或 media-up，也只有对应 S2S frame 获得 `200/code=0` 后，图中该行才成为双方共同提交的阶段。
`ringing` advisory 不参与这个提交依赖；它可以（MAY）在 `accepted` 前后到达或失败。

### 6.3 `accepted`/`cancelled` 竞态（Accepted/Cancelled Race）

```text
callee server                         caller server (权威)
 accepted -- pending --------------------->|
                                         | 若仍 ringing：提交 accepted
                                         | 若已 cancelled：CALL_CANCELLED
                                         | 若以其他原因 terminal：CALL_TERMINATED

caller server                         callee server
 本地仍 ringing，提交 cancelled ---------->|
                                         | ringing/accepting/accepted 均进入 terminal
```

因此竞态的仲裁顺序是 caller server 对 `accepted` 与本地 `cancelled` 的实际处理顺序，而不是两台服务器
各自的墙上时间。迟到事件不得（MUST NOT）使 terminal 通话复活。

### 6.4 双向终态（Bidirectional Terminal Events）

双方可能同时发送 `ended`。caller server 首次提交的终态是权威终态；callee server 的临时终态记录
不得（MUST NOT）生成第二份权威通话结果。任一端进入 terminal 后都必须（MUST）停止该通话的媒体与活动语义。

## 7. 生命周期幂等性（Lifecycle Idempotency）

生命周期使用单调状态机实现幂等，不使用单独的 lifecycle request ID。一个方向合法、且属于已经成功
经过路径的 lifecycle 事件再次到达时必须（MUST）返回 `200/code=0`，不得（MUST NOT）再次产生该事件的可观察效果，也不得（MUST NOT）
持久化第二份结果或回退状态：callee server 在任一活动阶段吸收重复 `incoming`；caller server 在
`accepted`/`connected` 阶段吸收重复 `ringing` 和 `accepted`，并在 `connected` 阶段吸收重复
`connected`。不属于已经经过路径的竞争分支仍是非法转换，例如 `accepted` 后的 `declined` 或
`missed`。

- 活动状态中的重复 `incoming`，只有 signer、两个账号、`callSid` 和初始 `callType` 全部一致时才是
  retry；否则是 callSid collision，以 `FEDERATION_MALFORMED` 拒绝。retry 必须（MUST）保持 `200/code=0`，不得（MUST NOT）
  因首次接受后的本地准入条件变化而改为拒绝。
- 首次接受的 `connected.payload.startedAt` 是权威值；后续重复 `connected` 返回 `200/code=0`，不得（MUST NOT）比较
  或覆盖该值。
- 重复 `video-upgraded` 只有通话最初为 AUDIO 且已经完成升级时是 no-op；初始 VIDEO 通话发送该 op
  必须（MUST）以 `FEDERATION_MALFORMED` 拒绝。
- 第一个终态获胜。进入 terminal 后收到任何 `declined`、`cancelled`、`missed` 或 `ended` 都返回
  `200/code=0`，不比较 op、`callType` 或 `endReason`，也不改变首次终态。其他迟到 frame 按第 10、11
  节返回 terminal 业务结果，促使发送方停止依赖操作。

## 8. 信令载荷、阶段与重试（Signal Payload, Phases, and Retries）

`signal.payload.data` 必须（MUST）是长度为 1..32768 个 Unicode code point 的字符串。服务器只检查外层类型、
长度、ID 和活动绑定，不能解析、规范化、重新序列化或改写 `data`。

上面的 `JsonText<T>` 是描述 transmitted representation 的文档记法：字段 on the wire 是 JSON
string，`T` 是终端对该字符串
执行 `JSON.parse` 后必须（MUST）得到的结构。signal 产生方必须（MUST）生成符合对应结构的内容；联邦服务器即使发现或
怀疑内层内容无效也不得（MUST NOT）代替接收方拒绝它。消费该载荷的一侧必须（MUST）在交给 WebRTC API 或应用状态前验证/解析，
无效内容只终止或忽略本地协商，不能改变服务器已经完成的 signal 幂等结果。

| `kind`        | 方向            | 允许阶段                           | `data` 编码                                 |
| ------------- | --------------- | ---------------------------------- | ------------------------------------------- |
| `offer`       | caller → callee | `ringing`、`accepted`、`connected` | 原始 SDP string                             |
| `answer`      | callee → caller | `accepted`、`connected`            | 原始 SDP string                             |
| `ice`         | 双向            | `ringing`、`accepted`、`connected` | `RTCIceCandidateInit` 的 JSON string        |
| `video-state` | 双向            | `connected`                        | closed `{"enabled":boolean}` 的 JSON string |

一个 `callSid` 同一时刻最多有一个未完成 negotiation。caller 只能在上一轮 answer 已成功应用、
终端 signaling state 恢复
`stable` 后创建下一轮 offer；callee 每收到一个合法 offer 至多产生一个 answer。

`payload.id` 是 signal 的幂等键。发送服务器必须（MUST）保证新逻辑 signal 使用该通话中尚未使用的 ID；
重试同一 signal 时必须（MUST）复用原 ID 并保持 body 一致。本文不规定该 ID 最初由终端还是服务器生成。

接收服务器对同一 `(signer domain, callSid, payload.id)` 只接受第一个 signal；以后相同 ID 的 signal
无论 body 是否相同都必须（MUST）返回 `200/code=0` 并作为 no-op 处理，不得（MUST NOT）再次产生该 signal 的
应用层效果。接收服务器不得（MUST NOT）通过比较后续 body 改写或否定已经接受的第一条 signal。通话进入
terminal 后，仍必须（MUST）在第 10 节定义的 tombstone 有效期内保留处理 signal retry 所需的幂等信息。
WebRTC/JSEP 本身不提供这项应用层去重能力。

ICE 可以（MAY）相对 offer/answer 乱序到达。联邦服务器不得（MUST NOT）根据 JSEP 到达顺序拒绝、重排或解释 ICE，只按
外层 binding、shape 和 `payload.id` 执行校验与幂等，并原样转发；终端根据本地 WebRTC signaling
state 缓存、应用。初次协商须等待 callee server 的
`connected` 才表示媒体建链成功。ICE restart 成功不产生生命周期事件；AUDIO→VIDEO 成功后按第 9 节
发送 `video-upgraded`。

## 9. AUDIO→VIDEO 升级（AUDIO-to-VIDEO Upgrade）

Federation v1 固定主叫终端为所有 offer 的产生方，被叫终端为 answer 产生方。这是本协议
为避免 offer glare 选择的应用层 profile，不是 RFC 3264 对 offerer 的限制。

被叫用户希望把 AUDIO 通话升级为 VIDEO 时，被叫终端先发送 `video-state {"enabled":true}`；主叫终端收到
请求后创建新 offer。主叫用户发起升级时也由主叫终端创建 offer。升级期间 offer、answer 和 ICE 的 `callType` 仍为
`AUDIO`。主叫终端成功应用对应 answer 后，主叫服务器才发送：

```json
{
  "callSid": "550e8400-e29b-41d4-a716-446655440000",
  "op": "video-upgraded",
  "callType": "VIDEO"
}
```

callee 不发送 `video-upgraded`，也不在本地 answer 应用后自行提交升级。接收该 frame 后双方当前类型
才变成 VIDEO。关闭摄像头只发送 `video-state`，不把业务类型降回 AUDIO。ICE restart 或不增加视频
媒体的重新协商不得（MUST NOT）产生 `video-upgraded`。

## 10. 墓碑记录、重放与重启（Tombstones, Replay, and Restart）

接受 `declined`、`cancelled`、`missed` 或 `ended` 后，活动状态立即进入 terminal，并创建有限
tombstone。tombstone 的截止时间是：

```text
min(terminal request 的 Signature-Input.expires,
    接受终态的本地时间 + 300 秒)
```

`300 秒` 是 Federation v1 call tombstone 最大保留窗口。已经到期的条目可以（MAY）清理，但
不能把重试请求的新签名期限用于延长首次终态 tombstone。发送方为本地产生的终态使用自己生成的终态
请求 `expires` 计算相同截止时间。

tombstone 至少保存第 7、8 节执行幂等所需的信息。tombstone 存在期间：

- 任何 terminal frame 都是 no-op，且不改变首次终态；
- 已处理 signal ID 是 no-op；
- cancelled tombstone 的新 `incoming` 和其他迟到 frame 返回 `CALL_CANCELLED`；
- 其他 terminal tombstone 的新 `incoming` 和其他迟到 frame 返回 `CALL_TERMINATED`；
- 任何 frame 都不能重新创建或恢复该通话。

`Signature-Input` 的 `expires` 仍受主协议 `created + 300` 上限约束；发送方设置更大的值会在业务处理前被
拒绝。任一端提交或获知 terminal 后，必须（MUST）原子停止并取消该 `callSid` 的所有非 terminal 待发送和
重试工作，不得（MUST NOT）通过生成新签名继续重放旧 `incoming` 或 signal。结合主叫服务器不得为其他通话
复用 `callSid` 的要求，墓碑只负责吸收仍处于已签名有效窗口内的在途重放，不承担永久 call ID 注册表的作用。

服务器重启可以（MAY）丢失活动媒体状态，但必须（MUST）保留尚未到期的 tombstone；v1 不提供活动通话恢复操作。

caller server 和 callee server 都必须（MUST）分别设置有限的未接听超时和接听后建链超时，避免通话无限停留在
活动阶段。进入 `accepted` 后，未接听期限不再适用，并开始适用建链期限。具体时长属于本地参数；v1 不规定双方
对应超时的长短关系，实现不得（MUST NOT）依赖某一方的计时器先触发。双方超时形成的竞态按第 6、7 节收敛。

超时产生的 protocol operation 固定如下；首次超时进入 terminal，并按第 6、7 节参与终态竞态：

| 超时                        | 产生方        | 必须（MUST）发送的 frame |
| --------------------------- | ------------- | ------------------------ |
| callee 未接听超时           | callee server | `missed`                 |
| caller 未接听超时           | caller server | `cancelled`              |
| callee 接听后媒体未建链超时 | callee server | `ended(timeout)`         |
| caller 接听后媒体未建链超时 | caller server | `ended(timeout)`         |

## 11. 验证顺序、错误与调用方动作（Verification Order, Errors, and Caller Actions）

接收方必须（MUST）按以下顺序处理：

1. 验证 `recognized signed` 上下文、HTTP signature、Date/created/expires、digest、Content-Type 和 body size；
   不得（MUST NOT）仅因本地可用性缓存为 `degraded` 而失败；
2. 验证 closed Call Frame shape 和 Federation 共享类型；
3. 对所有 op 按 `(signer domain, callSid)` 查询已有的活动绑定或 tombstone；
4. tombstone 中的 terminal frame，以及 tombstone 已记录 ID 的 signal retry，返回 `200/code=0`；其他
   frame 返回 `CALL_CANCELLED` 或 `CALL_TERMINATED`；
5. 活动绑定中的重复 `incoming` 按第 7 节判断 retry 或 collision；已记录 ID 的 signal retry 在外层 shape
   合法后返回 `200/code=0`，不再比较后续 body，也不执行方向、阶段和 `callType` 状态校验；
6. 只有全新的 `incoming` 才验证账号与 domain 的绑定并执行本地新通话准入检查，通过后建立活动绑定；
7. 其他新 frame 找到活动绑定后，再验证方向、阶段、callType 和 op-specific 约束；已经经过的 lifecycle
   事件按第 7 节返回 no-op。

全新 `incoming` 的 `toAccount` 不存在、停用、拒绝联邦通话、参与者关系不允许、用户级 block、租户策略拒绝
或其他不能安全公开的准入失败，必须（MUST）统一返回 HTTP `200/CALL_NOT_ALLOWED`。不得（MUST NOT）用
`FEDERATION_MALFORMED` 表示这些条件，因为请求 shape 和 identity binding 可能完全合法；也不得（MUST NOT）
通过 `NOT_FOUND`、`FORBIDDEN`、不同 message 或结构化 `data` 泄露具体原因。只有独立于账号是否存在的全局
限流、请求格式错误和 server failure 才使用对应通用错误。

接收方必须（MUST）先完成上述全部隐私准入检查，只有 caller 已获准呼叫该 `toAccount` 后才能检查占线状态并
返回 `CALL_BUSY`。未通过准入时，即使目标账号存在且当前占线，也必须（MUST）返回 `CALL_NOT_ALLOWED`；响应
时间和诊断 message 不得（MUST NOT）暴露检查到了哪一步。

未知且无 tombstone 的非 `incoming` 返回 HTTP `200/CALL_NOT_ALLOWED`。该结果不能创建用户、通话、
通知或其他业务状态。活动通话建立后，用户级 P2P 关系或呼叫权限改变、但 Federation peer 没有进入硬门禁
时，必须（MUST）继续允许用于安全终止和收敛的合法 frame；关系变化不能阻止 `cancelled` 或 `ended`。
Federation peer 进入硬门禁时改由本节前述本地 `terminal/failed` 规则收敛，不再接收远端终止 frame。

错误 body 使用主协议定义的 JSON envelope；实现不能根据 `message` 文本分支。

| 条件                                       | HTTP / code                        | 动作                                                |
| ------------------------------------------ | ---------------------------------- | --------------------------------------------------- |
| shape、字段、ID、活动绑定、方向或非法转换  | `400 FEDERATION_MALFORMED`         | 修正后才能重试                                      |
| signer 与 `incoming` 发送用户不绑定        | `401 FEDERATION_BINDING_VIOLATION` | 不得（MUST NOT）原样重试                            |
| 未知 callSid，或隐私合并后的新呼叫准入失败 | `200 CALL_NOT_ALLOWED`             | 终止本次呼叫，不得（MUST NOT）把 peer 置为 degraded |
| cancelled 通话的迟到非重复 frame           | `200 CALL_CANCELLED`               | 收敛为 cancelled，不再发送依赖项                    |
| 其他 terminal 通话的迟到非重复 frame       | `200 CALL_TERMINATED`              | 收敛为 terminal，不再发送依赖项                     |
| callee 已有其他活动通话                    | `200 CALL_BUSY`                    | 终止或以后创建新 `callSid`                          |

网络错误和 HTTP `503` 可以（MAY）退避重试完全相同的 frame。HTTP `200` 仍必须（MUST）解析 envelope；
`code=0` 是成功，非零 code 是已处理的业务结果。签名、身份绑定、请求格式和服务故障不是业务结果，分别使用
HTTP `401`、`400` 和 `503`。

## 12. 通话帧与签名示例（Call Frame and Signature Examples）

### 12.1 生命周期帧（Lifecycle Frame）

完整 lifecycle body 示例：

```json
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"incoming","callType":"AUDIO","payload":{"fromAccount":"alice","toAccount":"bob"}}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"ringing","callType":"AUDIO"}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"accepted","callType":"AUDIO"}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"connected","callType":"AUDIO","payload":{"startedAt":1700000000100}}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"declined","callType":"AUDIO"}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"cancelled","callType":"AUDIO"}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"missed","callType":"AUDIO"}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"ended","callType":"AUDIO","payload":{"endReason":"completed"}}
```

同一个 `callSid` 只用于展示互斥路径，不表示一通电话经过所有终态。

### 12.2 信令帧（Signal Frame）

四种完整 signal body 示例：

```json
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"signal","callType":"AUDIO","payload":{"id":"c0a80101-0000-4000-8000-000000000001","kind":"offer","data":"v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"}}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"signal","callType":"AUDIO","payload":{"id":"c0a80101-0000-4000-8000-000000000002","kind":"answer","data":"v=0\r\no=- 77218088 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"}}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"signal","callType":"AUDIO","payload":{"id":"c0a80101-0000-4000-8000-000000000003","kind":"ice","data":"{\"candidate\":\"candidate:1 1 UDP 2122260223 192.0.2.10 54321 typ host\",\"sdpMid\":\"0\",\"sdpMLineIndex\":0}"}}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"signal","callType":"VIDEO","payload":{"id":"c0a80101-0000-4000-8000-000000000004","kind":"video-state","data":"{\"enabled\":true}"}}
```

### 12.3 HTTP 消息签名（HTTP Message Signature）

固定签名示例：

```http
POST /s2s/v1/call HTTP/1.1
Host: b.example
Content-Type: application/json
Date: Tue, 14 Nov 2023 22:13:20 GMT
Content-Digest: sha-256=:<由下列 body 精确计算的 base64 digest>:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:<Ed25519 signature>:

{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"incoming","callType":"AUDIO","payload":{"fromAccount":"alice","toAccount":"bob"}}
```

确定性 digest、signature 和私钥见
[`schema/vectors/call-http-message-signature.json`](./schema/vectors/call-http-message-signature.json)。签名覆盖
单行 body 的精确 UTF-8 字节；增加空格或换行后必须（MUST）重新计算。

## 13. 外部标准来源（External Standards）

Federation v1 不修改或重新定义下列标准：

- [WebRTC 1.0](https://www.w3.org/TR/webrtc/)；
- [RFC 8829 — JSEP](https://www.rfc-editor.org/rfc/rfc8829.html)；
- [RFC 3264 — SDP Offer/Answer](https://www.rfc-editor.org/rfc/rfc3264.html)；
- [RFC 8866 — SDP](https://www.rfc-editor.org/rfc/rfc8866.html)；
- [RFC 8445 — ICE](https://www.rfc-editor.org/rfc/rfc8445.html)；
- [RFC 8838 — Trickle ICE](https://www.rfc-editor.org/rfc/rfc8838.html)；
- [RFC 8489 — STUN](https://www.rfc-editor.org/rfc/rfc8489.html)；
- [RFC 8656 — TURN](https://www.rfc-editor.org/rfc/rfc8656.html)；
- [RFC 8834](https://www.rfc-editor.org/rfc/rfc8834.html)、
  [RFC 8835](https://www.rfc-editor.org/rfc/rfc8835.html)；
- [RFC 8827](https://www.rfc-editor.org/rfc/rfc8827.html)；
- [RFC 9421 — HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html)；
- [RFC 9562 — UUID](https://www.rfc-editor.org/rfc/rfc9562.html)。
