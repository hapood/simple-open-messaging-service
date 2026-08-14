# SOMS Federation v1 State Feed

状态：`REVIEW`
规范性：本文全部为规范性要求，除非段落明确标记为“非规范性实现说明”。

本文定义状态快照型压缩 feed `GET /s2s/v1/state-feed`。它与两个索引型 feed 共享
`feedId/after/through/take` 扫描模型，但 item 直接携带可幂等合并的当前业务快照，不需要再调用
query 获取内容。通用身份、签名、响应和错误规则见 [主协议](./protocol.md)。

## 1. 请求

请求 query 是 closed 参数集合：

| 字段      | 类型                               | 要求                                                                                       |
| --------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `after`   | `DecimalString` query string       | 可选；consumer 的 exclusive 扫描位置；省略时只返回 `resumeAfter`，不返回 page。            |
| `take`    | `PositiveSafeInteger` query string | 可选；consumer 建议的本页最大 item 数。publisher MAY 返回更少，但不得返回更多。            |
| `through` | `DecimalString` query string       | 可选；本轮扫描的 inclusive 上界，MUST 大于或等于 `after`。连续有界分页 MUST 保持同一个值。 |

`take` 不保证 page 一定包含该数量，也不是响应 bytes 的安全承诺。publisher MUST 同时执行公开、确定的
item 和 page-byte 上限，并取其中更严格者；请求值不受支持时返回 `FEDERATION_MALFORMED`，单个合法状态快照超过 operation 上限时返回
`FEDERATION_PAYLOAD_TOO_LARGE`。`through` 只冻结读取窗口，不确认、删除或降级任何状态。

省略 `after` 时不得携带 `take` 或 `through`。source MUST 返回 HTTP `200`
`FEDERATION_FEED_CURSOR_UNAVAILABLE`，data 只含当前可用 exclusive cursor `resumeAfter`。consumer 原子
保存后以 `after=resumeAfter` 开始正常读取；不得猜测初始 ID。该起点由 publisher 定义；
SOMS 新建的 per-peer state feed 使用 `"0"`。feed item ID MUST 为正整数，cursor/end MUST 为非负整数；
`0` 是第一个 item 之前的 exclusive cursor，不是 item ID。
从 `resumeAfter` 开始排空 MUST 能重建当前完整 state projection；若当前存在 item，publisher 不得把
`stateFeedEndId` 直接当作 bootstrap 起点而跳过它们。

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

publisher 在一个一致 source snapshot 上读取 `stateFeedEndId`，并计算：

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

### 2.1 无 Source ACK 的压缩投影

publisher 不为 consumer 维护 `acknowledgedThrough`、`lastServedThrough` 或其他验证游标。任意位于
`[0, stateFeedEndId]` 的 `after` 都可读，包括重复和较旧位置。publisher 不得把 `after` 当作 ACK，也不得
因 consumer 读取而删除当前投影。

publisher MUST 持久保存每个当前 stable key 的最新快照。更高业务 revision 覆盖旧版本时，必须分配
比该 feed 历史所有 ID 都大的新 `feedId`；不得复用旧 ID 或在 consumer 已可能越过的 ID 上原地
改写。旧版本可以立即 compact。省略 `after` 或者 `after > stateFeedEndId` 时可返回有效
`resumeAfter`；压缩本身不得导致 cursor unavailable。

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

`revision` 是该 stable key 的业务版本。业务内容只能在 `revision` 严格增加时变化；相同或更旧
revision 不得改写 body。consumer 按 stable key 与 `revision` 幂等合并，不得用 `feedId` 代替业务
revision。consumer 已保存相同 revision 但收到语义不同 body 时 MUST 拒绝 page，并记录协议冲突。
除第 6 节的 member-before-group dependency repair 外，相同 revision/body 不分配新 `feedId`。

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
不得因为 `PROFILE` 包含 `bio` 或 tombstone 状态而扩大查询响应。consumer 代理该查询时 MUST NOT 因查询
结果创建持久 `User` stub、关系或 state projection。人类用户的 home-authored `PROFILE` 可以先按 Address
保存为已验证资料投影，但收到 `REQUESTED` 或 `REVOKED` 仍不得创建 stub；只有收到有效 `ACCEPTED`，且
已保存该 identity home 发布的非删除 `PROFILE` 时，才可把投影物化成持久 stub。群 mirror 的惰性物化不受
这条人类用户规则影响。

