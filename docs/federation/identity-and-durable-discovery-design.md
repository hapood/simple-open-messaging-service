# 联邦节点身份连续性与持久消息发现设计

> **状态：实施中的权威设计与验收清单** > **更新：2026-08-08**
> 本文已合并原 `synchronous-giggling-pancake.md`，统一描述身份连续性、持久消息发现、媒体下载
> inbox、统一上传与 GALLERY。明确标为“待完成”的条目不是当前能力；其余协议约束应与实现同步。

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
- 关系终止以 state-feed 的持久 meta 为准，不能从普通消息或一次拉取失败推断；
- 身份连续性丢失后不自动恢复；DNS 修复且原身份全部重新出现时，最高权限管理员可执行非破坏性
  原 pin 恢复。身份确实改变时仍只允许破坏性的 reset。

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

当前 `soms-s2s-key.json` 中只有一个 Ed25519 密钥对。它同时作为身份 root key 和 S2S signing
key；两处字段是同一份密钥材料的逻辑表示，不会生成第二把 key。

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

### 2.4 消息 ID

`Message.id` 只在生成它的数据库内单调递增：

- S2S 的 `changeId` / `afterChangeId` 属于源联邦服务器为该 peer 分配的全局 change feed；
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
4. 不得静默生成新 key，也不得调用 `/s2s/v1/ignite` 自动恢复同一 domain。

### 3.3 单密钥约束

本协议不支持在线密钥轮换。well-known 的 `keys` 为兼容既有 wire shape 保持数组形式，但必须且
只能包含一个 key；`keyId` 或公钥发生变化都表示身份连续性丢失。缓存中的同名 `keyId` 不允许
覆盖公钥，旧缓存必须保留作为判断依据。

## 4. 远端节点身份状态机

建议 `FederatedPeer.trustLevel` 明确支持：

```text
pending --首次 /init--> trusted --传输失败--> demoted --固定身份 + 签名 ping--> trusted
                 \-> blocked
                 \-> identity_lost
```

状态含义：

- `pending`：尚未完成首次握手；
- `trusted`：身份三元组匹配，可处理授权范围内的流量；
- `demoted`：暂时连接失败，可用已固定身份和签名心跳自动恢复，但禁止重新 `/init`；
- `blocked`：管理员策略阻断，不自动重试；
- `identity_lost`：domain 返回了与固定身份不一致的服务器，永久停止自动重试和自动 init。

固定三元组为：

```text
(normalizedDomain, pairwiseServerId, rootKeyFingerprint)
```

以下任一情况进入 `identity_lost`：

- pairwise server ID 改变；
- root fingerprint 改变；
- 已固定的 `keyId` 或公钥被替换，或出现第二个 key；
- 本地发现 peer 历史存在，但固定身份字段缺失或互相冲突，无法安全迁移。

网络超时、DNS 失败、TLS 失败、5xx 和签名格式错误不直接等同 identity loss；它们保持现有可重试
失败/降级语义。只有成功取得并验证了相互矛盾的身份材料，才能设置不可恢复状态，避免网络攻击
仅靠阻断请求就触发破坏性状态。

处于 `identity_lost` 时锁住的是该 peer 的联邦命名空间，不是整个本地数据库：

- 拒绝该 domain 的所有 S2S 入站；
- 不再向该 domain 发起 init、ping、push、miss 或业务请求；
- 本地其他 peer 和纯本地聊天继续工作；
- 与该 peer 相关的 thread 变为只读/不可发送，等待管理员验证原 pin 或执行 reset；
- 不自动删除任何数据。

## 5. 身份协议

### 5.1 公开 well-known

`GET /.well-known/soms` 继续是公开端点，只发布软件版本、严格递增的 `protocolVersions`、root public key 与唯一的
signing key。它不返回 pairwise server ID，因为公开请求没有可靠的请求方身份。

### 5.2 首次 init

`POST /s2s/v1/ignite` 请求体至少为：

```json
{
  "protocolVersion": 1,
  "originDomain": "a.example",
  "recipientDomain": "b.example",
  "pairwiseServerId": "...value derived for b.example...",
  "rootKeyFingerprint": "sha256:...",
  "startChangeId": "0",
  "nonce": "base64url...",
  "issuedAt": 1785888000000
}
```

`issuedAt` 使用统一的 Unix epoch milliseconds JSON number；不得发送 ISO 时间字符串。

所有字段和 content digest 必须由 RFC 9421 请求签名覆盖。接收端还必须验证：

- `originDomain` 等于签名 keyId 的规范化 domain；
- `recipientDomain` 等于本机 domain，防止把 A→B 的 pairwise ID 转交给 C；
- root fingerprint 与 well-known root key 匹配；
- nonce 未使用且时间在允许窗口内；
- `startChangeId` 是十进制 bigint 字符串，并被身份声明签名覆盖；
- 若 peer 已存在，固定三元组必须完全匹配。

首次成功可按现有产品策略自动建立 `trusted`；“自动建立信任”只适用于数据库中从未出现过该
domain，或管理员刚完成破坏性 reset、因而允许该 domain 作为全新 peer 再次接入的情况。reset 后的
`/init` 可以建立新的服务器级信任，但不能恢复任何旧用户、关系、群成员或消息授权。

响应返回本机针对 origin 派生的同结构身份声明，并使用本机 active signing key 做 detached
application signature。不能依赖 TLS 响应本身证明 pairwise payload 来自预期联邦身份。

well-known、HTTP 签名和声明签名的网络验证在事务外完成。验证通过后，接收端在一个数据库事务中
消费 nonce、固定 `FederatedPeer` 身份、消费 reset reinit 授权、写审计事件，并同时建立
`FederationServeCursor` 与 `FederationPullCursor`。因此管理 UI 看到 `trustLevel=trusted` 时，两条
cursor 必然已经存在；任一步失败则全部回滚，不使用额外 initialized flag 或补偿状态。

