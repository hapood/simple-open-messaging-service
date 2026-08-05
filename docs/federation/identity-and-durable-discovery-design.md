# 联邦节点身份连续性与持久消息发现设计

> **状态：待审核设计（尚未实现）**  
> **日期：2026-08-05**  
> 本文是后续数据库迁移和代码实现的约束。它不描述当前行为；当前行为仍以
> [protocol-baseline.md](./protocol-baseline.md) 为准。

## 1. 目标与非目标

本次改造同时解决两个独立但相互影响的问题：

1. 同一 domain 下线后被另一台服务器重新使用时，旧服务器的好友、群组、消息和授权不能被继承；
2. 进程重启、SSE/POST 丢失或客户端长期不打开某个 thread 时，新消息和关系终止事件仍能被发现。

固定原则：

- 联邦 domain 是不可迁移的身份命名空间，不支持 domain migration；
- domain 不是服务器身份的充分证明；首次信任后还必须固定服务器身份与根密钥指纹；
- 消息正文仍采用 pull，不通过轻量 push 发送；
- push/SSE 仅用于唤醒，持久数据库状态才提供完整性；
- S2S 和客户端增量游标均使用各自服务端 `Message.id`，wire 上一律编码为十进制字符串；
- 关系终止以持久 SYSTEM 消息为准，不能从一次普通拉取失败推断；
- 身份连续性丢失后不自动恢复，只允许管理员执行破坏性的 reset。

本次不提供：

- domain 迁移或旧 domain 向新 domain 的授权转移；
- 私钥丢失后的在线恢复；
- 跨服务器共享本地 `threadId` 或 `Message.id`；
- 全局跨节点消息顺序。

## 2. 术语与 ID 空间

### 2.1 domain

配置项 `SOMS_DOMAIN` 的规范化结果，是联邦地址的命名空间。建立过联邦数据的部署不得修改
domain；检测到配置 domain 与数据库保存值不同必须禁止联邦模块启动。

### 2.2 root key fingerprint

首次建立信任时固定的 Ed25519 根公钥 SHA-256 指纹。建议 wire 格式：

```text
sha256:<base64url without padding>
```

当前 `soms-s2s-key.json` 中的 Ed25519 密钥在升级时直接成为 root key，并可同时作为第一个
active signing key，不要求现有部署生成第二份身份文件。

### 2.3 pairwise server ID

同一服务器针对不同 peer 暴露不同的稳定标识，避免公开标识被跨站关联。它不是随机 UUID，
而是由 root private seed 确定性派生：

```text
identityKey     = HKDF-SHA256(rootPrivateSeed,
                              salt = empty,
                              info = "soms-pairwise-identity-v1")
pairwiseServerId(peerDomain)
                = base64url(HMAC-SHA256(identityKey,
                                        normalize(peerDomain)))
```

该值只能出现在已知接收 domain、且被请求签名覆盖的握手/身份响应中。它不能单独证明身份，
必须与 domain、root fingerprint 和有效签名一起校验。

### 2.4 identity epoch

`identityEpoch` 是正整数，初始为 `1`。正常 signing-key 轮换不改变它。只有保留原 root key、
并由原 root key 签署身份代次转换证明时才允许增加；v1 不提供这种操作，因此实现上固定为 `1`。
root key 丢失不能通过把 epoch 改成 `2` 恢复。

### 2.5 消息 ID

`Message.id` 只在生成它的数据库内单调递增：

- S2S 的 `originMessageId` / `afterOriginMessageId` 属于源联邦服务器；
- 客户端的 `messageId` / `afterMessageId` 属于客户端当前连接的本地服务器；
- 一个远端消息落库后会获得新的本地 `Message.id`，不得拿远端 ID 与本地 ID 比较；
- JavaScript 无法安全表示全部 bigint，因此 JSON 中必须使用 `/^[0-9]+$/` 十进制字符串。

## 3. 本地密钥生命周期

### 3.1 密钥文件格式

继续复用 `SOMS_S2S_KEY_PATH`（默认 `./data/soms-s2s-key.json`）。现有部署的旧格式文件由部署
迁移步骤一次性转换，不在运行时保留旧格式兼容逻辑。服务只接受 v1 文件；文件权限保持 `0600`，
私钥不得进入日志、数据库或 API。

建议的新文件逻辑结构如下，确切序列化可在实现步骤再次审核：