### 4.2 `MEMBER_PROFILE`

`MEMBER_PROFILE` 表示目标 peer 因共享群等明确来源需要保存的人员展示资料；它不表示该人员属于某个
特定群。实际 roster 只能由 `GROUP_META.members` 表达。

```ts
interface MemberProfileBody {
  displayName: string;
  avatar: ProfileAvatar | null;
}
```

publisher MUST 为每个 `(target peer, member Address)` 维护完整的当前可见性来源集合：

- 第一个来源出现时发布完整 `MEMBER_PROFILE`；
- 仍有至少一个来源时，新增或删其他来源不得移除快照；
- 人员资料 revision 增加时，只向仍有来源的 peer 发布新快照；
- 最后一个来源消失时，publisher 直接从当前 state-feed projection 删除该 stable key，
  不分配 `REMOVED` item，也不保留可见 tombstone。

来源集合是权威事实；来源数量只能从集合衍生，不得作为另一份独立权威。具体表、引用计数缓存或 GC
实现不属于协议要求。

consumer MUST 按 `(signer domain, member Address)` 隔离保存快照。由不同 signer 发布的同一人员可以分叉，
不得按人员 Address 或 profile revision 跨 signer 合并。一次可清理的完整排空必须固定 state drain target：
target 可以来自 feed-head hint，或本轮第一个未携带 `through` 的成功 page 所返回的 `stateFeedEndId`；后一种
情况下该首 page 计入本轮，后续 page 必须固定使用 `through=target`。只有达到
`hasMore: false && scannedThrough === target`，且所有 page 的状态副作用和最终 cursor 都已提交，才可针对
该 signer 做一次 source-scoped mark-and-sweep。sweep 必须使用此时本地最新
已提交的 P2P 关系和 `GROUP_META` replacement roster：同时不再是本域成员好友、也不再与本域成员共享任一群
的 member 快照应被删除。不得在单个 page 之间、失败 page 后或尚未达到固定 target 时清理。历史消息的
author Address 必须保留；删除展示快照不得删除消息。排空期间被重新索引到更大 feed ID 的状态由后续 hint
或周期 reconciliation 处理；仍被本地已提交关系或 roster 引用的 member 不会在本轮被 sweep。

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

