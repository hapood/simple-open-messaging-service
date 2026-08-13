# SOMS Federation v1 State Feed

状态：`REVIEW`
规范性：本文全部为规范性要求，除非段落明确标记为“非规范性实现说明”。

本文定义 `GET /s2s/v1/state-feed` 的请求、可靠分页、状态事件、合并与授权语义。通用身份、
签名、响应和错误规则见 [主协议](./protocol.md)。State feed 承载必须最终收敛的元数据；它不得
采用 message feed 的过期或截断规则，三个 feed 都禁止 consumer fast-forward。

## 1. 请求

请求 query 是 closed 参数集合：

| 字段      | 类型                               | 要求                                                                                           |
| --------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `after`   | `SignedDecimalString` query string | 可选；consumer 已原子提交的 exclusive cursor；省略时只返回 `resumeAfter`，不返回 page。        |
| `take`    | `PositiveSafeInteger` query string | 可选；consumer 建议的本页扫描数。publisher SHOULD 参考，但 MAY 按负载、item 大小和公平性调整。 |
| `through` | `SignedDecimalString` query string | 可选；本轮扫描的 inclusive 上界，MUST 大于或等于 `after`。连续有界分页 MUST 保持同一个值。     |

`take` 不是返回 item 数或响应 bytes 的安全承诺。publisher MUST 设置公开、确定的 item 和 page
上限；请求值不受支持时返回 `FEDERATION_MALFORMED`，单个合法状态快照超过 operation 上限时返回
`FEDERATION_PAYLOAD_TOO_LARGE`。`through` 只冻结读取窗口，不确认、删除或降级任何状态。

省略 `after` 时不得携带 `take` 或 `through`。source MUST 返回 HTTP `200`
`FEDERATION_FEED_CURSOR_UNAVAILABLE`，data 只含当前可用 exclusive cursor `resumeAfter`。consumer 原子
保存后以 `after=resumeAfter` 开始正常读取；不得猜测初始 ID。协议不规定 state feed 的初始 ID 或连续性。

## 2. Page 与可靠 cursor

成功 envelope 的 `data` MUST 是以下 closed object：

```ts
interface StateFeedPage {
  items: StateFeedItem[];
  scannedThrough: DecimalString;
  stateFeedEndId: DecimalString;
  hasMore: boolean;
}
```

publisher 在请求事务开始时冻结 source allocation upper bound `stateFeedEndId`，并计算：

```text
scanEnd = through is present ? min(stateFeedEndId, through) : stateFeedEndId
```

每个成功 page MUST 满足：

1. `after <= scannedThrough <= scanEnd <= stateFeedEndId`；
2. 每个 `item.feedId` 位于 `(after, scannedThrough]`，并按数值严格递增；
3. `hasMore` 当且仅当 `scannedThrough < scanEnd`；
4. `hasMore: true` 时 `scannedThrough > after`；
5. `hasMore: false` 时 `scannedThrough === scanEnd`；
6. page 可以没有 item；空洞和 compacted key 不阻止 `scannedThrough` 前进；
7. 同一 stable key 在 page 中最多出现一次。

consumer MUST 完整验证 page，并在同一事务中提交全部副作用与 `scannedThrough`。任一 item malformed、
identity/binding 不一致或授权失败时，整个 page 与 cursor MUST 回滚。`hasMore: true` 时下一页 MUST
使用本页 `scannedThrough`；有界排空还 MUST 复用原 `through`。

### 2.1 Source 确认与防 fast-forward

publisher MUST 为每个 peer 持久保存 state feed 已确认位置和最后一次已服务位置。设二者分别为
`acknowledgedThrough` 和 `lastServedThrough`，则只接受：

- `after === acknowledgedThrough`：首次读取，或重放尚未确认的 page；
- `after === lastServedThrough`：确认上一 page 并继续读取。