```json
{
  "version": 1,
  "domain": "a.example",
  "identityEpoch": 1,
  "rootKey": {
    "keyId": "a.example/root-1",
    "publicKey": "base64...",
    "privateKey": "base64...",
    "createdAt": "..."
  },
  "signingKeys": [
    {
      "keyId": "a.example/key-1",
      "publicKey": "base64...",
      "privateKey": "base64...",
      "status": "active",
      "createdAt": "..."
    }
  ]
}
```

从旧部署迁移时，root key 与 `key-1` 使用原来的同一份密钥材料，因此公钥指纹和对外签名
`keyId` 均不改变。

### 3.2 自动生成规则

仅满足以下所有条件时允许自动生成密钥：

- 密钥文件不存在；
- 数据库没有固定的本机 federation identity；
- 数据库不存在任何联邦 peer、外域用户、联邦来源消息或联邦关系记录。

如果密钥文件不存在但数据库存在上述任一历史，必须：

1. 普通本地功能可以启动；
2. 联邦模块进入 `local_identity_lost`，停止所有 S2S 入站和出站；
3. 管理界面要求从备份恢复原密钥；
4. 不得静默生成新 key，也不得调用 `/s2s/init` 自动恢复同一 domain。

### 3.3 signing-key 轮换

正常轮换保留 root key 与 pairwise server ID。`old-key signs new-key` 的 transition proof 至少覆盖：

```json
{
  "type": "signing_key_transition",
  "domain": "a.example",
  "identityEpoch": 1,
  "oldKeyId": "a.example/key-1",
  "newKeyId": "a.example/key-2",
  "newPublicKey": "base64...",
  "notBefore": "...",
  "createdAt": "..."
}
```

proof 由已固定且尚有效的 old key 签名。轮换期间 well-known 同时发布 old/new key 与 proof；peer
验证 proof 后才能更新 active key 集。仅看到同一 domain 发布了新 key 不构成合法轮换。

## 4. 远端节点身份状态机

建议 `FederatedPeer.trustLevel` 明确支持：

```text
pending -> trusted <-> demoted
                 \-> blocked
                 \-> identity_lost
```

状态含义：

- `pending`：尚未完成首次握手；
- `trusted`：身份三元组匹配，可处理授权范围内的流量；
- `demoted`：暂时连接失败，可自动重试；
- `blocked`：管理员策略阻断，不自动重试；
- `identity_lost`：domain 返回了与固定身份不一致的服务器，永久停止自动重试和自动 init。

固定三元组为：

```text
(normalizedDomain, pairwiseServerId, rootKeyFingerprint, identityEpoch)
```

以下任一情况进入 `identity_lost`：

- pairwise server ID 改变；
- root fingerprint 改变且没有可验证的 root transition（v1 不支持 root transition）；
- identity epoch 回退或未经证明地改变；
- 已固定 key 被替换且没有合法 signing-key transition proof；
- 本地发现 peer 历史存在，但固定身份字段缺失或互相冲突，无法安全迁移。

网络超时、DNS 失败、TLS 失败、5xx 和签名格式错误不直接等同 identity loss；它们保持现有可重试
失败/降级语义。只有成功取得并验证了相互矛盾的身份材料，才能设置不可恢复状态，避免网络攻击
仅靠阻断请求就触发破坏性状态。

处于 `identity_lost` 时锁住的是该 peer 的联邦命名空间，不是整个本地数据库：

- 拒绝该 domain 的所有 S2S 入站；
- 不再向该 domain 发起 init、ping、push、miss 或业务请求；
- 本地其他 peer 和纯本地聊天继续工作；
- 与该 peer 相关的 thread 变为只读/不可发送，等待管理员 reset；
- 不自动删除任何数据。

## 5. 身份协议

### 5.1 公开 well-known

`GET /.well-known/soms` 继续是公开端点，只发布软件版本、协议 capability、root public key、
signing keys 与 transition proofs。它不返回 pairwise server ID，因为公开请求没有可靠的请求方身份。

### 5.2 首次 init

`POST /api/v1/s2s/init` 请求体至少为：

```json
{
  "protocolVersion": 1,
  "originDomain": "a.example",
  "recipientDomain": "b.example",
  "identityEpoch": 1,
  "pairwiseServerId": "...value derived for b.example...",
  "rootKeyFingerprint": "sha256:...",
  "nonce": "base64url...",
  "issuedAt": "2026-08-05T00:00:00.000Z"
}
```

