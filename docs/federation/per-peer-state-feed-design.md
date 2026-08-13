# 联邦每 Peer 状态 Feed 设计

> **状态：已实现**
>
> **日期：2026-08-08**
>
> **适用范围：好友关系、用户/群资料、群成员与角色状态的联邦同步**

本文以“每个 peer 一份、按状态 key 压缩、携带完整快照”的持久 feed 取代聊天打开时的联邦
关系/profile/meta 探测。

本文替换早期实现中由聊天消息承担关系动作、删除关系后再懒查询权威状态，以及 profile/group meta
revision 二次查询的部分。
现有消息 `/message-feed`、`ThreadAudience`、消息删除、`leaveId`/消息交付边界继续服务于聊天消息，
不因本设计删除或复用。状态 feed 有独立的表、rev allocation upper bound 和 pull cursor。

## 1. 最终原则

1. 申请、接受、拒绝和删除好友等 S2S 写接口仍是业务命令；命令后的额外资料/关系同步 POST 删除。
2. 每个 federated peer 拥有一份独立状态 feed；feed item 在写入时已经完成路由，拉取时不再连接
   audience 表鉴权。
3. 同一 peer、同一状态 key 只保留最新 item。中间 revision 可以压缩，最终快照不能丢。
4. PROFILE item 携带头像；GROUP_META 只携带完整 roster/role/owner/active 快照，不重复头像。
5. 业务状态、业务 revision、peer rev 和 feed item 必须在同一数据库事务中提交。
6. push/SSE 只是可丢失、可重复、可乱序的唤醒；持久 feed、`allocatedThrough` 和 committed cursor 提供完整性。
7. 删除 federated peer 时级联删除该 peer 的 feed、allocator 和 pull cursor。

## 2. 权威模型

### 2.1 身份

User 和 Group 均由不可变 account 识别。群 account 使用现有 `!` 前缀，因此状态 key 不增加
`entityType`。

### 2.2 群聊

群所在服务器是 Group PROFILE 和 Group META 的唯一权威来源。只有群 origin 可以发布：

- 群名称、头像、简介；
- active/dissolved 状态；
- 完整成员列表；
- 成员角色；
- 群主。

镜像服务器只按更高 revision 应用快照，不能反向声明权威群状态。

### 2.3 P2P 好友关系

好友关系取双方认可状态的 AND：

```text
effectiveFriend = localRecognizesRemote && remoteRecognizesLocal
```

双方分别只对自己的 `recognizesFriend` 状态负责。任意一方发布 `false`，接收方必须立即解除
effective friendship；旧的 `true` 不能在之后复活关系。

每个方向保存最后应用的 revision。只有更高 revision 可以覆盖；相同 revision 重试是 no-op，
更低 revision 必须忽略。重复加好友、重复删除好友等没有发生真实状态迁移的命令不增长 revision。

申请/接受/拒绝/删除好友仍通过已签名、幂等的 S2S command 完成。可以删除的是命令成功后为了
建立镜像、补头像或查询最终关系而发送的额外 POST。

## 3. 状态类别和 key

`eventType` 表示可覆盖的状态类别，而不是不可压缩的动作日志：

```text
PROFILE
P2P_META
GROUP_META
```

建议显式保存 `account` 和可空的 `subjectAccount`：

| eventType  | account                  | subjectAccount   | 含义                        |
| ---------- | ------------------------ | ---------------- | --------------------------- |
| PROFILE    | 用户或群 account         | 空               | 用户/群展示资料             |
| P2P_META   | 本服务器本地用户 account | 对端用户 account | 本地用户对该对端的认可状态  |
| GROUP_META | 群 account               | 空               | 群完整 meta/roster 权威快照 |

P2P 必须包含双方 account。仅使用 `(peerDomain, account, P2P_META)` 会让同一用户在同一远端服务器
上的多段好友关系互相覆盖。

数据库可将 `subjectAccount` 规范化为非空字符串默认值 `''`，从而使用一个普通唯一约束：

```text
UNIQUE(peerDomain, account, eventType, subjectAccount)
```

## 4. 数据模型

表名可在实现时按现有命名风格微调，语义不得改变。

### 4.1 PeerStateFeed

```text
PeerStateFeed
- peerDomain varchar FK -> FederatedPeer.domain ON DELETE CASCADE
- account varchar
- eventType PROFILE | P2P_META | GROUP_META
- subjectAccount varchar NOT NULL DEFAULT ''
- revision int（对象自身的业务 revision）
- rev bigint
- body jsonb
- createdAt
- updatedAt

PRIMARY/UNIQUE(peerDomain, account, eventType, subjectAccount)
UNIQUE(peerDomain, rev)
CHECK(revision >= 0)
CHECK(rev > 0)
```