### 5.3 重连身份查询

新增：

```text
GET /s2s/v1/identity?nonce=<nonce>
```

请求必须签名。响应包含 `domain`、`recipientDomain`、`pairwiseServerId`、
`rootKeyFingerprint`、`nonce`、`issuedAt`、active key 列表摘要和 detached signature。

重连顺序：

1. 解析服务地址并读取 well-known；
2. 验证唯一 signing key 与已固定 key 完全相同；
3. 调用 identity endpoint，校验接收方绑定、nonce、响应签名和固定三元组；
4. 只有成功后才发 ping/miss/业务请求；
5. 身份矛盾时原子设置 `identity_lost`。

身份 endpoint 允许已知且处于 `trusted`、`demoted` 或 `identity_lost` 的 peer 用原 signing key 调用。
`demoted` 可因有效 proof 自动恢复；向 `identity_lost` peer 返回 proof 不改变服务端本地 trust 状态，
只用于避免双方同时 identity loss 时的人工恢复死锁。`identity_lost` 的管理员恢复必须由最高权限管理
动作显式触发，绕过 discovery cache，并额外逐项比对事故前的 root fingerprint、唯一 signing key 与
pairwise ID。`blocked` 与 `reset_in_progress` 不允许调用。

## 6. 数据模型草案

字段名是实现目标，最终 Drizzle/SQL 类型在迁移步骤审核。

### 6.1 LocalFederationIdentity

数据库保存非秘密的本机身份锚点，用于检测密钥文件丢失或 domain 被修改：

```text
domain                  varchar(63) primary key
rootKeyFingerprint      varchar(80) not null
createdAt               timestamp not null
```

### 6.2 FederatedPeer 扩展

```text
pairwiseServerId        varchar(64) null
rootKeyFingerprint      varchar(80) null
identityPinnedAt        timestamp null
identityLostAt          timestamp null
identityLostReason      varchar(255) null
resetGeneration         integer not null default 0
resetAt                 timestamp null
```

旧 peer 的首次升级不能仅凭当前 well-known 自动固定身份。迁移策略必须在实现步骤选择并测试：
已有联邦关系的 peer 需通过双方升级后的身份握手完成 pin；在 pin 完成前不得接受 key 改变。

### 6.3 ThreadAudience

本地用户和远端 peer 共用“当前访问集合”：

```text
id                       bigserial primary key
targetDomain              varchar(63) not null (`local` 或远端 domain)
localUserId               integer null（仅 targetDomain=`local`）
threadId                  integer not null
deliverThroughChangeId    bigint null
createdAt                 timestamp not null
```

约束：

- `targetDomain='local'` 必须设置 `localUserId`，其他 domain 禁止设置；
- 同一 target/thread 最多一条 audience；
- 解除好友、退出群聊、被踢，或远端 domain 的最后一个本地群成员离开时物理删除对应行；
- 重新获得权限时直接重新插入，不保留 thread 级 epoch 或 pull cursor；
- 同一服务器的群消息缓存由该服务器上的成员共享：仍有其他成员时继续拉取并缓存，重新加入者
  可以看到服务器已经缓存的历史；
- `THREAD` 表示当前订阅整个 thread，撤权时物理删除；
- 建议索引：
  - unique `(targetDomain, localUserId, threadId)`（local partial）；
  - unique `(targetDomain, threadId)`（peer partial）；
  - `(localUserId, threadId)`（local partial）；
  - `(targetDomain, threadId)`（peer partial）；
  - `Message(threadId, id)`。

### 6.4 Durable discovery change feed

`Message.id` 的 PostgreSQL sequence 分配顺序不等于事务提交顺序，不能单独承担可靠 HWM。
持久发现使用按目标分配、事务内递增的 change ID：

```text
DiscoveryTarget
id                       bigserial primary key
targetDomain             varchar(63) not null
localUserId              integer null
allocatedThrough         bigint not null default 0

DiscoveryChange
targetId                 bigint not null
changeId                 bigint not null
audienceId               bigint null
threadId                 integer not null
messageId                bigint not null
primary key              (targetId, changeId)
unique                   (targetId, messageId)
```

消息事务对每个可见目标锁定其 `DiscoveryTarget` 行，递增 `allocatedThrough` 并插入
`DiscoveryChange`。该字段只负责源端事务型 change ID 分配和行锁，不是接收端 HWM。
`audienceId` 记录产生 change 时有效的访问授权。撤销当前访问时该外键 `ON DELETE SET NULL`，但
`DiscoveryChange` 在确认前作为该 target 的持久投递记录；重新插入 audience 后只为此后新消息产生
change。CAS/bundle 下载不依赖 change：源端 join signer 的 `ThreadAudience`，再验证精确 Message 与
digest/bundle 绑定，因此确认后的 change 物理清理不会中断资源下载。

### 6.5 FederationPullCursor

```text
peerDomain               varchar(63) primary key
startChangeId            bigint not null
remoteHwm                bigint not null default 0
updatedAt                timestamp not null
```

双方首次可信互联时交换各自当前 `DiscoveryTarget.allocatedThrough`，作为初始
`startChangeId`。接收端以它初始化 `remoteHwm`，源端拒绝任何 `afterChangeId < startChangeId`，
从协议层禁止读取建立信任前的历史。