所有字段和 content digest 必须由 RFC 9421 请求签名覆盖。接收端还必须验证：

- `originDomain` 等于签名 keyId 的规范化 domain；
- `recipientDomain` 等于本机 domain，防止把 A→B 的 pairwise ID 转交给 C；
- root fingerprint 与 well-known root key 匹配；
- nonce 未使用且时间在允许窗口内；
- 若 peer 已存在，固定三元组必须完全匹配。

首次成功可按现有产品策略自动建立 `trusted`；“自动建立信任”只适用于数据库中从未出现过该
domain，或管理员刚完成 reset 并明确允许该 domain 作为全新 peer 再次接入的情况。reset 后的
`/init` 可以建立新的服务器级信任，但不能恢复任何旧用户、关系、群成员或消息授权。

响应返回本机针对 origin 派生的同结构身份声明，并使用本机 active signing key 做 detached
application signature。不能依赖 TLS 响应本身证明 pairwise payload 来自预期联邦身份。

### 5.3 重连身份查询

新增：

```text
GET /api/v1/s2s/identity?recipientDomain=<caller-domain>&nonce=<nonce>
```

请求必须签名。响应包含 `domain`、`recipientDomain`、`identityEpoch`、`pairwiseServerId`、
`rootKeyFingerprint`、`nonce`、`issuedAt`、active key 列表摘要和 detached signature。

重连顺序：

1. 解析服务地址并读取 well-known；
2. 验证已固定 signing key，或验证 old→new transition proof；
3. 调用 identity endpoint，校验接收方绑定、nonce、响应签名和固定三元组；
4. 只有成功后才发 ping/miss/业务请求；
5. 身份矛盾时原子设置 `identity_lost`。

身份 endpoint 允许已知但处于 `demoted` 的 peer 调用；`identity_lost` 和 `blocked` peer 不允许用
该接口自动解锁。

## 6. 数据模型草案

字段名是实现目标，最终 Drizzle/SQL 类型在迁移步骤审核。

### 6.1 LocalFederationIdentity

数据库保存非秘密的本机身份锚点，用于检测密钥文件丢失或 domain 被修改：

```text
domain                  varchar(63) primary key
identityEpoch           integer not null
rootKeyFingerprint      varchar(80) not null
createdAt               timestamp not null
```

### 6.2 FederatedPeer 扩展

```text
pairwiseServerId        varchar(64) null
rootKeyFingerprint      varchar(80) null
identityEpoch           integer null
identityPinnedAt        timestamp null
identityLostAt          timestamp null
identityLostReason      varchar(255) null
resetGeneration         integer not null default 0
resetAt                 timestamp null
```

旧 peer 的首次升级不能仅凭当前 well-known 自动固定身份。迁移策略必须在实现步骤选择并测试：
已有联邦关系的 peer 需通过双方升级后的身份握手完成 pin；在 pin 完成前不得接受 key 改变。

### 6.3 ThreadAudience

本地用户和远端 peer 共用 thread 可见性索引，避免为每条消息复制大量 recipient 行：

```text
id                       bigserial primary key
targetType               LOCAL_USER | FEDERATED_PEER
localUserId               integer null
peerDomain                varchar(63) null
threadId                  integer not null
accessEpoch               integer not null
visibleFromMessageId      bigint not null
visibleThroughMessageId   bigint null
createdAt                 timestamp not null
endedAt                   timestamp null
```

约束：

- `LOCAL_USER` 只能设置 `localUserId`，`FEDERATED_PEER` 只能设置 `peerDomain`；
- `visibleThroughMessageId IS NULL OR visibleThroughMessageId >= visibleFromMessageId`；
- 同一 target/thread 的每次重新加好友或重新入群创建新的 `accessEpoch`，不复用旧区间；
- 重新授权默认从新 epoch 的起点可见，不自动恢复旧 epoch 历史；
- 建议索引：
  - unique `(targetType, localUserId, threadId, accessEpoch)`（local partial）；
  - unique `(targetType, peerDomain, threadId, accessEpoch)`（peer partial）；
  - `(localUserId, endedAt, threadId)`（local partial）；
  - `(peerDomain, endedAt, threadId)`（peer partial）；
  - `Message(threadId, id)`。

