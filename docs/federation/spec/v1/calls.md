# Federation v1 通话信令

状态：`FINAL`

本文定义 SOMS 服务器之间一对一通话的完整 wire contract。Federation v1 只定义签名的
`POST /s2s/v1/call` 和其中的 SOMS 生命周期事件；媒体、SDP、ICE、STUN 和 TURN 遵循第 13 节列出的
外部标准，本文不重新定义它们。

本文建立在 Federation v1 [主协议](./protocol.md)定义的身份、HTTP Message Signature、请求限制和
JSON envelope，[错误码注册表](./errors.md)定义的业务 code，以及
[`common.schema.json`](./schema/common.schema.json) 定义的公共类型之上。实现本操作时必须同时遵守这些
基础规范；本文不重复其定义。

规范词 `MUST`、`MUST NOT`、`SHOULD`、`SHOULD NOT` 和 `MAY` 按 RFC 2119/RFC 8174解释。

## 1. 协议边界

Federation v1 负责：

- 在 caller server 与 callee server 之间建立临时通话状态；
- 原样中继 endpoint 产生的 SDP、ICE 和 SOMS `video-state` payload；
- 同步振铃、接听、连接、结束以及 AUDIO→VIDEO 升级事件；
- 定义 frame 的顺序、重试、幂等、竞态收敛和有限 tombstone。

音视频媒体不进入 `/s2s/v1/call`、state-feed 或 message-feed。SOMS 联邦服务器不得解密、转码、
混合或转发媒体，也不得解析或改写 SDP/ICE 来替 endpoint 作协商决定。

WebRTC/JSEP 不定义 SOMS 使用的应用层信令传输，因此 `/s2s/v1/call` 的投递、幂等和错误处理由本文
完整定义，不能从 SDP、ICE 或 WebRTC transport 推导。

## 2. 角色、身份与关联键

- **caller server**：托管 caller 账号、接收本地发起请求并保存权威生命周期的服务器。
- **callee server**：托管 callee 账号、接收 `incoming` 并保存该通话临时信令状态的服务器。
- **callSid**：caller endpoint 为每次新通话生成的 UUID，是通话关联键；生成方终身不得主动复用。
- **`signal.payload.id`**：signal 产生方为每个逻辑 signal 生成的 UUID，是该 signal 的幂等键。
  `callSid` 和 `signal.payload.id` 都使用 `common.schema.json#/$defs/canonicalUuid` 的 grammar：符合
  RFC 9562、版本字段为 1..8、RFC variant，并使用带连字符的 `8-4-4-4-12` 小写规范形式。v1 不根据
  UUID 版本改变行为；生成方必须保证实际唯一性。大写或无连字符写法不合法。

只有 `incoming` 携带账号，且账号位于其 closed `payload` 中：

- `payload.fromAccount` 属于已经验证的 HTTP signer domain；
- `payload.toAccount` 属于本次请求 authority 所代表的接收服务器 domain；
- domain 只从 HTTP Message Signature 和 request authority 得出，Call Frame 不重复携带 domain。

握手只确定 server identity，不能确定 server 内的目标用户，因此 `incoming.payload.toAccount` 必选。
接收方接受 `incoming` 后，必须把 `(signer domain, callSid)` 绑定到 caller/callee 账号、双方角色和初始
`callType`。所有后续 frame 只使用 signer domain、`callSid` 和该活动绑定寻址，不再携带账号。

## 3. HTTP operation

| 项目                   | 值                                                                    |
| ---------------------- | --------------------------------------------------------------------- |
| Method                 | `POST`                                                                |
| Path                   | `/s2s/v1/call`                                                        |
| Query                  | 不允许 query parameter                                                |
| Request media type     | `application/json`，UTF-8                                             |
| Request authentication | Federation v1 HTTP Message Signature（RFC 9421、Ed25519）             |
| Signer requirement     | 签名者必须是接收方已固定身份（pinned）且 `trustLevel=trusted` 的 peer |
| Request body           | 第 4 节定义的一个 closed Call Frame JSON object                       |
| Success                | HTTP `200`，JSON success envelope                                     |
| Error                  | 第 11 节及 Federation v1 错误码注册表                                 |

