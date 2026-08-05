# SOMS 联邦 API 闭环审计

> **分类：Baseline audit（非规范性）**
>
> 本文逐个检查当前联邦 API 是否能构成完整通信闭环。`实现可通信` 只表示当前两个 SOMS 节点
> 能走通；`规范已闭环` 还要求第三方能仅依据稳定契约实现同样行为。两者不能混为一谈。

## 1. 闭环判定规则

每个端点必须同时满足以下检查项：

| ID  | 检查项     | 通过条件                                                                |
| --- | ---------- | ----------------------------------------------------------------------- |
| A   | 发起点     | 明确哪个状态变化或调度器发起请求，以及目标 peer 如何选择                |
| B   | 请求契约   | method、path、headers、path/query/body 的类型、必填、范围和条件字段完整 |
| C   | 身份绑定   | signer、origin、from/to domain 和资源身份之间的绑定不可伪造或含糊       |
| D   | 接收处理   | 前置状态、授权、持久化/副作用和事务边界明确                             |
| E   | 成功响应   | status、headers、body/envelope 和“成功代表什么”明确                     |
| F   | 错误响应   | 每种可预期错误有唯一分类，调用方知道 retry、no-retry 或状态收敛         |
| G   | 幂等与重放 | 网络重试不会产生重复副作用；冲突 payload 有确定结果                     |
| H   | 恢复与收敛 | 丢包、超时、重启或单向失败后存在明确恢复路径，或明确接受永久丢失        |
| I   | 边界测试   | 正常、非法参数、错误绑定、重复、失败恢复至少有对应测试                  |
| J   | 版本能力   | 端点或字段能被协商；旧节点不会因未知能力进入死循环                      |

状态定义：

- `CLOSED`：A–J 全部有规范和一致性测试。
- `IMPLEMENTED`：当前 SOMS 双节点主路径可通信，但仍缺正式契约或边界验证。
- `OPEN`：存在可能导致拒绝、错误状态或无法恢复的未裁决敞口。
- `ONE-SIDED`：只实现 server surface，当前 SOMS 没有对应 consumer workflow。

目前没有端点应标为 `CLOSED`，因为 JSON Schema、版本协商和完整反例测试尚未建立。

## 2. 总体闭环图

```text
DNS/SRV -> /.well-known/soms -> signed /init -> trusted peer
                                             |
                                             +-> invite -> invite-accept
                                             |              |
                                             |              +-> P2P/group state
                                             |
local send -> outbound hint -> POST new-msg-map -> GET messages -> store/dedup
                     |                                ^             |
                     +-> periodic GET new-msg-map ----+             +-> GET get_file
                                                                    +-> GET forward-bundles

chat open -> revision probe -> profile/roster pull -> local mirror convergence
call action -> POST call -> remote in-memory call state -> reverse POST call / message pull
```

任何箭头缺少错误分类、重试或 fallback，都视为逻辑敞口。

## 3. 逐端点总表