采用 bootstrap `resumeAfter` 后的首次请求也合法；当两个确认值相等时两种情况等价。其他 `after` MUST
返回 `FEDERATION_FEED_CURSOR_MISMATCH`，不得把请求值当成确认，不得推进、删除或跳过任何状态。重放尚未
确认 page 时，publisher MUST 再次返回相同的 `scannedThrough` 以及语义相同的截至该边界的 stable-key
投影；后续 revision 不得越过冻结边界替代重放内容。

publisher MUST 可靠保存每个 stable key 的最新快照以及尚未确认的删除/撤销终态。state feed 不存在
retained floor 自动前跳；不得因容量、时间、重启或本地修复静默丢弃 peer 尚未确认且仍为最新的状态。
publisher 分配的新 `feedId` MUST 大于该 peer 历史上分配的所有 `feedId`，且不得复用。

当 publisher 已经对外形成包含 state 上界 `S` 的 drain barrier 时，在该 barrier 被确认前，任一
`state-feed?through=S` 排空都 MUST 能重建截至 `S` 的有效 stable-key 投影。某 key 后来被 `feedId>S` 的版本
覆盖，不得导致它在 `S` 所需的最后版本消失。publisher 可以保留版本行、冻结 page 或使用其他等价机制；
只原地覆盖唯一快照而不保留 barrier-visible 版本不满足本要求。已经被更高且仍不超过 `S` 的 revision
覆盖的中间版本可以 compact。

consumer 收到 cursor mismatch 时 MUST 保留本地 cursor：若它等于响应中的已确认位置或最后服务位置，
可以用该值恢复；否则 MUST 停止自动同步并进入管理员恢复流程，不得自行采用 source allocation upper bound。普通 peer
identity reset、重新建联和 cursor 丢失的恢复不属于本 operation。

## 3. 通用 Item 与身份

```ts
type StateEventType =
  | 'PROFILE'
  | 'MEMBER_PROFILE'
  | 'P2P_INTENT'
  | 'GROUP_INVITE_INTENT'
  | 'GROUP_JOIN_INTENT'
  | 'GROUP_META';

interface StateFeedItem {
  account: Account;
  domain: Domain;
  eventType: StateEventType;
  subjectAccount: Account | '';
  subjectDomain: Domain | '';
  revision: DecimalString;
  feedId: PositiveDecimalString;
  body: StateBody;
}
```

所有 item 和 body 都是 closed object。stable key 是：

```text
(domain, account, eventType, subjectDomain, subjectAccount)
```

`revision` 是该 stable key 的业务版本。publisher 只在 `revision` 严格增加时分配新 `feedId`；相同或更旧
revision 是完整 no-op。consumer 按 stable key 与 `revision` 幂等合并，不得用 `feedId` 代替业务
revision。consumer 已保存相同 revision 但收到语义不同 body 时 MUST 拒绝 page，并记录协议冲突。

`PROFILE`、`MEMBER_PROFILE`、`GROUP_META` 的 subject 两字段 MUST 都是 `""`。三个 intent 的 subject
两字段 MUST 构成完整非空 `Address`。事件绑定如下：

| event                 | `account/domain` | `subjectAccount/subjectDomain` | signer 要求                                                                                    |
| --------------------- | ---------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `PROFILE`             | 资料主体         | 空                             | `domain` MUST 等于 signer domain。                                                             |
| `MEMBER_PROFILE`      | 人员资料主体     | 空                             | signer 是该 source-scoped 快照的 publisher；主体可以来自第三方 domain。                        |
| `P2P_INTENT`          | 本方向 actor     | 另一方                         | actor domain MUST 等于 signer，subject domain MUST 等于 consumer。两端都必须是 `UserAccount`。 |
| `GROUP_INVITE_INTENT` | origin-owned 群  | 被邀请成员                     | 群 domain MUST 等于 signer，成员 domain MUST 等于 consumer。                                   |
| `GROUP_JOIN_INTENT`   | origin-owned 群  | 申请成员                       | 群 domain MUST 等于 consumer，成员 domain MUST 等于 signer。                                   |
| `GROUP_META`          | origin-owned 群  | 空                             | 群 domain MUST 等于 pinned signer/origin。                                                     |