`visibleFromMessageId` 的边界是包含。若建立关系时尚无消息，可在事务中先分配/插入建立关系的
SYSTEM 消息，并以该消息 ID 作为起点；如果产品不展示建立事件，则使用下一条实际消息的 ID，
实现时不得用“当前序列值 + 1”猜测未提交 ID。

### 6.4 SystemMessageTarget

部分关系事件只应让特定成员/peer 看见，不能仅依靠 thread 级 audience：

```text
messageId                bigint not null
targetType               LOCAL_USER | FEDERATED_PEER
localUserId              integer null
peerDomain               varchar(63) null
primary key              (messageId, target identity)
```

普通消息没有 target 行，按 `ThreadAudience` 判断；SYSTEM 消息存在 target 行时，必须同时满足
audience 区间和 target 命中。

### 6.5 FederationPullCursor

```text
peerDomain               varchar(63) primary key
remoteHwm                bigint not null default 0
lastAdvertisedHwm        bigint not null default 0
updatedAt                timestamp not null
```

`remoteHwm` 表示已经完整拉取并在本地事务中应用的远端 `Message.id`。收到 push/SSE 只更新
`lastAdvertisedHwm` 或安排任务，绝不能推进 `remoteHwm`。

如果拉取结果允许因无权限而跳过 ID，响应必须返回服务端扫描水位 `scannedThrough`；客户端只有在
整页成功提交后才将 `remoteHwm` 推进到该值。否则无权限行造成的 ID 空洞会导致永久重复扫描。

### 6.6 远端消息去重

现有 `originSeq` 在改造期间仍可用于旧协议兼容和 thread 内语义，但新 change feed 必须持久保存：

```text
originDomain             varchar(63)
originMessageId          bigint
unique (originDomain, originMessageId)
```

该唯一约束是重试、分页回滚和重复 push 下的最终去重后盾。

## 7. SYSTEM 消息

### 7.1 类型

新增 `ContentType.SYSTEM`。payload 使用带版本的判别联合，不使用含义模糊的 `{type:"delete"}`：

```json
{
  "version": 1,
  "event": "friend_deleted",
  "relationshipEpoch": 3,
  "actor": { "account": "alice", "domain": "a.example" },
  "subject": { "account": "bob", "domain": "b.example" }
}
```

首批事件：

- `friend_deleted`；
- `group_member_joined`；
- `group_member_left`（本人主动退出）；
- `group_member_removed`（被 owner/admin 移除）；
- `group_dissolved`。

群事件携带稳定 group address、`membershipEpoch`、actor 和 subject。客户端根据当前用户与
actor/subject 的关系显示“你删除了对方”“对方删除了你”“你退出了群聊”“你被移出群聊”等文案。

拉黑、屏蔽、重复删除、好友不存在及普通权限失败不创建 SYSTEM 消息：按既有幂等成功或 toast
处理。消息撤回/举报继续使用专门的删除模型，不改造成关系 SYSTEM 消息。

### 7.2 强制限制

SYSTEM 消息只能由服务端创建，并在后端和客户端同时强制：

- 不可撤回；
- 不可举报；
- 不可转发；
- 不可编辑；
- 不可回复/引用；
- 多选模式不可选中。

### 7.3 epoch 防止旧事件破坏新关系

每次重新加好友或重新入群都会增加对应 epoch。收到 SYSTEM 事件时：

- 事件 epoch 等于当前 active epoch：应用状态变化；
- 事件 epoch 小于当前 epoch：只按需要保存历史消息，不改变当前关系；
- 事件 epoch 大于预期：暂停该关系流并触发定向 reconciliation，不猜测中间状态。

因此旧的 `friend_deleted(epoch=1)` 可以与重新加好友后的新关系及未来
`friend_deleted(epoch=2)` 同时存在，且不会误删 epoch 2。

## 8. 持久 change feed 与 missed API

### 8.1 S2S HWM

提供一个轻量查询，返回调用 peer 当前可访问集合中的最大源端 `Message.id`：

```text
GET /api/v1/s2s/messages/hwm
200 { "latestMessageId": "92831" }
```

没有可访问消息时返回 `"0"`。值仅用于判断“可能有变化”，不代表调用方已经同步。

### 8.2 S2S missed

```text
GET /api/v1/s2s/messages/missed?afterOriginMessageId=90000&take=100
```

响应示意：

```json
{
  "items": [],
  "scannedThrough": "90100",
  "latestMessageId": "92831",
  "hasMore": true
}
```