`remoteHwm` 表示已经完整扫描并在本地页事务中写入的远端 change ID：文本消息直接落 `Message`，媒体消息落 `PendingMessage`（见 §12），二者都使 `remoteHwm` 推进；媒体文件本地化在页事务外异步进行，不阻塞 `remoteHwm`。接收端不维护 `deliverableThrough` 或其他 change 级交付游标；`changeId` 只保证发现、分页和去重，不规定消息进入本地 `Message` 表的顺序。收到 push/SSE 只在进程内合并
最新 wake-up HWM 并安排任务，绝不能推进 `remoteHwm`，也不持久化 hint；断线恢复后双方重新发送或
查询当前 HWM。每个 peer 只有这一条全局 cursor；拉取任务使用按 peer 派生的 PostgreSQL 事务级
advisory lock 作为数据库级 pull 锁，不维护任何 thread 级 pull seq/cursor。

源端另存一条 `FederationServeCursor`：

```text
peerDomain               varchar(63) primary key
targetId                 bigint unique not null
startChangeId            bigint not null
acknowledgedThrough      bigint not null
lastServedThrough        bigint not null
```

`/missed?after=X` 在数据库事务中以 `FOR UPDATE NOWAIT` 锁定该行。同一 peer 已有请求执行时，
后来的请求立即返回 `FEDERATION_MISSED_CONCURRENT`，不排队。X 必须满足
`startChangeId <= X`、`acknowledgedThrough <= X` 且 `X <= allocatedThrough`：禁止回退和伪造超前
ACK，但允许调用方跳过已经确认落库的区间。页面扫描成功后，同一事务将
`acknowledgedThrough` 设为 X，并记录新的 `lastServedThrough`；扫描或响应组装失败则全部回滚。
初始化时三个水位均等于 `startChangeId`。
cursor 被拒绝时，错误 `data` 返回十进制字符串形式的 `requestedCursor`、`availableCursor`、
`startChangeId` 和 `allocatedThrough`；调用方使用 `availableCursor` 恢复请求，不使用 JSON number。

SOMS 每五分钟尝试一次 message change GC。多进程通过 session advisory lock 保证全局只有一个 sweep；
未取得锁的实例立即退出。普通 sweep 检测到数据库存在其他 active client query 时跳过，紧急积压除外。
单 target 使用 cursor/target 行锁和 `SKIP LOCKED`，不执行 `LOCK TABLE`：

- 物理删除 `changeId <= acknowledgedThrough`，并把 retained `startChangeId` 推进到确认水位；
- 单 target 实际残留超过 10,000 条时强制物理删除最旧一半，并原子抬高 `startChangeId`、
  `acknowledgedThrough`、`lastServedThrough`；
- 紧急积压即使系统忙也尝试，若该 target 正在 serve、分配或 reset 则本轮跳过；
- destructive peer reset 物理删除其 `DiscoveryTarget`，级联清除 change/serve cursor，并显式删除
  peer audience；与 GC 对同一行自然串行。

receiver 收到单调前进的 cursor-invalid floor 后，在本地 pull cursor 事务中同时更新
`startChangeId/remoteHwm`，不发布空缺区间的消息副作用，然后立即从新 `availableCursor` 继续。

如果拉取结果允许因无权限而跳过 ID，响应必须返回服务端扫描水位 `scannedThrough`；客户端只有在
整页成功提交后才将 `remoteHwm` 推进到该值。否则无权限行造成的 ID 空洞会导致永久重复扫描。

### 6.7 远端消息去重

现有 `originSeq` 在改造期间仍可用于旧协议兼容和 thread 内语义，但新 change feed 必须持久保存：

```text
originDomain             varchar(63)
originMessageId          bigint
unique (originDomain, originMessageId)
```

该唯一约束是重试、分页回滚和重复 push 下的最终去重后盾。

统一查询不传 thread type：`localAccount` 以 `!` 开头表示群聊，否则表示 P2P。统一返回
`active`、`revision`、`role`、`reason`；P2P active 时 `role` 固定为 `MEMBER`。P2P 查询用户
home server，群聊查询 group origin。

查询发出时捕获 relationship/meta revision、peer `resetGeneration` 和 thread
`federationVersion`。写入迟到响应前在同一事务重新比较；任何一项变化都丢弃响应。有效响应在事务
内更新 participant/audience/ThreadRevision，提交后通过 SSE 异步修正客户端，不阻塞打开本地缓存。

## 7. 两条持久 feed 与 revision 唤醒

本节记录实现设计；wire contract 以 `spec/v1/` 为准。联邦只有 state feed、message feed 两条持久
拉取流，以及一个只携带两条流最新 revision 的轻量 push；不存在单独的 HWM 查询或 `missed` API。

### 7.1 Message feed

```text
GET /s2s/v1/message-feed?after=90000&take=100
```

响应示意：

```json
{
  "messages": [],
  "scannedThrough": "90100",
  "allocatedThrough": "92831",
  "hasMore": true
}
```

查询语义：

1. 以请求开始时的 `allocatedThrough` 作为本次响应上界；
2. 扫描该 peer 的 `DiscoveryChange.changeId > afterChangeId`，按 change ID 升序；
3. change 必须仍关联当前存在的 `ThreadAudience`；
4. 直接返回实际消息正文和附件描述，媒体二进制仍按需下载；
5. `scannedThrough` 是本页已经完整检查到的最大 change ID，即使部分 change 已级联删除；
6. `hasMore` 表示固定上界内仍有未扫描 ID；
7. 不再二次调用任何 thread 级消息 pull，也不维护 thread 级 pull seq/cursor。

每个消息项必须携带稳定的 `originSeq`（源端本地消息使用其源 thread `seq`，不得返回 `null`）。引用
消息额外携带 `quoteTarget: { creator, originSeq }`，接收端不能直接复用源端正文里的本地 quote seq。
已经删除的消息不向 peer 传输；源端扫描时跳过该 change，并通过 `scannedThrough` 跨过其 ID。
接收端已有的 tombstone 仍负责阻止迟到或重复消息重新出现。
附件描述必须与正文中的 digest 集合一致，接收端不接受缺失、重复或非 `READY` 的描述。