## 4. 展示资料类型与最小披露

```ts
interface ProfileAvatar {
  digest: Sha256Hex;
  mimeType: string;
  base64: string;
  width: PositiveSafeInteger;
  height: PositiveSafeInteger;
}
```

`base64` MUST 是无空白的 RFC 4648 padded Base64，严格解码后必须是非空图片 bytes；`digest` MUST
等于这些 bytes 的 SHA-256。`width`、`height` MUST 等于解码图片的实际尺寸，且乘积不得超过
`16000000`。`mimeType` MUST 是与实际图片格式一致的非空 MIME string。

`displayName` 是 1–30 个 Unicode code point，`bio` 是 0–120 个 Unicode code point；二者不得含未配对
surrogate。展示字段、头像和简介都不得授予身份、关系、群成员资格、消息或资源权限。

### 4.1 `PROFILE`

`PROFILE` 是 identity home server 向具有直接资料可见性的 peer 发布的完整账号资料。主体可以是
`UserAccount`（精确 P2P 建立或现有 P2P 关系）或 origin-owned `GroupAccount`（群邀请或群 audience）：

```ts
interface ProfileBody {
  displayName: string;
  bio: string;
  avatar: ProfileAvatar | null;
  deleted: boolean;
}
```

`revision` 是该主体的 profile revision。`deleted: true` 是账号资料 tombstone；它不重置 server identity，
也不自动撤销已经独立发布的关系方向。publisher MUST 只向当前存在直接 P2P/群资料可见性，或为建立
精确 P2P 请求、群邀请 mirror 所必需的目标 peer 分配该资料。

精确用户查询与本事件是不同的披露场景。`GET /users/:account` 只返回资源规范定义的最小公共身份卡，
不得因为 `PROFILE` 包含 `bio` 或 tombstone 状态而扩大查询响应。

### 4.2 `MEMBER_PROFILE`

`MEMBER_PROFILE` 表示目标 peer 因共享群等明确来源需要保存的人员展示资料；它不表示该人员属于某个
特定群。实际 roster 只能由 `GROUP_META.members` 表达。

```ts
type MemberProfileBody =
  | {
      availability: 'AVAILABLE';
      displayName: string;
      avatar: ProfileAvatar | null;
    }
  | {
      availability: 'REMOVED';
    };
```

publisher MUST 为每个 `(target peer, member Address)` 维护完整的当前可见性来源集合：

- 第一个来源出现时发布 `AVAILABLE`；
- 仍有至少一个来源时，新增或删除其他来源不得发布 `REMOVED`；
- 最后一个来源消失时发布 `REMOVED`；
- 人员资料 revision 增加时，只向仍有来源的 peer 发布新的 `AVAILABLE`；
- `REMOVED` 必须作为可靠 tombstone 保留到目标 peer 确认，不能依赖 GC 表达撤销。

来源集合是权威事实；来源数量只能从集合衍生，不得作为另一份独立权威。具体表、引用计数缓存或 GC
实现不属于协议要求。

consumer MUST 按 `(signer domain, member Address)` 隔离保存快照。由不同 signer 发布的同一人员可以分叉，
不得按人员 Address 或 profile revision 跨 signer 合并。展示某个 origin-owned 群时，consumer MUST 使用该
origin 发布的 source-scoped `MEMBER_PROFILE`；快照不存在或已 `REMOVED` 时可以回退显示规范化 Address，
但不得向其他 publisher 的快照取值。历史消息的 author Address 必须保留；删除展示快照不得删除消息。

## 5. 统一方向意图

P2P、群邀请和群申请共享同一方向状态：