请求必须携带 `Content-Type`、`Date`、`Content-Digest`、`Signature-Input` 和 `Signature`。这些 header
的精确格式、签名组件顺序、时间窗口和原始 body digest 规则由主协议第 6 节统一定义，不能为 call
operation 选择其他 label、算法或覆盖组件。`Accept`、`User-Agent` 和 `Content-Length` 不参与 Call
Frame 语义，也不参与 Federation v1 签名基串。

成功响应是：

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"code":0,"message":"successful","data":null}
```

`200/code=0` 表示接收服务器已经验证并按本文处理 frame；它不表示 endpoint 已收到事件，也不表示
媒体已连通。HTTP `200` 的非零业务 code 不是成功，发送方必须按第 11 节处理。

## 4. Call Frame

每个 request body 必须是一个 closed JSON object。未知字段、缺失字段、错误类型、非法枚举以及不属于
当前 `op` 的条件字段都必须以 `FEDERATION_MALFORMED` 拒绝。

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

// T 说明 JSON.parse 后的结构；wire 上仍是未经服务器改写的 JSON string。
type JsonText<T> = string;

// WebRTC 1.0 RTCIceCandidateInit 的 JSON 可序列化字段。缺省值和字段语义由 WebRTC 1.0 定义。
interface RTCIceCandidateInit {
  candidate?: string; // default: ''
  sdpMid?: string | null; // default: null
  sdpMLineIndex?: number | null; // unsigned short；default: null
  usernameFragment?: string | null; // default: null
}

// SOMS 自有对象；这是 closed object，不能有其他字段。
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
| `op`       | `CallOp`           | 本 frame 唯一 SOMS 操作 |
| `callType` | `AUDIO` 或 `VIDEO` | 当前通话业务类型        |

除 `video-upgraded` 外，活动通话中每个 frame 的 `callType` 必须等于接收方保存的当前类型。升级协商
期间当前类型仍为 `AUDIO`；只有接受 `video-upgraded` 后才变为 `VIDEO`。v1 不允许变回 `AUDIO`。

`payload` 是由 `op` 决定结构的 closed JSON object，不是任意 JSON。只有 `incoming`、`signal`、
`connected` 和 `ended` 必须携带它，其他 op 禁止携带它。

## 5. 生命周期状态机

caller server 保存持久通话历史并负责终态竞态仲裁；callee server 保存通话期间所需的临时阶段。
wire 阶段只有 `ringing`、`accepted`、`connected` 和 `terminal`；实现可以使用 `accepting`、
`cancelling` 等内部 pending 状态，但不得改变本文可观察的 wire 行为。

```text
none --incoming--> ringing --accepted--> accepted --connected--> connected
                       |           |          |                       |
                declined/missed cancelled  ended(...)            ended(...)
                       |           |          |                       |
                       +-----------+----------+-----------------------+--> terminal

