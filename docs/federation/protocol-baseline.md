# SOMS 联邦协议实现基线

> 本文是 SOMS 的目标实现基线，当前代码尚待按此迁移；它不是第三方实现必须复制的数据模型。规范性 wire contract 以
> [Federation Protocol v1](../../spec/v1/protocol.md)为准；本文中的数据库字段、本地限制和后台任务
> 仅用于解释本项目如何满足协议。详细实现字段见 [S2S API](../api/federation-s2s-api.md)。

## 公开 surface

| Method | Path                                | 鉴权与用途                                          |
| ------ | ----------------------------------- | --------------------------------------------------- |
| `GET`  | `/.well-known/socfp`                | 公开服务器身份、公钥和能力发现。                    |
| `POST` | `/s2s/v1/recognize`                 | 建立一个认可方向并持久调度反向认可。                |
| `POST` | `/s2s/v1/healthy`                   | 查询既有认可关系的可用性，不为未知方取 key。        |
| `POST` | `/s2s/v1/feed-heads`                | 轻量 state/message/tombstone feed end-ID wake-up。  |
| `GET`  | `/s2s/v1/state-feed`                | PROFILE、好友方向事实、群方向事实和 origin 群快照。 |
| `GET`  | `/s2s/v1/message-feed`              | durable message discovery feed。                    |
| `GET`  | `/s2s/v1/message-tombstone-feed`    | durable message deletion tombstone feed。           |
| `GET`  | `/s2s/v1/messages`                  | 按 thread 查询具体消息。                            |
| `GET`  | `/s2s/v1/message-tombstones`        | 按 thread 查询永久权威删除事实。                    |
| `POST` | `/s2s/v1/call`                      | 临时 WebRTC 生命周期和 SDP/ICE relay。              |
| `GET`  | `/s2s/v1/users/:account`            | 首次用户查询所需的完整公开 profile。                |
| `GET`  | `/s2s/v1/media/:digest`             | 绑定精确消息/thread 所有权的 CAS Range 下载。       |
| `GET`  | `/s2s/v1/forward-bundles/:bundleId` | 有授权的不可变转发 closure。                        |

## 身份与信任

- wire identity 固定为 `{ account, domain }`，不传数据库 id。
- P2P 两端各有本地 thread；group 以 origin 的 `!account` 为稳定身份，每个成员服务器持有本地镜像。
- `healthy` 可正常交换数据；`degraded` 表示事实未收敛或临时不可用，并保留 pinned identity。
- 重启恢复先查询 `healthy`；缺少任一认可事实时执行幂等双向 `recognize`，再拉 state 和 message feed。
- pinned root 冲突进入 `halted` 并记录 identity mismatch 原因；同一 root 授权的 signing certificate 轮换不改变身份。DNS
  修复后管理员只能恢复完全相同的原 root；新 root 必须 destructive reset 和 fresh recognition。
- 迟到的旧网络失败不能覆盖较新的成功心跳。

### SOMS 网络实现边界

本节非规范。SOMS 对 Simple Open Chat Federation Protocol discovery 的实现当前以 SRV/apex 解析配合原生 HTTP fetch 连接服务器侧
受控 peer，没有复用 link-preview 的任意 URL SSRF-safe connector。IP 分类、connect-time DNS
pinning 和出站防火墙属于节点部署选择，不是 Federation v1 wire contract。

## 状态一致性

- 好友由两条有向 `FriendRequest` 事实和一个无向 `FriendPair` 锁组成。
- `REQUESTED` 只是一封有期限的申请；过期即视为不存在并允许提高 revision 后重建。只有本地方向
  和从对端 state feed 收到的方向都明确为无有效期的 `FRIEND`，才允许创建/恢复 P2P thread。
- 本地 `NOT_FRIEND/NOT_MEMBER` 不得被对端滞后的 `FRIEND/GROUP_META` 覆盖；本地提高否定方向
  revision 并回送。仍有效的本地申请收到成立状态时则推进为无有效期成立状态并回送确认。
- 删除/退群后可以在 peer 尚未消费旧状态时立即重加；同 key compaction 保留最新 revision，群
  origin 即使仍认为成员 active，也必须为新的 JOIN revision 重发 `GROUP_META`。
- 群成员由 origin 的 INVITE 和 member 的 JOIN 两个方向组成，origin `GROUP_META` 是 roster
  的最终权威。
- 群邀请只能经由邀请者与被邀请者已经成立的 P2P 会话发起；邀请事务同时写
  `GROUP_INVITE_INTENT` 与所需群 `PROFILE`。同一事务若发布引用 roster 的 `GROUP_META`，必须先为
  目标 peer 写齐对应 `MEMBER_PROFILE`，提交后才能发送 state-feed push。
- `PROFILE` 独立带 revision；群 meta JSON 不嵌头像。群成员服务器可直接应用 origin relay 的
  成员 PROFILE。
- 相同或更旧业务 revision 不改写 body；为维持 member-before-group 当前投影顺序，可以对语义相同的
  `GROUP_META` 做 dependency-repair feed reindex。
- per-peer state feed 按 key 压缩。transport `feedId`/cursor 使用 bigint，stable-key 业务
  `revision` 使用 int；两者不可混用。
- state feed page 与 receiver cursor 同事务提交；任一非法 state item 回滚整页。
- state feed 中 member 快照先于引用它的群 revision；最后可见性来源消失时直接从投影删除，
  consumer 在完整 state drain 后做引用闭包清理。

## 消息与媒体

- wake-up 不携正文；receiver 冻结三个独立上界，并按 state、tombstone、message 顺序排空。
- 三个 feed 的 `feedId` 空间和 consumer 本地 cursor 彼此独立；source 不维护 ACK 或单调验证 cursor。
- message/tombstone feed 只是按 `(peer, thread)` 压缩的 end-seq 索引，具体 array 由 thread query 返回。
- 从 peer X 拉取的第三方 authored relay 消息不得直接反射回 X，但仍可分配给作者服务器或其他
  已授权 audience。
- SOMS 当前用 nullable `Message.originSeq/originServerTime` 记录上述回执只是本地实现，不是联邦
  协议要求的数据库模型。
- message query 未知 content type 统一按非法 message 处理；索引型 message-feed 不携带 content。
- 退群成员关系通过 state feed 收敛；最后一个本地成员离开时固定 peer audience 交付边界。
- 同服务器仍有其他群成员时，共享镜像继续保存消息，退群者重新加入后可查看期间历史；最后一个
  成员离开时冻结 peer audience，重新加入复用镜像并恢复后续消息，但不补无人订阅期间的历史。
- 媒体正文提交与文件下载解耦；pending 下载可跨重启恢复。quota pause 保持可恢复状态，管理员
  加配额后自动唤醒。
- CAS 和 forward bundle 下载均验证精确消息/thread 所有权和 digest/bundle 绑定。
- 资源授权实时 join signer 的 thread audience，不依赖可被 GC 的 message change。
- 三个 feed 不因容量、时间或重启清理有效的当前压缩投影；P2P 关系终止后，source
  可分别移除该 thread 的 message/tombstone 投影。两个 data feed 的 thread 集合独立。message query
  正文可按保留策略清理并返回更高 `resumeAfter`，tombstone 事实永久保留。

## 当前限制

- 字段与错误模型已由 Federation v1 正式规范冻结；JSON Schema 与 conformance 工具随规范发布，
  但不是运行时前提。