默认 `take=100`，硬上限 `take=200`，以限制 NAS 上一次事务的行数和响应组装成本。页面事务设置
10 秒 `statement_timeout`、15 秒 `idle_in_transaction_session_timeout`，应用层总截止时间为 15 秒；
超时或响应组装失败都回滚 cursor 更新。页面不足 `take` 时，`scannedThrough` 直接推进到锁内固定的
`allocatedThrough`，因此 audience 删除造成的 change ID 空洞不会被永久重复扫描。

### 7.2 State feed

```text
GET /s2s/v1/state-feed?after=120&take=100
```

它传输 profile、好友关系和群状态快照/墓碑，使用独立的 `stateFeedRev`、分页 cursor 和事务边界；
不得借用 message feed 的 change ID。详细事件、分页和授权规则见 `spec/v1/state-feed.md`。

### 7.3 轻量 revision push

原 `FederationBufferService` 内存 hint 不再承担正确性职责，并在切换完成后删除。push 仅发送：

```json
{
  "origin": "a.example",
  "stateFeedRev": "180",
  "messageFeedRev": "92831"
}
```

发送路径为 `POST /s2s/v1/feed-revisions`。接收者校验 `origin` 等于签名域，仅在进程内合并两个
revision 并将其视为 wake-up signal，随后分别拉取落后的 feed；它不直接写入任何 pull cursor，也
不表示远端已经收到具体事件。push 失败按普通 S2S 传输失败处理；push 丢失由建立连接、重连和
低频 reconciliation 时再次发送当前 revision 恢复。精确重试周期属于实现配置，不是 wire contract。

### 7.4 客户端 missed

客户端使用本地消息 ID 调用等价增量接口：

```text
GET/POST client missed(afterChangeId: decimal-string, take: 100)
```

响应提供实际消息正文和附件描述，以及 `scannedThrough`、`allocatedThrough`、`hasMore`；媒体
二进制仍按需下载。SSE `NEW_MESSAGE` 只携带最新 change ID 用于唤醒。客户端在一个页面完整写入
其本地存储后才持久推进 cursor。

客户端 thread revision 仍用于 thread 列表 ADD/DELETE 变化；消息 ID missed 负责发现消息，二者
不能互相替代。

## 8. 事务边界

### 8.1 本地关系变化

以下操作必须在同一数据库事务完成：

1. 校验当前 relationship/membership revision；
2. 更新好友或群成员状态；
3. 物理删除不再有效的 `ThreadAudience`；
4. 写入/更新受影响用户的 `ThreadRevision`；
5. 提交后才发送 SSE。

删除好友、被踢或退群不发送独立终止 change；删除 audience 后自然停止产生后续消息 change。

### 8.2 远端 missed 页面

一个响应页面作为一个本地事务处理：

1. 验证响应身份和页面边界；
2. 对每条消息执行共享的内容校验（见 §12：contentType 与 content 形状自洽、digest 形态、文本上限、quote 一致性等）；校验失败（格式错误）的消息使整页回滚；
3. 按 `(originDomain, originMessageId)` 去重，并按消息形态分流：
   - 已有匹配 tombstone（born-deleted）→ 落 `Message(isDeleted=true)`，跳过 `PendingMessage` 与媒体下载；
   - 纯文本消息 → 直接落 `Message`；
   - 媒体消息 → 落 `PendingMessage` + 每文件一行 `FileSyncProgress(PENDING)`；
4. 应用有效的权威状态修正；
5. 将 `FederationPullCursor.remoteHwm` 推进到 `scannedThrough`；
6. 提交后立即为本事务中新落 `Message` 的文本/born-deleted 消息发送本地 SSE；`PendingMessage` 中的媒体消息在 §12.5 promote 提交后立即 SSE。发送 SSE 的唯一交付条件是消息已经正式进入 `Message` 表，不等待更小 `changeId` 对应的 pending 媒体，也不推进额外的连续交付水位。

页事务只覆盖消息正文落库与游标推进；媒体文件本地化在事务外异步进行（§12），不阻塞 `remoteHwm`。任一消息的**格式校验**或去重冲突失败则整页回滚，HWM 不推进；但媒体未下载**不构成**页失败。建议事务超时 10–15 秒；连续处理 10 页或 1000 条后让出执行权，再继续追赶，避免 NAS 上的 PostgreSQL 长时间被同步任务占用。

## 9. reset 与禁止继承旧授权

### 9.0 非破坏性原 pin 恢复

`identity_lost` 不会被后台任务自动恢复。确认 DNS 已修复后，最高权限管理员可输入 peer domain 发起
恢复探测。实现清除该 domain 的 discovery cache，重新获取 well-known，并使用新 nonce 请求签名
identity proof。只有 root fingerprint、唯一 keyId/公钥和 pairwise server ID 与已有 pin 全部相同，
才把 trust edge 恢复为 `trusted`；操作保留 `trustedAt`、cursor、mirror、authorization 和历史数据，
并写入管理员审计与 peer `recovered` 事件。探测失败或任一字段不同都保持 `identity_lost`。

该操作不能接受新身份。原私钥丢失、服务器确实更换或无法重新取得全部原 pin 时，必须使用以下
destructive reset。

### 9.1 reset 前置条件

只有 `identity_lost` peer 可执行本设计的 identity reset。操作必须：

- 仅限最高权限管理员；
- 明示 domain、关联用户/thread/message 数量和不可恢复警告；
- 二次确认并输入 domain；
- 写入不可删除的管理员安全审计记录；
- 不允许普通 `/init`、重连任务或数据库启动逻辑隐式触发。

### 9.2 原子锁定与物理清理

reset 作业先获得该 peer 的排他维护锁，阻止其 S2S 和本地相关写入。随后在可重试的维护事务/作业中
物理删除或解除：