业务 `revision` 使用 int：它只在单个 profile、好友方向或群快照发生真实变化时增长，并且应用层
需要安全转换为 JavaScript number。peer feed 的 `rev`、allocator 和 cursor 使用 bigint：它们汇总
该 peer 的所有状态 key，长期增长速度和寿命都显著更大。两者不能混用；压缩只会跳过 feed rev，
不会改变对象业务 revision 的含义。

同一 key 只在 incoming revision 大于现存 revision 时覆盖 `revision`、`rev` 和 `body`。相同或
更旧 revision 完全 no-op，不能分配 rev，也不能发送 wake-up。重复入群补 PROFILE 时，相同
profile revision 因此不会产生 feed rev 或接收端数据库写入。

### 4.2 PeerStateFeedTarget

```text
PeerStateFeedTarget
- peerDomain primary key FK -> FederatedPeer.domain ON DELETE CASCADE
- allocatedThrough bigint NOT NULL DEFAULT 0
- updatedAt
```

每个 peer 独立分配 rev，避免所有服务器状态变更竞争一个全局 allocator。不能使用 PostgreSQL
sequence、`MAX(rev)` 或提交顺序不受事务约束的自增值作为安全分配上界。

### 4.3 Pull cursor

接收端为每个 peer 保存独立于 missed message 的状态 feed cursor：

```text
PeerStateFeedPullCursor
- peerDomain primary key FK -> FederatedPeer.domain ON DELETE CASCADE
- committedThrough bigint NOT NULL DEFAULT 0
- updatedAt
```

## 5. Body 契约

所有 body 必须带 schema version。字段最终落 JSON Schema；下面是最小语义。

### 5.1 PROFILE

```json
{
  "domain": "home.example",
  "name": "Alice",
  "bio": "...",
  "avatar": {
    "digest": "sha256 hex",
    "mimeType": "image/png",
    "base64": "..."
  },
  "deleted": false
}
```

`domain` 是资料归属服务器；当群 origin 中继第三方成员资料时不等于 feed 发送 peer。
Group PROFILE 使用相同结构，`bio` 表示群简介。头像建议同时携带 digest，以便接收端校验、去重并
幂等落入现有 CAS；空头像使用明确的空值契约。用户删除、群删除等使用 `deleted: true` tombstone，
不能通过物理删除 feed item 通知远端清缓存。

### 5.2 P2P_META

```json
{
  "status": "REQUESTED",
  "note": "hello",
  "requestedAt": "2026-08-09T10:00:00.000Z",
  "expiresAt": "2026-08-16T10:00:00.000Z"
}
```

状态为 `REQUESTED | FRIEND | NOT_FRIEND`。发送方只能声明自己的方向。`REQUESTED` 必须携带绝对
`expiresAt`；只有尚未过期的申请才参与 pending/接受判断。过期申请在业务上等同不存在，允许复用
原行创建新申请，并提高 business revision、刷新 `requestedAt/expiresAt`。`FRIEND` 与
`NOT_FRIEND` 都没有有效期，`expiresAt` 必须为空。
`note` 是 directional state 的复用字段：`REQUESTED` 时表示申请理由，`NOT_FRIEND` 时可表示解除
原因；没有原因必须发送空字符串，不能沿用旧申请文案。

接收方只有在本地方向和对端方向都明确为 `FRIEND` 时，才能激活 `FriendPair` 和 P2P thread。
本地仍有未过期 `REQUESTED` 时收到对端 `FRIEND`，本地方向推进为无有效期的 `FRIEND` 并回送
确认。若本地方向已经是 `NOT_FRIEND`，对端 `FRIEND` 只保留为对端长期有效的同意，不能覆盖
本地删除；接收方必须提高本地 `NOT_FRIEND` revision 并回送最新否定状态，让 peer 收敛。

删除好友后立即重加不等待 peer 先消费删除。相同 directional key 在尚未 serve 时会 compact 到
最新 revision；已经分批送达时仍按 revision 顺序收敛。过期反向申请不能促成自动成立。

### 5.3 GROUP_META

```json
{
  "active": true,
  "dissolved": false,
  "owner": { "account": "alice", "domain": "origin.example" },
  "members": [
    {
      "account": "alice",
      "domain": "origin.example",
      "role": "OWNER"
    }
  ]
}
```

完整 roster 快照覆盖加群、主动退群、被踢、设置/取消管理员、转让群主和群解散。最后一个属于
某 peer 的成员离开时，该 peer 仍必须收到一次最终 GROUP_META；可使用 `active: false` 表示该 peer
不再拥有活动镜像，确切 wire 字段在 JSON Schema 阶段冻结。