```ts
type IntentStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';

interface IntentBody {
  status: IntentStatus;
  note: string;
  requestedAt: EpochMilliseconds | null;
  expiresAt: EpochMilliseconds | null;
}

interface P2PIntentBody extends IntentBody {
  messageFeedEndId?: SignedDecimalString;
}
```

- `REQUESTED` 表示本方向当前有效地请求或同意建立关系；`requestedAt` MUST 非空。
- `ACCEPTED` 表示本方向已经观察并确认双方流程的成功结果；`expiresAt` MUST 是 `null`。
- `REVOKED` 表示本方向拒绝、撤回或终止；`expiresAt` MUST 是 `null`。
- `note` 只描述本方向，不授予权限，最多 255 个 Unicode code point。
- expiry 只使 `REQUESTED` 失去效力，不隐式增加 revision；publisher SHOULD 产生更高 revision 的
  `REVOKED` 使持久状态最终收敛。

`P2P_INTENT` 与 `GROUP_INVITE_INTENT` 的 `REQUESTED` 必须有非空 `expiresAt`，并满足
`expiresAt > requestedAt`。`GROUP_JOIN_INTENT` 的 `expiresAt` MAY 是 `null`，表示由 origin 的本地准入
策略决定等待期限。

### 5.1 P2P

P2P 关系只有双方最新方向都为 `ACCEPTED` 时成立。收到对方有效 `REQUESTED` 时，已有有效本地方向的
实现可以把本方向推进为 `ACCEPTED` 并回传；双方交叉请求必须通过 stable key revision 幂等收敛。任一方
发布 `REVOKED` 后关系立即失效，并停止该已关闭 audience 的未来 P2P message allocation；另一方向不会
因此被伪造成该方 author 的状态。

`P2P_INTENT(REVOKED)` MUST 携带 `messageFeedEndId`，其他状态 MUST 省略。该字段与
`feed-heads.messageFeedEndId` 使用完全相同的 per-peer message-feed ID 空间：它是在关闭
该方向 audience 的原子提交中，已经向目标 peer 分配并可见的整个 message feed 上界，使用
`SignedDecimalString` 编码且为 inclusive。它不是 thread `seq`、该 P2P thread 最后一条消息的 ID 或整个
feed 的永久终点；该位置可以属于其他 thread 或空洞，但不属于独立的 tombstone feed。

包含关系必须按数值判断：属于该次已关闭关系且 `feedId <= messageFeedEndId` 的既有 allocation 位于历史
边界内；`feedId > messageFeedEndId` 的 allocation 不能由该次已关闭关系授权。等于上界的 ID 被包含，但
不表示该 ID 一定存在或一定属于这个 P2P thread。

关闭 audience 与取得 `messageFeedEndId` 必须处于同一串行化边界。提交后，publisher 不得再以该次已关闭
关系为依据分配更大 feed ID 的 message。解除前尚未进入目标 peer 可见 feed 的积压消息不要求为了扩大
该边界而强制分配。以后更高 revision 的 `ACCEPTED` 可以重新开放 audience，并授权新的、更大 feed ID。

consumer 即使未观察到已被压缩的中间 `ACCEPTED`，也可以用该边界为 publisher 方向建立只读历史上下文，
但不得恢复当前好友关系或发送权限。consumer 仍可依据自己的方向状态和本地安全策略拒绝、隔离或丢弃
单条消息；该决定不得阻塞同页其他消息或 durable feed cursor。

### 5.2 群邀请与申请

`GROUP_INVITE_INTENT` body 额外携带创建惰性 mirror 所需的当前 owner：

```ts
interface GroupInviteIntentBody extends IntentBody {
  owner: Address;
}
```

`owner` 必须是 origin domain 托管的 `UserAccount`。`GROUP_JOIN_INTENT` body 就是 closed
`IntentBody`，不得包含 `owner`、历史消息边界或 feed cursor。