cancelled: ringing 或 accepted → terminal
video-upgraded: connected/AUDIO → connected/VIDEO
signal: ringing、accepted 或 connected 内的临时事件，不改变阶段
```

完整转换矩阵：

| `op`             | 方向            | 允许接收阶段              | 结果               |
| ---------------- | --------------- | ------------------------- | ------------------ |
| `incoming`       | caller → callee | `none`                    | 创建 `ringing`     |
| `ringing`        | callee → caller | `ringing`                 | 阶段不变           |
| `accepted`       | callee → caller | `ringing`                 | `accepted`         |
| `connected`      | callee → caller | `accepted`                | `connected`        |
| `video-upgraded` | caller → callee | `connected` 且当前 AUDIO  | 当前类型变为 VIDEO |
| `declined`       | callee → caller | `ringing`                 | `terminal`         |
| `missed`         | callee → caller | `ringing`                 | `terminal`         |
| `cancelled`      | caller → callee | `ringing` 或 `accepted`   | `terminal`         |
| `ended`          | 双向            | `accepted` 或 `connected` | `terminal`         |
| `signal`         | 第 8 节         | 第 8 节                   | 阶段不变           |

callee endpoint 收到 `incoming` 并开始实际提醒用户时，必须向其 home server 提交 ringing acknowledgment；
callee server 接受该 acknowledgment 后必须发送 `ringing`。由于 endpoint 和 S2S 发送都可能重试，双方
server 必须按第 7 节幂等处理重复 `ringing`。

`cancelled` 允许作用于 `accepted` 是规范性的竞态收敛规则：caller 在尚未观察到 `accepted` 时发出的
取消，即使到达 callee 时 callee 已进入或正在进入 `accepted`，仍然终止尚未连通的通话。caller server
一旦已经接受 `accepted`，本地用户后续结束必须发送 `ended`，不得新发送 `cancelled`。

`payload.startedAt` 是 callee endpoint 首次确认媒体连接已建立的 Unix epoch milliseconds，必须是
`0..9007199254740991` 范围内的 JSON integer。caller server 不发送 `connected`；caller endpoint 的
本地 WebRTC 状态不能产生第二个联邦时间戳。

`payload.endReason` 的阶段约束：

| 值          | 允许阶段    | 含义                                       |
| ----------- | ----------- | ------------------------------------------ |
| `completed` | `connected` | 任一参与者正常挂断                         |
| `timeout`   | `accepted`  | 接听后在本地建链期限内未能进入 `connected` |
| `failed`    | 两者均可    | 非超时技术失败，或已连接媒体不可恢复地中断 |

## 6. 提交、串行与竞态

### 6.1 单发送方顺序

发送服务器必须按产生顺序串行发送同一 `(peer domain, callSid)` 的生命周期状态变更，并等待上一条 HTTP
response 后才发送依赖它的新状态。上一条失败时必须先重试同一 frame 或按 caller action 终止，不能
越过失败继续发送依赖状态。`signal` 必须等待此前的 lifecycle frame 成功；多个 `signal` 可以并发。

接收服务器必须在返回 `200/code=0` 前完成状态校验和本地状态提交。发送 callee-authored 状态的服务器
可以先进入内部 pending 状态，但只有收到 `200/code=0` 后才把该状态视为已在联邦提交。收到
`CALL_CANCELLED` 或 `CALL_TERMINATED` 时必须终止对应 pending 通话，不能继续发送依赖 frame。
callee server 必须等待 `signal(answer)` 的 HTTP 成功响应后才能发送依赖该 answer 的 `connected`。
该依赖不要求 ICE 串行；ICE 仍可并发投递并由 endpoint 处理乱序。

### 6.2 正常时序

```text
caller endpoint    caller server         callee server       callee endpoint
      | local initiate   |                     |                    |
      |----------------->| S2S incoming        | local ring         |
      |                  |-------------------->|------------------->|
      |                  | S2S ringing         |                    |
      |                  |<--------------------|                    |
      | local SDP offer  |                     |                    |
      |----------------->| S2S signal{offer}   | local SDP offer    |
      |                  |-------------------->|------------------->|
      |                  |                     | local accept       |
      |                  |                     |<-------------------|
      |                  | S2S accepted        |                    |
      |                  |<--------------------|                    |
      |                  |                     | local SDP answer   |
      |                  |                     |<-------------------|
      |                  | S2S signal{answer}  |                    |
      |                  |<--------------------|                    |
      | local SDP answer |                     |                    |
      |<-----------------|                     |                    |
      |                  | S2S connected       |                    |
      |                  |<--------------------|                    |
      | local connected  |                     |                    |
      |<-----------------|                     |                    |