群消息历史采用明确的 member-server tradeoff：只要某服务器仍有至少一个活动群成员，origin 的
peer THREAD audience 就保持打开，共享镜像继续接收并保存消息；该服务器上已退群的用户再次加入
同一镜像后，可以看到这段期间的历史。最后一个属于该服务器的成员离开时，origin 将 peer
audience 冻结到当前 inclusive changeId，之后不再为该服务器生成消息 discovery change；再次加入
只清空边界并恢复后续消息，不补发无人订阅期间的历史。

群邀请的 `REQUESTED` 同样有绝对有效期；过期后视为不存在并允许重新创建。确认成为 `MEMBER`
时必须清空邀请 `expiresAt`，已成立成员状态没有 TTL。镜像加入联邦群后不能立即开放 thread：只有
origin 的新 `GROUP_META` 才能激活 participant/audience。

`GROUP_INVITE_INTENT.note` 同样复用：`REQUESTED` 时是邀请理由，`NOT_MEMBER` 时是拒绝/踢出
原因，无原因发空字符串。服务器本地 999 人上限拒绝使用英文原因
`Group has reached this server's 999-member limit.`；这个数字仍不是联邦协议能力或 wire 上限。

镜像退群后可在 origin 尚未消费 leave 时立即重新 JOIN。若 leave 与 JOIN 尚未 serve，相同
`GROUP_JOIN_INTENT` key compact 为最新 revision；origin 即使仍认为成员 active，也必须为新的 JOIN
revision 重发 `GROUP_META` 确认。反过来，若镜像本地方向已是 `NOT_MEMBER`，旧的 origin roster
仍包含该用户，则不得重新激活本地 participant；镜像提高 `NOT_MEMBER` revision 并回送 leave。
群邀请继续只通过群邀请卡展示，不进入好友 pending/badge。

页面和单 item 必须同时设置字节上限。完整 roster 和 base64 头像会放大 JSON、WAL 与网络流量，
因此分页除 `take` 外必须限制总响应字节；单个合法 item 即使超过普通页预算，也必须有明确的
单条传输上限和错误行为，不能无限大。

## 6. 写入和路由事务

状态变化事务按以下顺序执行：

1. 锁定并校验业务实体当前状态/revision；
2. 在修改成员关系前取得 `peersBeforeChange`；
3. 修改好友、profile 或群状态，并只在真实变化时增长业务 revision；
4. 取得 `peersAfterChange`；
5. 目标为两者并集，确保删除好友、最后成员退出/被踢仍收到最终快照；
6. 对目标 peerDomain 排序，按固定升序锁 `PeerStateFeedTarget`，避免多 peer 事务死锁；
7. 为每个目标 peer 增长自己的 `allocatedThrough`；
8. upsert 对应 feed item 的 revision、rev 和完整 body；
9. 提交；
10. 提交后才向各 peer 发送 `{ allocatedThrough }` 轻量 wake-up。

PROFILE 的正常目标 peer 从当前有效跨站好友关系和共享联邦群关系推导。关系全部结束后，不再把
未来 profile 更新写给该 peer。历史 PROFILE item 可保留，因为资料此前已经合法披露；如果产品要求
撤回缓存，则在最后关系解除事务中写入 `deleted/visible:false` tombstone，不能静默物理删除。

状态 feed 不需要 audience/refCount。它也不能复用消息 `ThreadAudience`：后者继续只决定 missed
消息的发现与交付。

## 7. 拉取 API 和分页

端点名称可在实现时与现有 S2S 命名统一，协议语义如下：

```text
GET /s2s/v1/state-feed?after=120&take=100
```

响应：

```json
{
  "items": [],
  "scannedThrough": "150",
  "stateFeedRev": "180",
  "hasMore": true
}
```

规则：

1. 调用方只能拉取签名身份对应 peer 的 feed；peerDomain 不接受普通请求参数指定。
2. 在事务快照内固定 `allocatedThrough` 为页面上界。
3. 按 `rev > after AND rev <= stateFeedRev` 升序扫描。
4. item 原地更新到更高 rev 会留下空洞；cursor 依据 `scannedThrough` 推进，不能依据最后返回 item。
5. 达到行数或字节预算时，`scannedThrough` 为已经完整检查的最后边界；未达到预算时可直接推进到
   固定的 `allocatedThrough`。
6. `after` 倒退、超过 source allocation upper bound、item 无序或页面边界非法时，按 missed API 的同类错误拒绝。
7. wake-up 丢失后，peer 初始化、进程重启、连接恢复及低频 reconciliation 必须主动查询 feed end 并 drain。

## 8. 接收端原子性

同一 peer 只允许一个状态 feed pull worker；复用 missed pull 的 peer advisory lock/NOWAIT 模式。
一页处理必须在同一本地数据库事务内完成：

1. 验证页面、rev、revision、body schema、头像 digest/base64 和群 roster；
2. 按稳定 key 比较 remote revision；相同/更旧 revision 幂等跳过；
3. 应用完整 profile/P2P/group 快照；
4. 更新 `remoteProfileRev` 或对应 remote meta revision；
5. 推进 `PeerStateFeedPullCursor.committedThrough = scannedThrough`；
6. 提交后向本地客户端发送轻量刷新事件。

