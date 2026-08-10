# Federation v1 语音与视频通话

状态：`FINAL`

本文定义 Federation v1 的一对一实时通话协议。除明确标为“非规范性实现说明”的段落外，均为
wire contract。

## 1. 协议栈与边界

Federation v1 不使用 SIP，也不把音视频内容放进 state-feed、message-feed 或 S2S HTTP body。

- **媒体与协商标准**：端点 MUST 实现 WebRTC 1.0 与 JSEP offer/answer 模型；媒体使用 RTP/RTCP，
  网络穿透使用 ICE（可结合 STUN/TURN），密钥协商与媒体保护使用 DTLS-SRTP/SRTP。
- **联邦信令**：服务器之间使用 SOMS 定义的、签名的 `POST /s2s/v1/call` JSON frame。
  WebRTC/JSEP 不规定应用如何传递 SDP、ICE 和呼叫生命周期，因此此层是 Federation v1 wire
  contract，不是另一个外部标准协议。
- **持久历史**：通话结束后的记录是 `message-feed` 中普通 `CALL` message，字段见
  [Message Feed](./message-feed.md)。实时 frame 本身不是历史记录。

SOMS server MUST NOT 解密、转码或混合媒体。端点之间可以直连，也可以通过 TURN relay；TURN 只
转发仍受 DTLS-SRTP/SRTP 保护的媒体，不改变本协议的 server identity 或信令鉴权。

支持 AUDIO 的 WebRTC endpoint MUST 至少支持 Opus、PCMA 和 PCMU。支持 VIDEO 的 endpoint MUST
至少支持 VP8 与 H.264 Constrained Baseline，以满足 WebRTC 音视频互操作基线。端点 MAY 协商其他
共同 codec；SDP 协商失败按连接失败处理。

规范参考：WebRTC 1.0、RFC 8829（JSEP）、RFC 8445（ICE）、RFC 8834/8835（WebRTC media 与
transport）、RFC 8827（安全架构）、RFC 7874（audio codec）和 RFC 7742（video codec）。

## 2. 角色、标识与方向

- **caller / callee**：发起和接收呼叫的用户。
- **call origin server**：caller 的 home server；它创建实时 origin state，并且唯一有权写入终态
  `CALL` message。
- **call mirror server**：callee 的 home server；它维护临时 mirror state、通知 callee，并把动作
  发回 origin。
- **callSid**：caller endpoint 生成的 ULID 或 UUID。它是所有实时 frame 的稳定关联键、重试幂等
  键，也是终态 `CALL` message 的 `clientMessageId`。

`from` MUST 是产生该动作的本地用户，`from.domain` MUST 等于 HTTP signer domain 与 `origin`；
`to` MUST 是另一参与者，并且 `to.domain` MUST 是接收 server。S2S 地址始终使用
`{ account, domain }`，不得暴露实现内部 numeric user ID。

只有已经存在有效 P2P 关系的两个参与者可以建立呼叫。每个实现如何限制同一用户的并发呼叫、如何
展示忙线以及是否提供 TURN，属于本地实现；拒绝结果和状态转换必须保持确定。

## 3. S2S Call Frame

每次请求 body 是一个 closed JSON object：未知字段、错误类型、错误条件字段或非法枚举 MUST 以
malformed request 拒绝。

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

interface Address {
  account: string;
  domain: string;
}

interface CallFrame {
  id: string; // sender 生成的 ULID；单次 frame 的诊断标识
  origin: string; // sender server domain，等于 signer 与 from.domain
  ts: number; // 发送 epoch-ms
  from: Address;
  to: Address;
  callSid: string; // ULID 或 UUID
  op: CallOp;
  callType: CallType;