查询语义：

1. 以请求开始时的可见 HWM 作为本次响应上界；
2. 扫描 `Message.id > afterOriginMessageId`，按 ID 升序；
3. join `ThreadAudience` 的 peer 可见区间，并应用可选 `SystemMessageTarget`；
4. 返回消息携带源端 `originMessageId`（即服务端本地 `Message.id`）；
5. `scannedThrough` 是本页已经检查到的最大源端 ID，即使其中部分行因不可见而未返回；
6. `hasMore` 表示固定上界内仍有未扫描 ID；
7. 媒体正文只返回元数据/digest，二进制继续由 `get_file` 获取。

默认 `take=100`，最大 `take=500`。服务端可因响应体达到 4 MiB 提前结束页面，但必须准确返回
`scannedThrough` 和 `hasMore`。实现可使用 `take+1` 或基于扫描窗口的等价方式判断后续数据。

### 8.3 轻量 push/SSE

原 `FederationBufferService` 内存 hint 不再承担正确性职责，并在切换完成后删除。push 仅发送：

```json
{
  "originDomain": "a.example",
  "latestMessageId": "92831"
}
```

接收者将其视为 wake-up signal，随后调用 missed。push 丢失由定时 HWM reconciliation 恢复。
建议 trusted peer 在建立连接、重连后立即查询 HWM，在线时按 NAS 友好的低频周期再次查询；精确
周期作为部署配置，不属于 wire contract。

### 8.4 客户端 missed

客户端使用本地消息 ID 调用等价增量接口：

```text
GET/POST client missed(afterMessageId: decimal-string, take: 100)
```

响应同样提供 `scannedThrough`、`latestMessageId`、`hasMore`。SSE `NEW_MESSAGE` 只携带本地
`latestMessageId` 用于唤醒。客户端在一个页面完整写入其本地存储后才持久推进 cursor。

客户端 thread revision 仍用于 thread 列表 ADD/DELETE 变化；消息 ID missed 负责发现消息，二者
不能互相替代。

## 9. 事务边界

### 9.1 本地关系变化

以下操作必须在同一数据库事务完成：

1. 校验当前 relationship/membership epoch；
2. 更新好友或群成员状态；
3. 插入 SYSTEM `Message`；
4. 插入所需 `SystemMessageTarget`；
5. 关闭旧 `ThreadAudience`，且 `visibleThroughMessageId` 包含终止 SYSTEM 消息；
6. 写入/更新受影响用户的 `ThreadRevision`；
7. 提交后才发送 SSE 和联邦轻量 push。

事务失败时所有状态回滚，不允许出现“关系已删除但终止消息未进入 change feed”。

### 9.2 远端 missed 页面

一个响应页面作为一个本地事务处理：

1. 验证响应身份和页面边界；
2. 按 `(originDomain, originMessageId)` 去重插入消息；
3. 应用 SYSTEM epoch 状态机；
4. 更新 audience、target 和 ThreadRevision；
5. 将 `FederationPullCursor.remoteHwm` 推进到 `scannedThrough`；
6. 提交后才发本地 SSE。

任一消息失败则整页回滚，HWM 不推进。建议事务超时 10–15 秒；连续处理 10 页或 1000 条后让出
执行权，再继续追赶，避免 NAS 上的 PostgreSQL 长时间被同步任务占用。

## 10. reset 与禁止继承旧授权

### 10.1 reset 前置条件

只有 `identity_lost` peer 可执行本设计的 identity reset。操作必须：

- 仅限最高权限管理员；
- 明示 domain、关联用户/thread/message 数量和不可恢复警告；
- 二次确认并输入 domain；
- 写入不可删除的管理员安全审计记录；
- 不允许普通 `/init`、重连任务或数据库启动逻辑隐式触发。

### 10.2 原子锁定与物理清理

reset 作业先获得该 peer 的排他维护锁，阻止其 S2S 和本地相关写入。随后在可重试的维护事务/作业中
物理删除或解除：

- peer 的 pull cursor、audience、target、去重、key cache 和 operation-seen 数据；
- 该 domain 的外域用户和由它代表的群镜像；
- 与这些用户相关的好友、邀请、群成员和 thread participant；
- 仅属于该 peer 关系的消息、删除记录、转发依赖和媒体引用；
- 失去任何本地参与者的孤立 thread。