- peer 的 pull cursor、audience、target、去重、key cache 和 operation-seen 数据；
- 该 domain 的外域用户和由它代表的群镜像；
- 与这些用户相关的好友、邀请、群成员和 thread participant；
- 仅属于该 peer 关系的消息、删除记录、转发依赖和媒体引用；
- 保留 thread 实体，只解除该 peer 的参与关系和可见性。

共享 group/thread 不能按 domain 粗暴整表删除；必须先计算所有权和剩余本地/其他 peer 参与者，
只清除该 peer 的可见性与实体。媒体按现有 CAS 引用计数回收。

对失去该 peer 关系的本地用户写入新的 DELETE revision，并将对应 ADD revision 的 `isDelete`
置为 true，使客户端收敛。`MessageThread` 和历史 `ThreadRevision` 均保留，不做物理删除。
本地或第三方所有的共享群只移除该 peer 的成员和内容，不从其他成员的 thread 列表删除。

清理不使用跨 thread 的长事务。全局同一时间只允许一个 domain 处于 reset；相关数据在此期间冻结。
每个异步联邦请求发出时捕获 `MessageThread.federationVersion`，响应返回时同时验证 domain reset 状态
和当前 version。单个 thread 清理成功后，最后一条原子更新将 `federationTruncated` 置为 true，并将
`federationVersion` 加一。因此旧节点的 inflight 响应即使晚于 reset 完成或新节点握手，也不能插入
新身份的数据。服务重启后继续枚举相关且 `federationTruncated=false` 的 thread。

### 9.3 reset 后

reset 完成后：

- 删除原 `FederatedPeer` 身份锚点，另存仅供安全判断的 domain reset tombstone；
- tombstone 的 `resetGeneration` 增加；
- reset 与 init 保持为两个独立动作：reset 完成后留下一个待消费的重新初始化许可；随后可由管理员
  主动发起握手，或由正常客户端握手流程触发 `/init`；
- 第一次成功 `/init` 固定全新身份后立即消费该许可。同 domain 被视为全新 peer，但不能恢复任何
  旧用户 ID、关系状态、thread audience、
  消息访问权、邀请或群成员资格；
- 必须由用户重新加好友、重新邀请入群，重新建立当前 audience；
- 旧授权永远不能仅凭 domain、account 名称相同而继承。

## 10. 错误与重试分类

建议新增稳定业务错误：

- `FEDERATION_IDENTITY_MISMATCH`：409，触发本地 peer `identity_lost`；
- `FEDERATION_PEER_IDENTITY_LOST`：423，不重试；
- `FEDERATION_LOCAL_IDENTITY_LOST`：503，不重试，需恢复密钥；
- `FEDERATION_IDENTITY_PROOF_INVALID`：401，不直接判 identity lost；
- `FEDERATION_CURSOR_INVALID`：400；
- `FEDERATION_CURSOR_AHEAD`：409，调用方不得自动倒退 cursor；
- `FEDERATION_RELATIONSHIP_REVISION_GAP`：409，触发定向 reconciliation。

所有错误响应不得回显私钥、HMAC 派生材料或其他 peer 的 pairwise ID。

## 11. Download inbox / file sync 持久层

> 本节定义附件本地化的持久化与状态机，取代当前 fire-and-forget 的 `localizeMedia`。所有携带附件的
> 消息（本地出站上传与联邦入站下载统一处理）必须先将其引用的全部文件本地化为 `SUCCEEDED`，才
> promote 进 `Message` 表；否则停在 `PendingMessage`，对接收方不可见，直到管理员处理。

### 11.1 目标与非目标

固定原则：

- 消息正文与媒体本地化解耦：正文落 `PendingMessage`，每个文件的任务落 `FileSyncProgress`，二者以
  `batchId` 关联；
- 一条消息引用的全部文件 `SUCCEEDED` 后，消息才 promote 进 `Message` 并分配本地 `seq`；任一文件处于
  `DOWNLOADING` 或终态 `FAILED`，消息停在 `PendingMessage`，对接收方不可见；
- 消息的本地可见顺序和本地 `seq` 以**实际进入 `Message` 表的顺序**为准，不保证与远端
  `changeId`、`originSeq` 或联邦权威服务器上的展示顺序一致（已接受的取舍）；
- 后续文本或较早完成的媒体可以先于更小 `changeId` 的 pending 媒体进入 `Message` 并立即 SSE；不设置
  peer 级 `deliverableThrough`，也不因一个慢文件阻塞该 peer 的其他正式消息；
- 媒体本地化不参与 missed 页事务，不阻塞 `remoteHwm`；
- 已实现进程级下载调度器：全局并发和单 peer 并发由管理设置控制，默认分别为 10 和 2；同一
  `(peerDomain, digest)` 的并发任务 single-flight，共享一次物理下载。
- 服务启动时扫描并恢复遗留的 `PENDING/DOWNLOADING` 任务；管理员明确 retry 前，不自动重试干净失败
  的 `FAILED`。
- 管理员提高一次性 quota 且该 peer 的 breaker 已全部解除后，自动唤醒对应 peer 的
  `QUOTA_PAUSED` 任务；仍有任一维度超限时保持暂停。

非目标：

- 不提供下载的自动重试或退避：干净失败即终态 `FAILED`；
- 不保证失败或进行中的消息对客户端可见；
- 不保证多文件消息（相册/bundle）内的展示顺序与发送顺序一致。

### 11.2 数据模型

`PendingMessage`——消息暂存，出站上传与入站下载共用，按 `direction` 区分：

