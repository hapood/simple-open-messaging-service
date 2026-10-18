# WIP 任务：修复联邦好友拒绝后发送方卡片不收敛（stale REQUESTED 行复活）

> BUG-1 修复任务简。按本文执行；与当前 WIP 已有改动冲突时，以 WIP 为主线合并，不要重写 WIP 中已有逻辑。

## 背景（bug 机制）

bob@alpha 首次向 carol@bravo 发好友请求时，alpha 上没有 carol 的方向行，bob 的 SENT 卡片 body 里嵌了 `peer.profileRev: 0`。carol 拒绝后，alpha 摄取该拒绝的**同一事务**里同时发布两行 feed：

- carol 方向终态行 `REVOKED + requestStatus: REJECTED`（ordinal 1 → feedId 6，正确）；
- bob 方向的存活 REQUESTED 行（ordinal 2 → feedId 7）。后者本应被 body 逐字节去重吞掉，但此时 carol 的方向行已出现，重推导的 body 中 `peer.profileRev` 从 0 变 1 → body 变了 → 去重放行 → 旧态行拿到比终态更高的 feedId。

客户端按 feedId 序应用：先 6（卡片→已拒绝），再 7（`7 > sourceFeedId` 守卫合法通过 → 卡片退回 REQUESTED/撤回），永久卡死；清缓存重放同样复活。

发送卡片的对端呈现已由不可变的 `snapshot`（`RelationshipIntent.snapshot`，`shared/request-snapshot.ts`）承载，OUTGOING body 里那个实时 `peer.profileRev` 对发送卡完全冗余。

## 改动 1（服务端，根因）：OUTGOING body 的 peer.profileRev 钉 0

文件：`src/user/p2p-intent/authored/user-intent-client-feed-sql.ts`

位置：`userIntentClientBodiesSql` 的 `candidate_bodies` CTE，`peer` jsonb_build_object 中的 `'profileRev', cp."clientPeerProfileRev"` 改为：

```sql
'profileRev', CASE WHEN cp.direction = 'OUTGOING'
  THEN 0 ELSE cp."clientPeerProfileRev" END
```

- 条件可与同文件 snapshot 嵌入 CASE（`cp.direction = 'OUTGOING' AND cp."authorNamespaceId" = 0`）保持对称；语义上 OUTGOING ⇒ authorNamespaceId=0（feed 接收者恒为 namespace-0 本地账号）。
- 加注释：SENT 卡呈现由 snapshot 承载；钉 0 使 SENT REQUESTED body 从请求发出起逐字节不变，后续任何块的 body 去重都能抑制重发，终态行之后的旧态复活因此不可能发生。
- INCOMING body 不动：其 `peer.profileRev` 取作者自身方向行的不可变 profile 引用（schema 注释 "Immutable author profile reference"），本就稳定且被接收卡使用。

## 改动 2（客户端）：发送卡渲染 snapshot，抑制 profile 解析

现状：`snapshot` 已由 `friend-request-state.ts`（OUTGOING 投影解析，注释 "suppresses profile resolution"）和 `friend-requests/friend-requests.component.ts` 的 `projectionToPending` 带到 PendingReq，但 `friend-request-card` 从未渲染它——标题走 `app-user-identity-label [profileRef]=avatarProfile()`（要求 profileRev>0），头像同源。profileRev 钉 0 后 `avatarProfile()` 永远 undefined，发送卡将永远显示裸账号。因此：

- `friend-request-card`（component + html）：`requestItem().snapshot` 存在时，标题显示 `snapshot.displayName`（替代 identity-label 的 profileRef 解析路径；domain 徽标保留），头像用 `snapshot.avatar`（null 表示明确无头像，显示占位）。
- `avatarProfile()`：snapshot 存在时返回 undefined（抑制 profileRef，不得发出 unevidenced profile demand）。
- 接收卡（无 snapshot）路径完全不动。

## 改动 3：测试

1. 后端单测（body 形状）：OUTGOING 方向 body 断言 `peer.profileRev === 0` 且 `snapshot` 嵌入；INCOMING body 断言仍为作者行 profileRev。更新现有受影响的 spec 期望。
2. e2e `test/federation-address-friend.e2e-spec.ts`（或同文件模式）：拒绝后断言 requester 的 REQUESTED 行**未重发**——其 ClientStateFeed 行的 feedId/updatedAt 在 reject 前后不变（此前缺失的断言，本次回归的直接防线）。
3. web 单测：`friend-request-card` 有 snapshot 时渲染 displayName/avatar、不产生 profileRef；无 snapshot（接收卡）行为不变。`friend-request-state.spec.ts` 补：同一 pair 的 OUTGOING REQUESTED 事件携带不同 `peer.profileRev` 时投影不受影响。

## 无兼容原则（硬性）

- 不为旧 body 形状（嵌实值 profileRev 的 OUTGOING 行）写任何迁移、双形状解析、fallback 或特殊分支。旧 ClientStateFeed 行 / webdb 旧记录交给现有 feed 语义自然收敛：至多触发一次重发后即被新形状覆盖，无需代码。
- 不保留/新增任何读取旧字段的路径；发现依赖旧形状的死代码顺手删除。
- 测试只断言新形状，不测旧形状兼容。
- 客户端 `sourceFeedId` 守卫语义保持现状，本修复不需要动它。

## 边界与注意

- 群侧同构隐患本次不修，但要在 commit message 或 TODO 记录：`src/group/membership-intent/authored/group-authored-membership-request-sql.ts` 嵌的是语句构建时捕获的 `input.groupProfileRev`，群资料在邀请→决定间被编辑同样会让邀请 body 变化并在终态行后复活；`GroupRequestProjection.snapshot` 已有同款快照可承接同型修复。
- 不改客户端 `sourceFeedId` 守卫；不做数据迁移。

## 验收

- `npm test`（后端）、`ng test`（web 相关 spec）全绿。
- 手动/浏览器路径：首次接触的联邦请求 + 拒绝 → 发送方卡片终态「已拒绝」，刷新与重放后不再回到「撤回」；发送卡显示 snapshot 昵称与头像；接收卡（接受/拒绝/撤回）行为不回归。
