# Federation v1 State Feed

状态：`FINAL`
规范性：本文全部为规范性要求，除非段落明确标记为“非规范性实现说明”。

本文定义 `GET /s2s/v1/state-feed` 的完整 wire schema 与合并语义。通用身份、签名、错误和
cursor 规则见 [主协议](./protocol.md)。

## 1. 请求与 Page

请求 query：

| 字段    | 类型             | 要求 |
| ------- | ---------------- | ---- |
| `after` | decimal string   | 必选；consumer 已提交的排他 cursor，最小为 `"0"`。 |
| `take`  | positive integer | 可选；期望的最大 item 数。publisher MAY 以确定的 malformed/limit 错误拒绝不支持的值。 |

成功 envelope 的 `data` MUST 是：

```ts
interface StateFeedPage {
  items: StateFeedItem[];
  scannedThrough: DecimalString;
  stateFeedRev: DecimalString;
  hasMore: boolean;
}
```

- `stateFeedRev` 是本页事务开始时冻结的 source HWM。
- `scannedThrough` 是 consumer 在完整验证并提交本页副作用后可以提交的 cursor。
- `hasMore` 为 `true` 时，下一页 MUST 使用本页 `scannedThrough`；为 `false` 时
  `scannedThrough` MUST 等于 `stateFeedRev`。
- page 可以为空；空的最终 page 仍可把 cursor 推进到 `stateFeedRev`。

## 2. 通用 Item

```ts
type StateEventType =
  | 'PROFILE'
  | 'P2P_META'
  | 'GROUP_META'
  | 'GROUP_INVITE_INTENT'
  | 'GROUP_JOIN_INTENT';

interface StateFeedItem {
  account: string;
  eventType: StateEventType;
  subjectAccount: string;
  revision: DecimalString;
  rev: DecimalString;
  body: StateBody;
}
```

| 字段 | 含义 |
| ---- | ---- |
| `account` | 状态主体在其 domain 内的 account。群 account 以 `!` 开头。 |
| `eventType` | 本文定义的五种事件之一。 |
| `subjectAccount` | 方向事件的另一端；非方向快照必须是空字符串 `""`。 |
| `revision` | stable key 的业务版本，非负十进制字符串。 |
| `rev` | publisher 对目标 peer 分配的 feed 顺序，正十进制字符串。 |
| `body` | 由 `eventType` 判别的 JSON object。 |

stable key 是 `(account, eventType, subjectAccount)`。publisher MUST 只在该 key 的业务
`revision` 严格增加时分配新 `rev`；相同或更旧 revision MUST 是 no-op。consumer MUST 按 stable
key 幂等合并，不得用 `rev` 代替业务 revision。

`PROFILE`、`GROUP_META` 的 `subjectAccount` MUST 是 `""`；其他三种方向事件 MUST 是非空 account。
publisher MUST NOT 发出未列出的 `eventType` 或 body 字段。consumer MUST 拒绝会改变权限或状态机
含义的未知类型；普通响应 envelope 的纯附加诊断字段仍按主协议兼容规则忽略。

## 3. 通用数据类型

```ts
interface Address {
  account: string;
  domain: string;
}

interface Avatar {
  digest: Sha256Hex;
  mimeType: string;
  base64: string;
}
```

- 所有应用层时间均为非负安全整数 Unix epoch milliseconds；没有值时使用 JSON `null`，不得使用
  ISO 字符串、秒时间戳或缺省值表达同一个状态。
- `Avatar.digest` MUST 等于严格 base64 解码后 bytes 的 SHA-256；`mimeType` MUST 是非空 MIME
  string。`avatar: null` 表示明确没有头像。
- address 的 `domain` 是 identity，不得根据拉取来源隐式替换；relay profile 仍携带其原 domain。

## 4. `PROFILE`

```ts
interface ProfileBody {
  domain: string;
  name: string;
  bio: string;
  avatar: Avatar | null;
  deleted: boolean;
}
```

`account` 与 `body.domain` 共同标识 profile。直接 profile 的 domain 等于签名 publisher；群 origin
可以向已有群 audience relay roster member 的 profile，但 consumer MUST 先证明该 relay 由该 origin
群的当前 roster 授权。`deleted: true` 是 profile tombstone，不得解释为 peer identity reset。

## 5. `P2P_META`