一个有效 invite `REQUESTED` 与一个有效 join `REQUESTED` 收敛后，origin MAY 执行容量、封禁等本地准入
检查。准入成功后，origin 发布更高 revision 的 invite `ACCEPTED` 和权威 `GROUP_META`；member server
观察到包含该成员的权威 roster 后发布更高 revision 的 join `ACCEPTED`。任一方向 `REVOKED` 都阻止新的
准入或要求 origin 撤销现有成员，但群权限的最终事实始终是 `GROUP_META`，intent 本身不得授权消息、
媒体或群资源。

## 6. `GROUP_META`

```ts
type GroupRole = 'OWNER' | 'ADMIN' | 'MEMBER';

interface GroupMetaBody {
  active: boolean;
  dissolved: boolean;
  owner: Address | null;
  membersCanInvite: boolean;
  members: Array<Address & { role: GroupRole }>;
}
```

`revision` 是 origin 对该群分配的 roster revision。`members` 是完整 replacement，不是 patch，并 MUST
按 `(domain ASCII ascending, account ASCII ascending)` 排序；Address 必须唯一。排序只提供确定性编码、
查重和测试，不赋予数组位置业务含义。

未解散群必须恰好包含一个 `OWNER`，且与非空 `owner` 相同；owner MUST 由 origin domain 托管。
`dissolved: true` 时 `active` MUST 为 `false`、`owner` MUST 为 `null`、`members` MUST 为空。

`active` 是该 target peer 的服务器级 audience 投影：当且仅当未解散 roster 至少包含一个由 target peer
托管的成员时为 `true`。Federation v1 不在同一 peer 内为不同本地成员提供传输级或密码学历史隔离；
consumer 可以执行更严格的本地展示策略，但不得把它解释成 origin 可验证的成员级访问控制。

publisher MUST 在同一原子提交中形成目标 peer 的权威 `GROUP_META` 更新和对应群消息 audience 开放或
关闭事实。依赖新 audience 的 message-feed allocation 只能在该提交成功后发生。consumer MUST 先提交
state-feed，再处理随后拉取的数据 feed。

`active: false` 撤销未来 allocation，但不得使已经在有效 audience 期间合法分配给该 peer 的消息失效。
publisher 必须持久保存足以在重启、重复拉取及 audience 关闭后重建这些合法 allocation 的授权事实，
不得只根据当前 roster 判断已经分配的消息是否仍可交付。具体锁、内部 thread seq 和存储结构
不属于协议要求。

## 7. 应用、恢复与安全

consumer MUST 先按 wire `feedId` 验证 page、身份、binding 和每个 stable key revision。全页验证成功后，
可以为满足外键依赖按 `GROUP_META → PROFILE/MEMBER_PROFILE → intent` 的顺序物化本地投影；重排不得改变
授权结果或把较旧 revision 覆盖到较新 revision。

`MEMBER_PROFILE` 的授权在 publisher 分配时由其当前可见性来源决定。consumer 不得因同页或更高 revision
的 `GROUP_META` 已移除该 member 而拒绝先前合法分配的 `AVAILABLE`；最终 `REMOVED` 通过自身 stable key
收敛。malformed、signer binding 错误或跨 signer 合并仍必须使整页失败。

feed-head hint 不携带任何业务 body，也不能代替 state-feed。重启、提示丢失、重复 page、乱序 hint、
compacted 中间 revision 缺失和 page 重排，都必须通过 stable key 最新快照得到同一最终投影。

### 非规范性实现说明

SOMS 可以用关系方向表共享 P2P、invite 和 join 的 revision/expiry 状态机，同时保留不同关系种类的本地
外键。人员可见性适合以 `(peer, member, sourceType, sourceId)` 唯一来源行表达；是否存在来源通过
`EXISTS` 或可重建缓存计算。数据库表名、事务 helper、mutex 类型和 JSON 序列化 helper 都不属于协议。