| Endpoint                                  | 发起方 -> 接收方                        | 正常闭环                                       | 当前状态    | 主要未闭环项                                                             |
| ----------------------------------------- | --------------------------------------- | ---------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `GET /.well-known/soms`                   | discovery/verify -> peer                | key list -> 验证后续签名                       | IMPLEMENTED | 无协议版本/capabilities；key rotation 规则未成文                         |
| `POST /s2s/init`                          | `ensurePeerTrusted` -> peer bootstrap   | 验签 -> peer trusted -> 202                    | OPEN        | 单向 init 是否足以称 mutual trust；auto-accept/allow-list 语义；重放窗口 |
| `POST /s2s/invite`                        | 本地 invite action -> invitee domain    | remote pending invite/stub -> 202              | IMPLEMENTED | FRIEND/GROUP 条件字段缺 schema；冲突 payload 规则未定义                  |
| `POST /s2s/invite-accept`                 | invitee action -> inviter/group origin  | 两侧 relationship/roster 收敛 -> 202           | IMPLEMENTED | 重试与 accept-wins 需形成明确状态表                                      |
| `POST /s2s/invite-revoke`                 | inviter action -> invitee domain        | remote pending invite revoked -> 202           | IMPLEMENTED | 直接边界 E2E 和重复/已接受矩阵不完整                                     |
| `POST /s2s/call`                          | call state machine -> other user domain | remote state/event；反向 frame 或 message pull | OPEN        | ephemeral frame 无 durable recovery；op 条件字段和乱序状态表未规范化     |
| `GET /s2s/users/:account`                 | resolve/profile sync -> identity origin | profile -> local stub localization             | IMPLEMENTED | account path grammar、not-found envelope、profile limits需统一           |
| `GET /s2s/users/:account/revision`        | chat-open/profile fanout -> origin      | revision newer时再拉 full profile              | IMPLEMENTED | revision 类型/回退行为/删除用户结果未规范化                              |
| `GET /s2s/group/:account/roster-revision` | mirror chat-open -> group origin        | revision newer时拉 roster                      | IMPLEMENTED | requester membership gate及 not-found 行为需裁决和反例测试               |
| `GET /s2s/group/:account/roster`          | mirror -> group origin                  | canonical roster -> mirror reconcile           | IMPLEMENTED | 仅 trusted peer 是否足够；roster 可见性策略需安全裁决                    |
| `GET /s2s/new-msg-map`                    | reconnect poller -> peer                | snapshot -> pending pulls -> messages          | IMPLEMENTED | cursor/take 非法值处理和 snapshot pagination 契约不完整                  |
| `POST /s2s/new-msg-map`                   | send buffer -> peer                     | 202 fast ACK -> receiver async pull            | IMPLEMENTED | 202 不代表 pull 成功；entries 非法项处理和 ACK 清除语义需精确定义        |
| `GET /s2s/messages`                       | pull drainer/chat-open -> author/origin | page -> store/dedup -> next cursor             | IMPLEMENTED | 三种 query union 未机器约束；整数验证和错误矩阵存在敞口                  |
| `GET /s2s/messages/before`                | 外部实现 -> serving SOMS                | backward page                                  | ONE-SIDED   | SOMS 当前没有 consumer；跨实现闭环未被验证                               |
| `GET /s2s/ping`                           | reconnect sweep -> peer                 | response -> liveness success                   | IMPLEMENTED | response 字段和 clock 语义未规范；版本不兼容无法区分 outage              |
| `GET /s2s/get_file`                       | media localizer -> peer                 | Range loop -> digest verify -> CAS commit      | IMPLEMENTED | 非法 Range 退化策略、错误 demotion 分类和参数 union 需规范化             |
| `GET /s2s/forward-bundles/:bundleId`      | pulled card localizer -> serving peer   | closure -> verify -> child graph -> assets     | IMPLEMENTED | closure JSON schema、size/depth/cycle 错误响应和 capability 协商缺失     |

## 4. 参数级检查

### 4.1 所有签名请求

必须统一定义并验证：

- `Signature-Input`、`Signature`、`Content-Digest` 的必需性和算法；
- method、authority、path、query、body 中究竟哪些 component 被签名；
- `keyId` grammar、signer domain 提取和 domain canonicalization；
- `created`/`expires` 或等价 replay window；
- body byte serialization、Content-Type 和最大请求体；
- key miss、坏签名、过期签名、未知 key、blocked/demoted peer 的唯一错误分类。

当前实现明确对 request 验签，但这些约束尚未形成独立 profile，因此所有端点的 B/C/F/G/J
仍不能判定为规范闭环。

### 4.2 POST operation 公共字段

| 参数     | 当前用途                    | 闭环必须补齐                                      |
| -------- | --------------------------- | ------------------------------------------------- |
| `id`     | origin ULID；部分操作 dedup | grammar、长度、重复同 payload、重复异 payload     |
| `origin` | 发起服务器 domain           | 必须等于 signer；canonicalization                 |
| `ts`     | origin epoch milliseconds   | 整数范围、允许时钟偏差、是否参与 replay rejection |

### 4.3 `invite`

需要把 body 定义为严格 tagged union：

- FRIEND：`from`、`to`、`profile` 必须出现；GROUP-only 字段必须拒绝还是忽略需要裁决。
- GROUP：`from`、`to`、`group`、`groupName`、`groupRevision`、`owner`、`sinceSeq` 的必填性
  必须逐项固定；`groupAvatar` 是否可省略与 `null` 的差异必须固定。
- `note` 长度按 UTF-8 bytes、Unicode scalar 还是 JS code units 计算必须固定。
- 必须验证 `origin == signer == from.domain`、`to.domain == receiver domain`；GROUP 还要验证
  `group` 的 origin 和 owner 权限。

### 4.4 `invite-accept` / `invite-revoke`

- `kind` 决定 `by` 或 `group` 的条件必填，禁止含糊 fallback。
- `inviteOriginId` 的关联对象、缺失行为和跨 kind 冲突必须固定。
- 状态矩阵至少覆盖 pending、already accepted、already revoked、expired、missing、duplicate。
- 每个矩阵格必须定义 status/business code、是否重试和双方最终状态。

### 4.5 `call`

- `op` 是 tagged union；`signal` 必须定义 `kind/payload`，`connected` 必须定义 `startedAt`，
  `ended` 必须定义 `endReason`，其余 operation 对这些字段的处理必须固定。