  kind?: CallSignalKind; // 仅 signal，必选
  payload?: string; // 仅 signal，必选，字符串长度 1..32768
  startedAt?: number; // 仅 connected，必选，epoch-ms
  endReason?: EndReason; // 仅 ended，可选
}
```

`id` 不是 durable delivery sequence。重复 frame 以 `callSid` 和当前状态幂等处理；已经越过的转换
MUST 是 no-op，不能重复通知、重复扣除呼叫 quota 或重复写终态消息。成功 `202` 表示接收 server
已经验证并交给本地呼叫状态机，不表示媒体已经连通。

## 4. 生命周期与状态机

规范状态为 `ringing → accepted → connected → terminal`：

| op               | 合法语义                                      | 状态影响                                 |
| ---------------- | --------------------------------------------- | ---------------------------------------- |
| `incoming`       | caller 发起呼叫并请求 callee server 响铃      | 创建 `ringing` mirror                    |
| `ringing`        | callee endpoint 确认正在向用户提示            | 不改变状态；仅 alerting acknowledgement  |
| `accepted`       | callee 已接听，双方开始或继续协商             | `ringing → accepted`；尚未开始计时       |
| `signal`         | 传递一个 WebRTC 协商 frame                    | 不直接改变生命周期                       |
| `connected`      | 任一 endpoint 确认 DTLS-SRTP media leg 已建立 | `accepted → connected`，固定 `startedAt` |
| `video-upgraded` | 已连接 AUDIO call 完成一次 VIDEO 升级         | `connected` 不变，`callType → VIDEO`     |
| `declined`       | callee 在接听前拒绝                           | `ringing → terminal(declined)`           |
| `cancelled`      | caller 在接听前取消                           | `ringing → terminal(cancelled)`          |
| `missed`         | callee server 的未接听计时到期                | `ringing → terminal(missed)`             |
| `ended`          | 任一方结束已接听呼叫                          | `accepted/connected → terminal`          |

`accepted` 只是用户接听，不是媒体连接回执，也不能设置 `startedAt`。`connected.startedAt` 是双方
终态记录的连接时间权威值；持续时间从它计算。`ended.endReason=completed` 表示正常挂断，`failed`
或 `timeout` 表示协商/连接失败。accepted 后始终未 connected 的结束也形成 failed outcome。

callee server MUST 有未接听超时，origin server SHOULD 有更长的安全超时，以便 peer 崩溃或分区
时仍能终结 origin state。具体秒数是本地实现参数，不是 Federation v1 wire 常量。

## 5. WebRTC 信令 payload

`signal` 是临时 relay，接收 server MUST 把 `kind` 与 `payload` 原样交给目标 endpoint，不得修改
SDP 或 ICE。四种 kind 的 payload 为：

- `offer`：`RTCSessionDescriptionInit.sdp` 字符串；既用于首次协商，也用于后续重协商或 ICE restart。
- `answer`：对应 offer 的 `RTCSessionDescriptionInit.sdp` 字符串。
- `ice`：一个 JSON 序列化的 `RTCIceCandidateInit` object。每个 candidate 单独发送；空 candidate
  可用于端点实现的 end-of-candidates 表达。
- `video-state`：严格 JSON object `{ "enabled": boolean }`，表示发送方当前是否愿意/能够发送
  camera track。它是 UI 与重协商协调信号，不是 `callType` 状态转换。

server MUST 限制 payload 大小，但不应解析或重写 SDP。offer/answer/ICE 可以在生命周期 frame 前后
短暂乱序；实现 MUST 在本地 call state 存在期间暂存建立连接所需的 offer、answer 和 ICE，供离线或
丢失实时通知的 endpoint 恢复。建立连接或进入终态后 MUST 清除暂存。暂存期限、client HTTP/SSE
接口名称属于实现，不属于 S2S wire contract。

## 6. STUN、TURN 与联邦边界

Federation v1 的 ICE 信令原生承载 `host`、`srflx` 和 `relay` candidate。`relay` candidate 仍使用
第 5 节的 `signal(kind='ice')` frame；发送和接收 server MUST 原样中继，不得因为 candidate 来自
TURN、来自另一运营商或 hostname 不属于用户的 home domain 而过滤或改写。

TURN 是 endpoint 的连通性设施，不是 federation peer endpoint：

- 每个 endpoint 从自己的 home server、设备策略或部署配置取得 `RTCIceServer[]`。具体发现接口、
  TURN URI、提供商、REST credential 算法和 credential TTL 不属于 S2S wire contract。
- TURN credential MUST 只发给获得该 allocation 的已认证本地 endpoint，MUST NOT 放入
  `/.well-known/soms`、`/s2s/v1/call`、state-feed、message-feed 或 SDP/ICE payload。
- peer server 不需要也不得要求另一个 server 为其用户签发“联邦 guest credential”。远端 endpoint
  通过 ICE 与已发布的 relay candidate 建立连接；它可以同时使用自己 home server 提供的 TURN。
- 实现 MAY 不部署 TURN，仍然符合 Federation v1；此时 hard-NAT 或防火墙环境可能无法连通，并按
  普通 `failed`/`timeout` 终结。v1 不进行 TURN capability negotiation，也不得据此改变 call frame。
- 部署方增加、更换或同时配置多个 TURN 服务不改变协议版本、callSid、身份或状态机，无需增加新的
  S2S endpoint。选择 relay-only ICE policy 也是 endpoint 的本地隐私策略。

TURN relay 只转发受 DTLS-SRTP/SRTP 保护的媒体。使用 TURN 不授权 relay 或 federation server
解密、转码、录制或从媒体内容推导协议状态。

## 7. AUDIO 升级 VIDEO

Federation v1 允许已进入 `connected` 的 AUDIO call 在**同一个 `RTCPeerConnection` 和同一个
`callSid`** 上升级为 VIDEO，不创建第二次呼叫。

规范序列为：

1. 发起升级的 endpoint 获取 camera track，把它加入现有 peer connection，并发送
   `video-state {enabled:true}`。
2. 双方必须避免 offer glare。v1 的确定规则是：**原始 caller endpoint 是升级重协商的 offerer**。
   如果 callee 请求升级，caller 收到 `video-state enabled=true` 后创建 offer；如果 caller 请求，
   它直接创建 offer。
3. caller 发送包含 video m-section 的 `offer`；callee setRemoteDescription、createAnswer 后发送
   `answer`；双方按普通 `ice` 流程补充 candidate。
4. offer/answer 应用成功后，任一参与 server 可以提交幂等升级。server 把 live `callType` 从
   `AUDIO` 改为 `VIDEO`，向 peer 发送 `video-upgraded`，该 frame 的 `callType` MUST 是 `VIDEO`。
5. 双方收到重复 `video-upgraded` MUST no-op；最终终态 `CALL` message 的 `callType` MUST 是
   `VIDEO`。

升级是单向且永久的业务分类转换：`AUDIO → VIDEO`，v1 没有 `VIDEO → AUDIO` downgrade op。升级后
任一方关闭 camera 只发送 `video-state {enabled:false}` 并停止/禁用自己的 video track；audio 继续，
call 的 `callType` 仍为 `VIDEO`。重新开启 camera 可以再次重协商，但不能产生新的 call 或重复历史。

初始即为 VIDEO 的 call 不需要 `video-upgraded`。在 `ringing` 或 `accepted` 状态提交升级 MUST 被
拒绝；此时想建立初始 VIDEO 必须由最初 `incoming.callType=VIDEO` 与首次 SDP 协商表达。

## 8. 可靠性、安全与隐私

- 所有 `/s2s/v1/call` 请求 MUST 使用主协议规定的 pinned peer HTTP Message Signature；signer、
  `origin`、`from.domain` 和接收 domain 必须绑定。
- server MUST 验证参与者、现有 P2P 关系、frame closed schema、条件字段、payload 上限和 signal
  quota，再转交本地 endpoint。frame 不得绕过本地 call state machine 注入任意用户。
- lifecycle 与 signal 是实时 transient data，不进入两个 feed。网络错误允许在状态仍适用时重试；
  ICE 丢失由 trickle ICE 重发、重新收集或 ICE restart 恢复。
- SDP 和 ICE 会暴露设备能力及候选网络地址。server 与日志 SHOULD 最小化保存；除短期建立连接
  恢复外不得把 payload 作为消息历史持久化。
- 终态由 origin server 以一个 `CALL` message 持久化；mirror server 通过 message-feed 拉取。
  `(caller, callee, callSid)` 不得产生两条终态记录。

## 9. 非规范性 SOMS 实现说明

当前 SOMS 用 client HTTP command 与 SSE 事件连接 endpoint 和本地 server；S2S 实时状态驻留内存，
offer/answer/ICE 在 call 存活期间提供一次本地恢复读取。callee 响铃超时为 45 秒，origin 安全超时
为 60 秒。

SOMS 已实现本地 `GET /api/v1/calls/ice-servers`：Web 与 Android endpoint 在创建
`RTCPeerConnection` 前读取它；配置 `SOMS_STUN_URLS` 可返回 STUN，完整配置 `SOMS_TURN_URLS` 与
`SOMS_TURN_REST_SECRET` 可按用户签发 coturn TURN REST 短期 credential，默认 TTL 为一小时。只配置
URL 或 secret 之一会作为部署错误失败。仓库当前不内置或自动部署 coturn，正式部署模板也不默认
启用 TURN，因此这是已有的接入能力，不是开箱即用的 relay 服务。

这些 client 接口命名、环境变量、HMAC credential 方案、存储模型和数值均不是其他 Federation v1
实现必须复制的标准。