共享 group/thread 不能按 domain 粗暴整表删除；必须先计算所有权和剩余本地/其他 peer 参与者，
只清除该 peer 的可见性与实体。媒体按现有 CAS 引用计数回收。

对仍存在但内容发生变化的本地用户 thread 写入新的 DELETE/ADD revision，使客户端收敛。
历史 `ThreadRevision` 行无需为 reset 单独物理删除；若其外键级联随已删除 thread 清理，属于现有
数据库完整性行为，不把它们复制到新身份。

### 10.3 reset 后

reset 完成后：

- 删除原 `FederatedPeer` 身份锚点，另存仅供安全判断的 domain reset tombstone；
- tombstone 的 `resetGeneration` 增加；
- 只有 reset 时管理员明确选择“允许重新接入”，同 domain 才能再次 init；它被视为全新 peer，
  但不能恢复任何旧用户 ID、关系 epoch、thread audience、
  消息访问权、邀请或群成员资格；
- 必须由用户重新加好友、重新邀请入群，产生新的关系与 membership epoch；
- 旧授权永远不能仅凭 domain、account 名称相同而继承。

## 11. 错误与重试分类

建议新增稳定业务错误：

- `FEDERATION_IDENTITY_MISMATCH`：409，触发本地 peer `identity_lost`；
- `FEDERATION_PEER_IDENTITY_LOST`：423，不重试；
- `FEDERATION_LOCAL_IDENTITY_LOST`：503，不重试，需恢复密钥；
- `FEDERATION_IDENTITY_PROOF_INVALID`：401，不直接判 identity lost；
- `FEDERATION_CURSOR_INVALID`：400；
- `FEDERATION_CURSOR_AHEAD`：409，调用方不得自动倒退 cursor；
- `FEDERATION_RELATIONSHIP_EPOCH_GAP`：409，触发定向 reconciliation。

所有错误响应不得回显私钥、HMAC 派生材料或其他 peer 的 pairwise ID。

## 12. 实现顺序与验收条件

后续实现按以下依赖顺序推进，每一项单独审核：

1. v1 身份文件、本机身份锚点和启动保护；
2. peer identity 字段、init/identity wire contract 和状态机；
3. audience/cursor/origin ID 数据库迁移和回填；
4. SYSTEM 消息类型、epoch 与本地关系事务；
5. S2S HWM/missed、持久拉取游标和轻量 wake-up；
6. 客户端 missed 与 SYSTEM 交互限制；
7. identity reset 作业和管理端；
8. 删除旧内存 hint 正确性路径与旧冲突文档。

本功能至少通过以下场景才算闭环：

- A 写消息后在 push 前重启，B 仍通过 HWM/missed 拉到消息；
- push 重复、乱序或丢失不丢消息且不重复落库；
- 页面第 N 条失败时整页与 HWM 回滚；
- 同 domain 换服务器或换 root key 后进入 `identity_lost`，不会自动 init；
- 正常 old→new signing-key proof 不改变 peer identity；
- 密钥文件丢失但数据库有历史时不自动生成；
- 删除好友/退出/踢人事件与 audience 终点在同一事务；
- 旧 epoch 的延迟删除事件不破坏重新建立的关系；
- SYSTEM 消息无法由客户端伪造、撤回、举报、转发、引用或多选；
- reset 不影响其他 peer 或纯本地 thread，且同 domain 新节点不继承旧授权。

## 13. 与当前实现的明确差异

实施后必须同步修正以下当前行为和文档：

- 当前 `/s2s/init` 对同 domain 的新 well-known key 验签成功后会自动 `markTrusted`；新设计禁止；
- 当前 `KeypairService` 在文件缺失时总会生成新 key；有联邦历史时新设计禁止；
- 当前 `FederationBufferService` 是进程内 hint；新设计以持久 audience + Message ID feed 保证发现；
- 当前 S2S 增量主要使用 `(thread, author, originSeq)`；新 missed feed 使用源端 `Message.id`；
- 当前好友删除没有权威 S2S 终止事件、群 leave 依赖 hint/410；新设计使用持久 SYSTEM 消息；
- 当前客户端依赖 thread revision + per-thread seq 发现缺口；新设计增加服务器级本地 Message ID missed。

兼容窗口内可保留旧接口供旧客户端/旧 peer 使用，但旧路径不得继续被宣称具有重启后的完整性；
新 capability 未协商成功前，不得假设对端支持 identity pinning 或 durable missed。