```text
id                        bigserial primary key
direction                 OUTBOUND | INBOUND
batchId                   uuid not null                  -- 一条消息的全部文件共用
threadId                  integer not null
contentType               contentType not null           -- FILE/IMAGE/VIDEO/AUDIO/ALBUM 或 FORWARD
content                   jsonb not null                 -- 拉来的正文（INBOUND）或发送意图（OUTBOUND）
clientMessageId           varchar null                   -- OUTBOUND 去重
-- INBOUND 身份（OUTBOUND 为 null）：
creatorId                 integer null
originSeq                 integer null
originDomain              varchar(63) null
expectedFederationVersion integer null
-- 完成度：
fileCnt                   integer not null               -- 期望文件数（cnt）
anyFailed                 boolean not null default false
createdAt                 timestamp not null
unique (threadId, creatorId, originSeq)                  -- INBOUND 去重（与 Message 同语义）
unique (direction, clientMessageId)                      -- OUTBOUND 去重
```

`FileSyncProgress`——每个文件（按 digest）的本地化任务，出站/入站共用：

```text
id                        bigserial primary key
batchId                   uuid not null                  -- 归属哪条 PendingMessage
digest                    varchar(64) not null           -- CAS key
direction                 OUTBOUND | INBOUND
kind                      FILE | IMAGE | VIDEO | AUDIO | BUNDLE
status                    PENDING | DOWNLOADING | SUCCEEDED | FAILED
bytesTotal                bigint not null default 0
bytesReceived             bigint not null default 0
originDomain              varchar(63) null               -- 仅 INBOUND，下载来源
errorKind                 varchar(255) null              -- FAILED 时的分类
createdAt                 timestamp not null
updatedAt                 timestamp not null
unique (batchId, digest)
```

`MediaAsset` 精简为「内容库只放校验通过的 blob」，移除 `PENDING/FAILED` 等在途状态，改用 `isDeleted`：

```text
digest                    varchar(64) primary key
bytes                     bigint not null
isDeleted                 boolean not null default false
createdAt                 timestamp not null
```

约束：

- `MediaAsset` 行存在 ⟺ 存在一份校验通过、位于正式 CAS shard 的 blob；在途状态全部由
  `FileSyncProgress` 承担；
- 下载按 `digest` single-flight：同一 digest 的并发 `FileSyncProgress` 只发起一次网络请求，结果共享；
- temp 目录与正式 CAS 分离（见 12.11）。

### 11.3 出站与入站统一

两条路径共用 `PendingMessage` + `FileSyncProgress`，仅 `direction` 与身份字段不同：

- 出站（OUTBOUND）：客户端并行上传 N 个文件（每个仍是单文件请求，复用现有 resumable 传输），同一
  `batchId`；`/send-media` 阶段化 `PendingMessage`（`fileCnt=N`）+ 每文件一行 `FileSyncProgress`；
  上传完成即 `SUCCEEDED`；全 `SUCCEEDED` 后 promote；
- 入站（INBOUND）：missed 页事务把媒体消息写入 `PendingMessage`（带
  `creatorId/originSeq/originDomain`）+ 每文件一行 `FileSyncProgress(PENDING)`；事务提交后
  fire-and-forget 触发下载例程；全 `SUCCEEDED` 后 promote；
- 纯文本消息不经过 `PendingMessage`，仍按现有路径直接落 `Message`。

### 11.4 文件级 promote 与崩溃安全

单个文件下载完成并校验通过后，按以下顺序落库落盘，**DB 先写、move 后做**，使 `MediaAsset` 行成为
崩溃恢复的提交记录：

1. 校验 temp `.part` 的 SHA-256 与期望 digest 一致；
2. 原子 rename `<digest>.part` → `<digest>.complete`（标记「已校验、待落库」）；
3. `insert MediaAsset(isDeleted=false) on conflict do nothing`；
4. 原子 rename `<digest>.complete` → 正式 shard（同文件系统）；
5. `FileSyncProgress.status = SUCCEEDED`。

GC reconcile 对每个 `isDeleted=false` 的 `MediaAsset` 行：

- 正式 shard 在 → 完成；
- 正式 shard 缺失但 temp 有 `<digest>.complete` → 补做第 4 步 rename，恢复中断的 promote；
- 正式 shard 缺失且无 `.complete` → 置 `isDeleted=true`（真丢失）。

同一 digest 并发 promote 安全：`MediaAsset` 主键唯一 → 第二个 insert `onConflictDoNothing`；两次
`.complete`→正式 rename 打同一目标、原子、幂等。

### 11.5 消息级 promote

当一条 `PendingMessage` 关联的全部 `FileSyncProgress` 均为 `SUCCEEDED`（用
`NOT EXISTS (... status IN (PENDING, DOWNLOADING, FAILED))` 判定，不维护计数器），在同一事务内：

1. 把 `content` 中成功 digest 的 URL 改写为本地 CAS URL；
2. `insert Message`（分配本地 `seq`，顺序以 promote 时刻为准）；
3. 为每个成功 digest 写 `MessageAsset` 授权行；
4. 删除 `PendingMessage` 行；
5. 提交后 SSE `onNewMessage` + 产出 `DiscoveryChange`（出站向 peer 发 hint）。

任一文件终态 `FAILED` 则**不 promote**，消息留在 `PendingMessage` 等管理员（见 12.7）。

### 11.6 下载例程与调度器

下载例程由两个业务入口调用：

- **新建 `PendingMessage` 时**：页事务提交后 fire-and-forget 调用（不 await，不阻塞 drainer，不影响
  `remoteHwm`）；
- **管理员 retry 时**：经 GC UI 触发，复用同一例程。

