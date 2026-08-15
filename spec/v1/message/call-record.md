# `CALL` Message Record

状态：`RELEASE CANDIDATE`（`v1.0-rc.2`）

本文定义 P2P timeline 中持久化的通话终态记录。它不是实时 signaling payload：ringing、SDP、ICE 和
transient lifecycle 只通过 `/s2s/v1/call` 传输。共用消息外层结构见
[Message Envelope](./envelope.md)，实时状态机见 [Calls](../calls.md)。

## 1. Content schema

```ts
type CallMediaType = 'AUDIO' | 'VIDEO';

type CallOutcome =
  | 'completed'
  | 'cancelled'
  | 'declined'
  | 'missed'
  | 'failed'
  | 'unreachable';

interface UnconnectedCallRecordContent {
  callType: CallMediaType;
  status: CallOutcome;
  endedAt: EpochMilliseconds;
}

interface ConnectedCallRecordContent {
  callType: CallMediaType;
  status: 'completed' | 'failed';
  startedAt: EpochMilliseconds;
  endedAt: EpochMilliseconds;
}

type CallRecordContent =
  | UnconnectedCallRecordContent
  | ConnectedCallRecordContent;
```

两个分支都是 closed schema。`startedAt` 是条件必填字段：已接受合法 `connected.startedAt` 时必填，
否则禁止。duration 由 consumer 计算，不在 wire 中重复传输。

## 2. Outcome 与字段矩阵

| `status` | 未 connected | 已 connected | 说明 |
| -------- | ------------ | ------------ | ---- |
| `completed` | 允许 | 允许 | accepted 后可以在媒体连接前正常结束，也可以连接后结束 |
| `failed` | 允许 | 允许 | 连接前或连接后的失败 |
| `cancelled` | 允许 | 禁止 | caller 在连接前取消 |
| `declined` | 允许 | 禁止 | callee 拒绝 |
| `missed` | 允许 | 禁止 | 无应答超时 |
| `unreachable` | 允许 | 禁止 | 没有可发送或可接受的远端 lifecycle frame |

所有 outcome 都必须有 `endedAt`。已 connected 时还必须满足：

```text
endedAt >= startedAt
durationMs = endedAt - startedAt
```

上式的 `durationMs` 是本地派生值，不是 content 字段。

业务时间由生成终态记录的 publisher 断言，不参与跨服务器排序。

## 3. 消息外层结构约束

- thread 必须是 P2P，且恰好包含 caller 和 callee 两个不同 Address。
- 消息外层结构的 `author` 是 caller；callee 是另一个 participant。
- content 不得重复传输 caller、callee 或数据库 user ID。
- `clientMessageId` 必须是非 null `CanonicalUuid` call SID。
- `assets` 必须为空。

实时 call operation 到终态记录的映射如下：

- `ended(completed)` → `completed`
- `ended(timeout|failed)` → `failed`
- `declined/cancelled/missed` → 同名 outcome
- 没有可用远端 lifecycle frame 的本地权威失败路径 → `unreachable`

## 4. Connected 完整示例

```json
{
  "thread": {
    "type": "P2P",
    "participants": [
      { "account": "alice", "domain": "a.example" },
      { "account": "bob", "domain": "b.example" }
    ]
  },
  "author": { "account": "alice", "domain": "a.example" },
  "seq": 81,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000061000,
  "clientMessageId": "018f0f4e-7b2a-7c3d-8e9f-0123456789ab",
  "contentType": "CALL",
  "content": "{\"callType\":\"VIDEO\",\"status\":\"completed\",\"startedAt\":1770000000000,\"endedAt\":1770000060000}",
  "assets": []
}
```

## 5. 未 connected 完整示例

```json
{
  "thread": {
    "type": "P2P",
    "participants": [
      { "account": "alice", "domain": "a.example" },
      { "account": "bob", "domain": "b.example" }
    ]
  },
  "author": { "account": "alice", "domain": "a.example" },
  "seq": 82,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000100000,
  "clientMessageId": "018f0f4e-7b2a-7c3d-8e9f-1123456789ab",
  "contentType": "CALL",
  "content": "{\"callType\":\"AUDIO\",\"status\":\"declined\",\"endedAt\":1770000099000}",
  "assets": []
}
```

## 6. 必须拒绝

consumer MUST 拒绝至少以下情况：

- CALL 位于 GROUP thread；
- `clientMessageId` 为 null 或不是 `CanonicalUuid`；
- `callType/status/endedAt` 缺失或不合法；
- `endedAt < startedAt`；
- content 携带派生字段 `durationMs`；
- `cancelled/declined/missed/unreachable` 携带 connected 字段；
- content 携带 caller、callee、数据库 ID 或未知字段；
- 消息外层结构的 `assets` 非空。

## 7. 非规范性实现说明

实现可以在 S2S 边界把 caller/callee Address 投影为接收节点自己的内部 user ID 后再保存本地 CALL
气泡，以兼容现有客户端。这些本地字段不属于 federation wire。