// Closed shape: P2P_INTENT has no additional fields.
type P2PIntentBody = IntentBody;
```

- `REQUESTED` 表示本方向当前有效地请求或同意建立关系；`requestedAt` MUST 非空。
- `ACCEPTED` 表示本方向已经观察并确认双方流程的成功结果；`expiresAt` MUST 是 `null`。
- `REVOKED` 表示本方向拒绝、撤回或终止；`expiresAt` MUST 是 `null`。
- `note` 只描述本方向，不授予权限，最多 255 个 Unicode code point。
- expiry 只使 `REQUESTED` 失去效力，不隐式增加 revision。过期 `REQUESTED` 可以从当前 feed projection
  直接省略，不要求发布 `REVOKED` 或其他删除通知；consumer 无论是否再次看到该 key，都必须按绝对时间
  停止把它当作有效申请。

三种 intent 的 `REQUESTED` 都必须有非空 `expiresAt`，并满足
`requestedAt < expiresAt <= requestedAt + 7 days`。协议不允许永久 pending 的好友申请、群邀请或群申请。

`REVOKED` 没有语义有效期，`expiresAt` 必须为 `null`。它是拒绝、撤回或终止的 best-effort 状态通知：
publisher SHOULD 按服务能力尽量长期保留其当前 projection，但 MAY 在之后直接省略该 key，不需要删除
通知。consumer 不得把 projection 缺失解释为关系重新有效；当前关系/授权查询和 message query 的即时
拒绝是清理后的兜底收敛机制。

### 5.1 P2P

P2P 关系只有双方最新方向都为 `ACCEPTED` 时成立。收到对方有效 `REQUESTED` 时，已有有效本地方向的
实现可以把本方向推进为 `ACCEPTED` 并回传；双方交叉请求必须通过 stable key revision 幂等收敛。任一方
发布 `REVOKED` 后关系立即失效，并停止该已关闭 audience 的未来 P2P message allocation；另一方向不会
因此被伪造成该方 author 的状态。

`P2P_INTENT` 是 closed body，不得携带 `messageFeedEndId`、`tombstoneFeedEndId`、任何
data-feed cursor 或历史授权边界。feed end 只是对应全局索引 feed 的扫描上界，不是
thread 关系关闭边界。收到 `REVOKED` 后，consumer MUST
使对应 peer/thread 的当前 message/tombstone query 目标失效并停止重试；source MAY 从
两个索引 feed 中分别删除该 thread 的当前投影。这两个投影彼此独立，无需同时存在或
同时删除。若 query 在 state 收敛前返回 `FORBIDDEN`，consumer 以相同方式使当前目标失效，
并优先重新排空 state feed 作为兜底对账。

好友关系关闭或重新建立后，message/tombstone query 由 source 根据 durable 状态和本地策略
即时判断可读范围；不得把 per-peer feed ID 解释为 thread 消息权限，也不得因关系重建而
回退已提交的 thread-local query cursor。

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

对 `GROUP_META.members` 中每个新增 member，publisher MUST 在分配该 `GROUP_META` feed ID 前，保证
目标 peer 的当前 state-feed projection 已存在对应 `MEMBER_PROFILE`，且其 `feedId` 更小。若后续
member profile 更新使它的新 `feedId` 超过仍引用该 member 的 `GROUP_META`，publisher MUST 重新索引
相关 `GROUP_META`，使当前压缩投影仍保持 member-before-group 顺序。这种 dependency-repair allocation
MAY 在 body 和业务 revision 不变时只分配新 `feedId`；consumer 对相同 revision/body 幂等 no-op。
一个一致 page snapshot 不得同时返回仍引用 member 的 group 快照和不可解析的 member 投影。

`active: false` 撤销未来 allocation，并使 message query 的当前访问结果为 `FORBIDDEN`，但不删除此前在
有效 audience 期间形成的历史 allocation proof，也不重置 query 坐标。同一 account 的 audience 重新有效
后，只恢复读取这些历史 proof 与重新有效后的新 allocation；无有效 audience 期间的消息不回填。
publisher 必须持久保存足以在重启、重复拉取、audience 关闭和重新打开后重建该结果的事实，不得只根据
当前 roster 推断历史可见范围。具体锁、内部 thread seq 和存储结构不属于协议要求。

## 7. 应用、恢复与安全

consumer MUST 先按 wire `feedId` 验证 page、身份、binding 和每个 stable key revision。全页验证成功后，
按 feed 顺序先物化 `PROFILE/MEMBER_PROFILE`，再物化引用它们的 `GROUP_META` 和 intent。相同或较旧业务
revision 不得覆盖新快照；dependency-repair 产生的相同 revision/body 是 no-op，但其 feed cursor 仍正常推进。

`MEMBER_PROFILE` 的可见性在 publisher 生成投影时由当前来源集决定。consumer 只在完整排空后做引用闭包
清理，不把 feed 投影 omission 解释为删除事件。malformed、signer binding 错误或跨 signer 合并必须使整页失败。
consumer 向自己的客户端同步时 MUST 保留 `(source signer domain, member Address)` 作用域；群成员列表中的
展示资料还必须关联其 `source signer domain`，不得只按本地 `userId` 或 member Address 合并不同 peer
中继的快照。客户端只有在固定 `stateRevision` 目标完整提交后才能清理已无引用的 source-scoped 展示
缓存，并必须保留历史消息中的稳定 author Address。

feed-head hint 不携带任何业务 body，也不能代替 state-feed。重启、提示丢失、重复 page、乱序 hint、
compacted 中间 revision 缺失和 page 重排，都必须通过 stable key 最新快照得到同一最终投影。

### 非规范性实现说明

SOMS 可以用关系方向表共享 P2P、invite 和 join 的 revision/expiry 状态机，同时保留不同关系种类的本地
外键。人员可见性适合以 `(peer, member, sourceType, sourceId)` 唯一来源行表达；是否存在来源通过
`EXISTS` 或可重建缓存计算。数据库表名、事务 helper、mutex 类型和 JSON 序列化 helper 都不属于协议。