```ts
type P2PStatus = 'REQUESTED' | 'FRIEND' | 'NOT_FRIEND';

interface P2PMetaBody {
  status: P2PStatus;
  note: string;
  requestedAt: EpochMilliseconds | null;
  expiresAt: EpochMilliseconds | null;
}
```

- `account` 是 publisher 一侧用户，`subjectAccount` 是接收 server 的本地用户。
- `REQUESTED` 时 `requestedAt` 与 `expiresAt` MUST 均非空，并且 `expiresAt > requestedAt`。
- `FRIEND` 与 `NOT_FRIEND` 时 `expiresAt` MUST 是 `null`；`requestedAt` MAY 保存本方向最近请求时间，
  没有时为 `null`。
- `note` MAY 为空；它只描述该方向，不授予权限。
- P2P 关系只有双方各自最新方向均为 `FRIEND` 时成立。

## 6. 群成员方向

两个方向共享：

```ts
type MembershipStatus = 'REQUESTED' | 'MEMBER' | 'NOT_MEMBER';

interface MembershipIntentBase {
  status: MembershipStatus;
  note: string;
  requestedAt: EpochMilliseconds | null;
  expiresAt: EpochMilliseconds | null;
}
```

`account` 是 origin-owned 群 account，`subjectAccount` 是成员 account。

### 6.1 `GROUP_INVITE_INTENT`

群 origin 向成员 server 发布 `INVITE` 方向：

```ts
interface GroupInviteIntentBody extends MembershipIntentBase {
  owner: Address;
  sinceSeq: number;
}
```

- `owner` 是创建 mirror 所需的当前 owner identity。
- `sinceSeq` 是非负安全整数，或 `-1` 表示不要求既有历史；它是 message pull lower-bound 提示，
  不是 feed cursor。
- `REQUESTED` 时 `requestedAt` 和 `expiresAt` MUST 非空，且 expiry 晚于 request。
- 非 `REQUESTED` 状态的 `expiresAt` MUST 是 `null`。

### 6.2 `GROUP_JOIN_INTENT`

成员 server 向群 origin 发布 `JOIN` 方向：

```ts
interface GroupJoinIntentBody extends MembershipIntentBase {}
```

该 body MUST NOT 包含 `owner` 或 `sinceSeq`。`REQUESTED` 时 `requestedAt` MUST 非空；
`expiresAt` MAY 为 `null`，表示由 origin 本地策略决定等待期限。该方向本身不能证明入群成功。

双方方向收敛后，最终权限仍必须等待 origin 发布的 `GROUP_META` roster 确认。

## 7. `GROUP_META`

```ts
type GroupRole = 'OWNER' | 'ADMIN' | 'MEMBER';

interface GroupMetaBody {
  active: boolean;
  dissolved: boolean;
  owner: Address;
  members: Array<Address & { role: GroupRole }>;
}
```

- 只有群 identity 的 pinned origin 可以发布该事件。
- `members` 是完整 roster replacement，不是增量 patch；同一 address 不得重复。
- 未解散的 active roster MUST 恰好包含一个 `OWNER`，并与 `owner` 相同。
- `dissolved: true` 时 `active` MUST 为 `false`。
- `active` 表示目标 peer 当前是否仍有该群的 audience；`false` 会撤销该 peer 的未来消息 allocation，
  但不会抹除已经交付的历史 proof。
- consumer 必须以最新 `revision` 的完整 roster 原子替换 mirror 成员、角色和 owner。

## 8. 排序、恢复与安全

同一 page 内，consumer MAY 为满足依赖而按 `GROUP_META → PROFILE → membership intent → P2P_META`
排序应用，但只有整个 page 成功时才能提交 `scannedThrough`。任何 item malformed、identity 不一致或
权限校验失败，整个 page 与 cursor MUST 回滚。

revision hint 不携带上述任何业务 body，也不能代替 state-feed。重启、提示丢失、重复 page、乱序
hint 或 compacted 中间 revision 缺失，都必须通过 stable key 最新快照得到同一结果。

### 非规范性 SOMS 实现说明

SOMS 在写 `PeerStateFeed` JSONB 前复用全局 `serializeBody()`，因此 `Date` 与 HTTP/SSE 一样统一为
epoch-ms、`BigInt` 统一为十进制字符串。数据库表名、事务实现和序列化 helper 不属于协议要求。