```

初始 SDP offer 可以在 `incoming` 成功后、callee 接听前发送。callee server 必须先创建该通话的临时
状态并完成处理，之后才能返回 `incoming` 的 HTTP response；caller 收到该 response 后才能发送 offer，
所以 offer 不会先于其目标通话到达。callee endpoint 针对 offer 生成的 SDP answer 只能在
`accepted` 后发送。图中的 `local SDP answer` 是 endpoint 与其 home server 之间的本地 API/event；
`S2S signal{answer}` 才是两个服务器之间、`payload.kind="answer"` 的 Call Frame。两者携带同一份 SDP
文本，但不是同一个协议操作；SDP answer 与 HTTP response 也不是同一概念。

### 6.3 accepted/cancelled 竞态

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
各自的墙上时间。迟到事件不得使 terminal 通话复活。

### 6.4 双向终态

双方可能同时发送 `ended`。caller server 首次提交的终态是权威终态；callee server 的临时终态记录
不得生成第二份持久通话历史。任一端进入 terminal 后都必须停止媒体和 endpoint 活动语义。

## 7. 生命周期幂等

生命周期使用单调状态机实现幂等，不使用单独的 lifecycle request ID。已经成功经过的非终态 lifecycle
事件再次到达时必须返回 `200/code=0`，且不得重复通知 endpoint、计费、持久化或回退状态：`accepted`
阶段吸收重复 `incoming`、`ringing` 和 `accepted`；`connected` 阶段还吸收重复 `connected`。不属于已经
经过路径的竞争分支仍是非法转换，例如 `accepted` 后的 `declined` 或 `missed`。

- 活动状态中的重复 `incoming`，只有 signer、两个账号、`callSid` 和初始 `callType` 全部一致时才是
  retry；否则是 callSid collision，以 `FEDERATION_MALFORMED` 拒绝。retry 不重新检查关系、quota 或
  busy。
- 首次接受的 `connected.payload.startedAt` 是权威值；后续重复 `connected` 返回 `200/code=0`，不得比较
  或覆盖该值。
- 重复 `video-upgraded` 只有通话最初为 AUDIO 且已经完成升级时是 no-op；初始 VIDEO 通话发送该 op
  必须以 `FEDERATION_MALFORMED` 拒绝。
- 第一个终态获胜。进入 terminal 后收到任何 `declined`、`cancelled`、`missed` 或 `ended` 都返回
  `200/code=0`，不比较 op、`callType` 或 `endReason`，也不改变首次终态。其他迟到 frame 按第 10、11
  节返回 terminal 业务结果，促使发送方停止依赖操作。

## 8. signal payload、阶段与重试

`signal.payload.data` 必须是长度为 1..32768 个 Unicode code point 的字符串。服务器只检查外层类型、
长度、ID 和活动绑定，不能解析、规范化、重新序列化或改写 `data`。

上面的 `JsonText<T>` 是文档中的 wire notation：字段在线上是 JSON string，`T` 是 endpoint 对该字符串
执行 `JSON.parse` 后必须得到的结构。signal 产生方必须生成符合对应结构的内容；联邦服务器即使发现或
怀疑内层内容无效也不得代替 endpoint 拒绝它。endpoint 必须在交给 WebRTC API 或应用状态前验证/解析，
无效内容只终止或忽略本地协商，不能改变服务器已经完成的 signal 幂等结果。

| `kind`        | 方向            | 允许阶段                           | `data` 编码                                 |
| ------------- | --------------- | ---------------------------------- | ------------------------------------------- |
| `offer`       | caller → callee | `ringing`、`accepted`、`connected` | 原始 SDP string                             |
| `answer`      | callee → caller | `accepted`、`connected`            | 原始 SDP string                             |
| `ice`         | 双向            | `ringing`、`accepted`、`connected` | `RTCIceCandidateInit` 的 JSON string        |
| `video-state` | 双向            | `connected`                        | closed `{"enabled":boolean}` 的 JSON string |

一个 `callSid` 同一时刻最多有一个未完成 negotiation。caller 只能在上一轮 answer 已成功应用、
endpoint signaling state 恢复
`stable` 后创建下一轮 offer；callee 每收到一个合法 offer 至多产生一个 answer。

`payload.id` 是端到端幂等键：产生逻辑 signal 的 endpoint 必须生成新 ID，并在重试本地提交时复用它；
caller/callee server 必须将该 ID 原样放入 S2S Call Frame，接收 server 再把同一 ID 原样投递给目标
endpoint，任何一层都不得重新生成或改写。

接收 server 对同一 `(signer domain, callSid, payload.id)` 只处理最先接受的 signal；以后相同 ID 的
signal 无论 body 是否相同都必须返回 `200/code=0` 且不得再次通知 endpoint。目标 endpoint 也必须在调用
WebRTC API 或应用 `video-state` 前，按 `(callSid, payload.id)` 只应用第一次投递。server 和 endpoint 都可
在通话进入 terminal 后释放 seen-ID 集合。生成方负责保证同一 ID 的重试 body 一致；接收方不得通过比较
后续 body 改写或否定已经接受的第一条 signal。WebRTC/JSEP 不提供该应用层去重能力。

ICE 可以相对 offer/answer 乱序到达。联邦服务器不得根据 JSEP 到达顺序拒绝、重排或解释 ICE，只按
外层 binding、shape 和 `payload.id` 执行校验与幂等，并原样转发；endpoint 根据本地 WebRTC signaling
state 缓存、应用。初次协商须等待 callee server 的
`connected` 才表示媒体建链成功。ICE restart 成功不产生生命周期事件；AUDIO→VIDEO 成功后按第 9 节
发送 `video-upgraded`。

## 9. AUDIO→VIDEO

Federation v1 固定 caller endpoint 为所有 offer 的产生方，callee endpoint 为 answer 产生方。这是 SOMS
为避免 offer glare 选择的应用层 profile，不是 RFC 3264 对 offerer 的限制。

callee 想把 AUDIO 通话升级为 VIDEO 时先发送 `video-state {"enabled":true}`；caller 收到请求后创建
新 offer。caller 自己发起时也由 caller 创建 offer。升级期间 offer、answer 和 ICE 的 `callType` 仍为
`AUDIO`。caller endpoint 成功应用对应 answer 后，caller server 才发送：

```json
{
  "callSid": "550e8400-e29b-41d4-a716-446655440000",
  "op": "video-upgraded",
  "callType": "VIDEO"
}
```

callee 不发送 `video-upgraded`，也不在本地 answer 应用后自行提交升级。接收该 frame 后双方当前类型
才变成 VIDEO。关闭摄像头只发送 `video-state`，不把业务类型降回 AUDIO。ICE restart 或不增加视频
媒体的重新协商不得产生 `video-upgraded`。

## 10. Tombstone、重放与重启

接受 `declined`、`cancelled`、`missed` 或 `ended` 后，活动状态立即进入 terminal，并创建有限
tombstone。tombstone 的截止时间是：

```text
min(terminal request 的 Signature-Input.expires,
    接受终态的本地时间 + 300 秒)