例程内部：取该 `batchId` 下可重试的 `PENDING/FAILED`，按 digest single-flight 执行下载；每个 Range
响应可按全局设置携带该分块的 `Content-Digest: sha-256=...`（默认关闭，开启会增加一次 NAS 磁盘读取）。
接收端始终校验分块长度和范围；若响应提供摘要则必须校验格式与内容，未提供时依赖完成后的整文件
digest 校验。peer 忽略 Range 而返回 200，或提供畸形/不匹配的 Content-Digest，均按协议失败处理，
不得降级为无分块校验的全量下载。`.resume.json` 保存从 byte 0 连续排列的分块边界与摘要；恢复时从头顺序复核
`.part`，遇到首个缺失/损坏块即截断该块及其后数据，从最后一个正确连续区间继续；无法建立可信前缀
则清空 partial 从 0 开始。下载完成走 12.4；干净失败（传输错误、digest 不匹配）
→ `status=FAILED`（**不自动重试**）；进程崩溃中断 → 停留 `DOWNLOADING`，已下字节保留在 `.part`，等
管理员 retry 续传。

所有联邦 CAS 与 bundle 下载统一进入进程级调度器。调度器必须同时满足全局并发上限和单 peer
并发上限；配置默认值为 10/2，可由管理端修改。相同 peer、相同 digest 的并发请求合并为同一个
Promise，但不同 peer 的同 digest 不合并，避免跨信任域复用请求身份。数据库任务状态仍是崩溃恢复的
权威来源，内存队列不承担持久性。

引用解析（quote）需同时查 `Message ∪ PendingMessage`：引用一条仍在 pending 或终态 FAILED 的媒体消息
时，按「引用目标不可用」降级渲染，不丢弃引用方消息。

### 11.7 失败、孤儿与管理员操作

- 干净失败 → `FileSyncProgress=FAILED` → 消息不 promote，留 `PendingMessage`；源消息删除则进入不可重试的
  协议终态 `TOMBSTONED`，不与普通传输失败共用状态；
- 冻住的 `DOWNLOADING`（进程崩溃中断）与孤儿 batch（客户端/peer 未完成）→ 同样留 `PendingMessage`；
- 三者都经 GC UI 由管理员处理，提供两个动作：
  - **retry**：把所选 `FAILED/DOWNLOADING` 的 `FileSyncProgress` 重置为 `PENDING` 并调用下载例程
    （断点续传）；
  - **clean**：只物理删除 `PendingMessage` + 其全部 `FileSyncProgress`；CAS 与 temp 不在请求内清理，统一
    交给 GC/TTL（见 12.9），以免误删同 digest 的共享断点。

### 11.8 tombstone 与 pending 的交互

删除流到达的 tombstone 现在需要能命中 `PendingMessage`（不止 `Message.isDeleted`）：

- tombstone 到达，目标在 `PendingMessage`（下载中或 FAILED）→ 将消息与文件任务标为协议终态
  `TOMBSTONED/SOURCE_MESSAGE_DELETED`；在途下载最迟在当前分块结束时观察状态并停止，不 promote，也不由
  普通 retry 复活；保留 `PendingMessage`、`FileSyncProgress`、已验证连续前缀和断点，等待管理员清理；
- 后续另一条合法消息引用相同 digest 时可复用正式 CAS、合并正在进行的 digest 下载，或校验并续用
  该 digest 的连续 partial；新任务必须用自己的历史投递凭证授权，不能复用已删除消息的授权；
- tombstone 行保留，作为 seen 标记，防止 feed 重放或 legacy 重拉把同一条消息重新塞回
  `PendingMessage`；
- 权限校验（`creator.domain == 作者 home domain`）不变。

### 11.9 GC 扩展

GC 由「主回收 + temp TTL + salvage/reconcile」三道组成：

- **主回收**：reap `MediaAsset.isDeleted=false` 且无存活引用的行——即不存在
  `MessageAsset → Message(isDeleted=false)`，且不存在 `PENDING/DOWNLOADING/SUCCEEDED/TOMBSTONED` 的 `FileSyncProgress`
  引用该 digest；取代当前按 `status=READY` 的查询；
- **temp TTL 道（新增）**：清理 temp 目录中超过 TTL 的 `.part`/`.resume.json`，但**放过**仍被
  `PENDING/DOWNLOADING/TOMBSTONED` 的 `FileSyncProgress` claim 的、以及任何 `.complete` 文件；只清 FAILED、无主、
  或无 task 的 temp；
- **salvage/reconcile**：对无主 `.complete`（无活跃 `FileSyncProgress` 且无 `MediaAsset`）→ 补写
  `MediaAsset` 并搬入正式 shard，使其成为正常 CAS 资产（若仍无引用，再由主回收处理）；对 `MediaAsset`
  在档但正式 shard 缺失且有 `.complete` → 补完 rename（12.4）。

temp 文件清理的 ref-check：删一个 digest 的 temp 前，必须确认无其它 `FileSyncProgress` 或 `MediaAsset`
引用该 digest（同 digest 合并的前提）。

### 11.10 去重与游标

- 入站去重：`PendingMessage` 上 `unique (threadId, creatorId, originSeq)`，promote 后该身份迁移到
  `Message` 的同名唯一索引；pull 侧去重需查 `PendingMessage ∪ Message` 任一存在即跳过，`Message` 唯一
  索引为兜底；
- `remoteHwm` 在**写入 `PendingMessage`** 时随页事务推进到 `scannedThrough`，不等待 promote；因此失败
  或慢本地化的消息不会阻塞游标，也不会造成游标穿洞（消息已在 `PendingMessage`，cursor 已记录消费）。

### 11.11 temp 目录与正式 CAS 分离

- 正式 CAS：`data/cas/<dd>/<dd>/<digest>`（现有 shard 布局，仅放校验通过的 blob）；
- temp：`data/cas/tmp/`，存放 `.part`（断点续传半成品）、`.resume.json`（续传 offset）、`.complete`
  （已校验待落库）；