- 必须验证 `origin == signer == from.domain`、`to.domain == receiver`、双方 friendship/call 权限。
- 需要完整状态机处理 duplicate、late、out-of-order、unknown callSid 和 peer restart。
- 如果协议接受 ephemeral 丢失，必须明确超时如何让两端最终结束，不能留下永久 ringing/connected。

### 4.6 message queries

`GET /messages` 和 `/messages/before` 是三个互斥 query shape：

| Mode              | 必需参数                                           | 禁止/无意义参数                 | Cursor space        |
| ----------------- | -------------------------------------------------- | ------------------------------- | ------------------- |
| P2P               | `fromAccount,toAccount,toDomain`                   | group-only 组合                 | `originSeq`         |
| Group all-senders | `toAccount=!group,toDomain`                        | `fromAccount/fromDomain` 半组合 | origin thread `seq` |
| Group per-author  | `toAccount=!group,fromAccount,fromDomain,toDomain` | —                               | author `originSeq`  |

必须补齐：

- account/domain grammar 和 URL encoding；
- `afterSeq`/`beforeSeq` 必须为 int32，`take` 必须为正整数且上限确定；
- `fromAccount` 单独出现或 `fromDomain` 单独出现必须 400，不能静默切换 mode；
- response `latestSeq` 在空页、末页、并发写入时的含义；
- `hasMore` 与下一 cursor 的算法；
- 404/410/401/429/5xx 对 pull cursor、peer trust 和 retry queue 的影响。

### 4.7 hint map

- GET 的 `cursor`、`take` 范围和稳定 pagination 必须定义。
- POST 的 `entries` 必须是有上限的数组；每项四字段都必须做 grammar/range/binding 验证。
- 202 只表示 hint 已接受，不表示消息已拉取。
- sender 何时可以清除 hint、ACK 丢失如何恢复、receiver 重启如何重建 pending pull 必须明确。
- 周期 GET fallback 是当前关键恢复腿，不能作为可选实现细节从规范中遗漏。

### 4.8 profile、roster 和 revision

- `:account` 必须按 user/group grammar 解析并进行单次 URL decode。
- profile/avatar 字段上限、base64 字节上限和 revision 整数范围必须固定。
- roster response 必须包含 revision 或明确 revision probe 与 roster fetch 之间竞态如何处理。
- 必须明确什么 peer 有资格读取 group roster；仅 trusted 是否构成成员信息泄露需要裁决。
- 用户删除、group 解散、成员被移除分别返回什么，以及 mirror 如何清理/软删除必须闭环。

### 4.9 media 和 forward bundle

- 普通 media 与 bundle media 是互斥 query union；禁止混合参数绕过 binding。
- `digest` 必须固定为 lowercase/uppercase 是否接受、hex 长度和 hash algorithm。
- Range 需要明确只支持单范围，以及 invalid、multi-range、unsatisfiable 的结果。
- receiver 必须验证最终 digest；失败后的 offset retry、最大次数和 peer demotion 分类必须固定。
- bundle closure 必须有 schema、最大 JSON bytes、最大节点数/深度、cycle 和 digest 校验规则。

## 5. 当前优先级最高的逻辑敞口

以下不是文字润色问题，而是会影响跨实现通信或安全边界：

1. **响应模型未统一。** 第三方无法可靠判断 GET payload、business envelope 与 HTTP error。
2. **签名 profile 未独立冻结。** 尤其 query 是否签名、replay window 和 domain canonicalization。
3. **消息 query union 验证不严格。** 半组合参数和非整数/负 `take` 可能落入非预期 mode。
4. **能力协商不存在。** 新节点调用 `/call`、`/messages/before` 或 forward bundle 时，旧节点的
   404 无法与资源不存在清晰区分。
5. **roster 可见性边界待裁决。** 当前端点表述为 trusted-peer gate，未形成成员级读取契约。
6. **ephemeral call 的故障收敛未成文。** 丢帧或节点重启后双方必须有确定 terminal timeout。
7. **hint ACK 与重启恢复语义未冻结。** 这是 pull delivery 不永久丢失的关键闭环。

## 6. 每个端点的完成模板

后续正式规范为每个 API 建立同样的记录，未填满不得合并为 `CLOSED`：

```text
Endpoint:
Capability/version:
Producer trigger and target selection:
Method/path/content type:
Signed components:
Path/query/body schema:
Identity and resource binding:
Receiver preconditions:
Receiver transaction and side effects:
Success status/headers/body:
Error matrix (retry/no-retry/converge):
Idempotency and conflicting replay:
Timeout/retry/backoff:
Crash/restart recovery:
Caller response handling:
Positive conformance vectors:
Negative conformance vectors:
Cross-version behavior:
Status: OPEN | IMPLEMENTED | CLOSED
```