```

`300 秒` 是 Federation v1 call tombstone 最大保留窗口。实现可以更早物理清理已经自然过期的条目，
不能把重试请求的新签名期限用于延长首次终态 tombstone。发送方为本地产生的终态使用自己生成的终态
请求 `expires` 计算相同截止时间。

tombstone 至少保存第 7、8 节执行幂等所需的信息。tombstone 存在期间：

- 任何 terminal frame 都是 no-op，且不改变首次终态；
- 已处理 signal ID 是 no-op；
- cancelled tombstone 的新 `incoming` 和其他迟到 frame 返回 `CALL_CANCELLED`；
- 其他 terminal tombstone 的新 `incoming` 和其他迟到 frame 返回 `CALL_TERMINATED`；
- 任何 frame 都不能重新创建或恢复该通话。

服务器重启可以丢失活动媒体状态，但必须保留尚未到期的 tombstone；v1 不提供活动通话恢复操作。
endpoint 在活动状态丢失后依靠本地连接状态结束通话。

callee server 必须分别设置未接听超时和接听后的建链超时；caller server 必须分别设置更长的对应安全
超时。每次进入 `accepted` 必须停止 ring timeout 并新启动 connect timeout。具体时长属于本地参数，
但 caller safety timeout 必须大于对应 callee timeout 加一次 S2S request timeout 和允许的时钟余量。

超时产生的 wire 操作固定如下；首次超时进入 terminal，并按第 6、7 节参与终态竞态：

| 超时                            | 产生方        | 必须发送的 frame |
| ------------------------------- | ------------- | ---------------- |
| callee 未接听超时               | callee server | `missed`         |
| caller 未接听安全超时           | caller server | `cancelled`      |
| callee 接听后媒体未建链超时     | callee server | `ended(timeout)` |
| caller 接听后媒体未建链安全超时 | caller server | `ended(timeout)` |

## 11. 验证顺序、错误与 caller action

接收方必须按以下顺序处理：

1. 验证 trust、HTTP signature、Date/created/expires、digest、Content-Type 和 body size；
2. 验证 closed Call Frame shape 和公共 scalar；
3. 对所有 op 按 `(signer domain, callSid)` 查询已有的活动绑定或 tombstone；
4. tombstone 中的 terminal frame，以及 tombstone 已记录 ID 的 signal retry，返回 `200/code=0`；其他
   frame 返回 `CALL_CANCELLED` 或 `CALL_TERMINATED`；
5. 活动绑定中的重复 `incoming` 按第 7 节判断 retry 或 collision；已记录 ID 的 signal retry 在外层 shape
   合法后返回 `200/code=0`，不再比较后续 body，也不执行方向、阶段和 `callType` 状态校验；
6. 只有全新的 `incoming` 才验证账号与 domain 的绑定、P2P 关系、quota 和 busy，通过后建立活动绑定；
7. 其他新 frame 找到活动绑定后，再验证方向、阶段、callType 和 op-specific 约束；已经经过的 lifecycle
   事件按第 7 节返回 no-op。

未知且无 tombstone 的非 `incoming` 返回 HTTP `200/CALL_NOT_ALLOWED`。该结果不能创建用户、通话、
通知或其他业务状态。活动通话建立后，即使 P2P 关系随后改变，也必须继续允许用于安全终止和收敛的
合法 frame；关系变化不能阻止 `cancelled` 或 `ended`。

错误 body 使用主协议定义的 JSON envelope；实现不能根据 `message` 文本分支。

| 条件                                      | HTTP / code                        | 动作                             |
| ----------------------------------------- | ---------------------------------- | -------------------------------- |
| shape、字段、ID、活动绑定、方向或非法转换 | `400 FEDERATION_MALFORMED`         | 修正后才能重试                   |
| signer 与 `incoming` 发送用户不绑定       | `401 FEDERATION_BINDING_VIOLATION` | 不得原样重试                     |
| 未知 callSid，或参与者关系不允许          | `200 CALL_NOT_ALLOWED`             | 终止本次呼叫，不 demote peer     |
| cancelled 通话的迟到非重复 frame          | `200 CALL_CANCELLED`               | 收敛为 cancelled，不再发送依赖项 |
| 其他 terminal 通话的迟到非重复 frame      | `200 CALL_TERMINATED`              | 收敛为 terminal，不再发送依赖项  |
| callee 已有其他活动通话                   | `200 CALL_BUSY`                    | 终止或以后创建新 `callSid`       |

网络错误和 5xx 可以退避重试完全相同的 frame。HTTP `200` 仍必须解析 envelope；`code=0` 是成功，非零
code 是已处理的业务结果。签名、身份绑定、请求格式和服务故障不是业务结果，继续使用对应 4xx/5xx。

## 12. Call Frame 与签名示例

### 12.1 Lifecycle frame

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

### 12.2 Signal frame

四种完整 signal body 示例：

```json
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"signal","callType":"AUDIO","payload":{"id":"c0a80101-0000-4000-8000-000000000001","kind":"offer","data":"v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"}}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"signal","callType":"AUDIO","payload":{"id":"c0a80101-0000-4000-8000-000000000002","kind":"answer","data":"v=0\r\no=- 77218088 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"}}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"signal","callType":"AUDIO","payload":{"id":"c0a80101-0000-4000-8000-000000000003","kind":"ice","data":"{\"candidate\":\"candidate:1 1 UDP 2122260223 192.0.2.10 54321 typ host\",\"sdpMid\":\"0\",\"sdpMLineIndex\":0}"}}
{"callSid":"550e8400-e29b-41d4-a716-446655440000","op":"signal","callType":"VIDEO","payload":{"id":"c0a80101-0000-4000-8000-000000000004","kind":"video-state","data":"{\"enabled\":true}"}}
```

### 12.3 HTTP Message Signature

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
单行 body 的精确 UTF-8 字节；增加空格或换行后必须重新计算。

## 13. 外部标准来源

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