- promote = 校验 + `.complete` 标记 + `MediaAsset` 落库 + rename 进正式 shard；temp 文件由 12.9 的 TTL
  与 salvage 道回收。

### 11.12 统一上传与 GALLERY

聊天附件统一使用 `POST /upload`；旧的 file/video/audio typed upload 路径不再构成协议。客户端先通过
`/send-media` 创建 `PendingMedia(direction=OUTBOUND)`，并且必须提交 `clientMessageId`。单文件消息的
`fileCnt=1`；多文件消息使用 `ContentType.GALLERY` 和实际文件数。每个上传 part 声明消息意图
`IMAGE | VIDEO | AUDIO | FILE | GALLERY` 及批次内 `position`，但文件类型、字节数、图片宽高、媒体时长
等可验证元数据由服务端读取文件内容产生；客户端 MIME 和文件名只作为显示提示，不能作为安全判断。

每个成功 part 写入一条 `FileSyncProgress(direction=OUTBOUND, status=SUCCEEDED, payload, position)`。
当且仅当同一 batch 的成功行数等于 `fileCnt`，通过删除 `PendingMedia ... RETURNING` 作为并发
win-guard，在一个事务内创建唯一 `Message`、全部 `MessageAsset`，并清理进度行。未达到 barrier 时不
分配消息 seq，也不向客户端或联邦 fanout。

单文件保持各自内容形状；GALLERY 使用：

```json
{
  "items": [
    {
      "kind": "IMAGE | VIDEO | AUDIO | FILE",
      "url": "cas digest URL",
      "size": 123,
      "name": "optional",
      "mimeType": "optional",
      "w": 100,
      "h": 100,
      "duration": 1.5
    }
  ]
}
```

`items` 按 `position` 保留客户端选择顺序。字段按真实类型存在：图片不要求 duration，音频不要求
w/h，普通文件只保留通用字段；未知类型作为 FILE 并显示默认图标。前端列表以第一项作为封面并绘制
重叠效果，点击复用沉浸式媒体浏览器。多选发送前由 chatbox 询问合并为一条消息还是逐个发送。

CAS 内容可去重，但每一次合法上传和每一个消息引用都必须独立建立引用与计费语义；相同 digest 不能
导致本次 gallery part 消失。媒体访问鉴权必须同时覆盖直接 CAS 与 forward bundle，并校验请求中的
account、消息 origin seq，以及 bundle 请求中的 bundle id。

## 12. 实现状态与验收条件

当前主线状态：

1. 身份文件、本机身份锚点、peer identity/init/reset 状态机：已实现；
2. audience、全局 change feed、pull/serve cursor、轻量 HWM wake-up：已实现主链；
3. `/missed` 接收页事务、正文落库、附件 staging 和提交后通知：已实现并有单元测试；
4. download inbox、统一上传、GALLERY、并发下载调度：已实现主链；
5. 启动恢复下载任务、quota 提额自动唤醒：已实现；
6. 源端 PostgreSQL E2E 已覆盖正文与附件描述、分页、change ID 空洞，以及删除消息跳过后推进
   `scannedThrough`；双节点 E2E 已验证轻量 `feed-revisions`、`message-feed` 落库、`remoteHwm`
   推进与本地 SSE；双节点 E2E 也已验证接收端在文件下载处于
   `DOWNLOADING` 时进程退出，重启扫描后恢复下载、promote 正式消息并发送 SSE；也已验证 quota
   暂停期间不生成正式消息，管理员追加当日一次性额度后自动唤醒下载、promote 并发送 SSE；
7. 旧 `/new-msg-map`、thread 级消息拉取、`/miss-feed` 和 `/init` 已删除，不提供兼容路径。

本功能至少通过以下场景才算闭环：

- A 写消息后在 push 前重启，B 仍通过 HWM/missed 拉到消息；
- push 重复、乱序或丢失不丢消息且不重复落库；
- message-feed 页面第 N 条失败时只回滚并跳过该条，记录 error，后续消息和 HWM 继续提交；
- 同 domain 换服务器或换 root key 后进入 `identity_lost`，不会自动 init；
- 已固定 `keyId`、公钥改变或发布第二个 key 后进入 `identity_lost`；
- 密钥文件丢失但数据库有历史时不自动生成；
- 删除好友/退出/踢人与 audience 物理删除在同一事务；
- 迟到的权威查询结果因 revision/resetGeneration/federationVersion 不匹配而被丢弃；
- reset 不影响其他 peer 或纯本地 thread，且同 domain 新节点不继承旧授权。
- 媒体消息在全部文件本地化 `SUCCEEDED` 后才 promote 进 `Message`，对接收方此前不可见；
- 任一消息进入 `Message` 的事务提交后立即发送 SSE；更早的 pending 媒体不得阻塞后续正式消息，且
  不要求本地消息顺序与远端 `changeId`/`originSeq` 顺序一致；
- 进程在下载中途崩溃后，`.complete` 由 GC reconcile 补完 rename、`.part` 由管理员 retry 断点续传，不丢已校验内容；
- tombstone 命中 `PendingMessage` 时中止下载并清理，且 tombstone 行阻止该消息被重复入库；
- 媒体下载失败或冻住不阻塞 `remoteHwm`，也不造成游标穿洞。

## 13. 当前实现与剩余差异

持久发现正确性来自 per-peer message feed、轻量 `feed-revisions` 与持久 pull cursor。旧 buffer、
`/new-msg-map`、thread 级消息拉取和 reconnect poll 已删除；节点之间不保留回退协议。

当前下载调度队列是进程内状态，数据库中的 `PendingMedia/FileSyncProgress` 才是权威状态；服务启动后
会据此重建队列。管理员提高一次性 quota 并解除该 peer 全部 breaker 后，系统自动重新调度
`QUOTA_PAUSED` 批次。