任何格式或一致性错误使整页回滚，cursor 不推进。因为 body 已经完整，页事务中不再发起 profile、
avatar、关系或群 meta 的二次远程请求。

## 9. 生命周期

- **建立好友/加入群：** command 事务必须写初始 P2P_META、所需 PROFILE 和 GROUP_META 完整快照，
  不能等待下一次资料变化。好友 thread 只能在双向 `FRIEND` 后建立，不能把双向或未过期
  `REQUESTED` 当作确认。
- **删除好友：** 本地认可立即变 false，写最终 P2P_META；收到任一方 false 后 effective friendship
  立即解除。
- **退群/被踢：** 写给变更前后 peer 并集；群 origin 发布最终完整 GROUP_META。个人 audience
  保留并冻结；某 peer 最后一名成员离开时，其 peer audience 也保留并冻结到消息 feed 的 inclusive
  边界。
- **重新加好友/重新入群：** 使用更高业务 revision 覆盖旧 NONE/inactive item，无需 generation 或
  新建镜像；复用原 thread/mirror，并清空对应 audience 的交付边界。群聊是否拥有离开期间历史
  取决于该服务器在期间是否仍有其他活动成员。
- **用户/群删除：** 写 tombstone body。
- **peer reset/delete：** 既有 reset 安全规则继续适用；删除 `FederatedPeer` 时级联删除 feed、target、
  pull cursor 和该 peer 的远端镜像数据。旧 peer 身份不能继承旧 feed/cursor。

## 10. 被替换和保留的现有逻辑

状态 feed 完成双节点和崩溃恢复验收后删除：

- chat/profile 打开时的联邦 profile revision 探测与二次 profile 拉取；
- 已加好友头像的专用联邦刷新逻辑；
- 群打开时的 profileRev/rosterRev 探测与二次 meta 拉取；
- 好友双方互认成功后仅用于补关系镜像、头像或资料的额外 POST；
- 把普通聊天消息当作关系 action/状态修正来源的代码。

继续保留：

- 申请、接受、拒绝、删除好友等业务 command；
- 消息 `/message-feed`、bounded memory buffer、`ThreadAudience`、message allocation upper bound/cursor；
- 消息删除、`leaveId` 及现有消息交付机制；
- federation identity、签名、trust、reset 和 quota 约束。

## 11. 实施顺序

1. 新增 schema、迁移、Drizzle relations 和约束。
2. 实现 peer 内 allocator、事务 upsert service 和提交后 wake-up。
3. 接入所有 revision 增长点：用户/群 profile、好友双方认可、入退/踢群、角色、群主、解散/删除。
4. 实现 S2S feed-end API、receiver drain、cursor 和本地应用事务。
5. 双轨运行并对比旧查询与 feed 状态；不得先删旧兜底。
6. 完成验收后删除旧 revision/profile/meta 查询和额外同步 POST。
7. 更新 federation API、overview、数据库文档和最终 JSON Schema。

## 12. 必须通过的测试

- 同 peer、同 key 多次更新只返回最高 revision/latest body。
- 同一用户与同一 peer 上多个账号的 P2P_META 不互相覆盖。
- 双方都认可才成为好友；任意一方 false 立即解除。
- 延迟旧 `true` 不能覆盖较新 `false`。
- 重复 command/revision 不增长 rev。
- 事务回滚不暴露 rev/allocation upper bound/item；不能发生先分配后晚提交导致 cursor 跳过。
- wake-up 丢失、重复、乱序以及进程重启后仍能依靠 durable feed end 拉齐。
- 快慢 peer 相互独立；一个 peer 不得读取另一个 peer feed。
- 群最后一个远端成员主动退出或被踢仍收到最终 GROUP_META。
- 多 peer 群更新按固定锁序完成且无死锁。
- 大头像、大群 roster、坏 base64/digest、超页字节预算按契约处理。
- 接收页任一 item 非法时整页和 cursor 回滚。
- 用户/群 tombstone 清除远端缓存；重新建立关系以更高 revision 恢复。
- peer 删除/reset 后 feed、allocator、cursor 及旧身份授权不可继承。
- 切除旧查询和额外 POST 后，双节点加删好友、头像更新、群资料/成员/角色/群主变化仍完整收敛。

## 13. 闭环结论

在上述约束下，本设计闭环：命令负责改变权威业务状态；事务内的每-peer压缩 feed 持久传播完整
最新快照；receiver 原子应用快照并推进 cursor；轻量事件只负责提速；消息 missed 机制保持独立。
不存在必须依赖聊天打开、二次联邦查询、进程内 hint 或 audience 终止
边界才能恢复的状态变化。
