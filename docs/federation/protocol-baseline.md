# SOMS 联邦协议实现基线

> 本文是 SOMS 当前实现基线，不是第三方实现必须复制的数据模型。规范性 wire contract 以
> [Federation Protocol v1](./spec/v1/protocol.md)为准；本文中的数据库字段、本地限制和后台任务
> 仅用于解释本项目如何满足协议。详细实现字段见 [S2S API](../api/federation-s2s-api.md)。

## 公开 surface

| Method | Path                                    | 鉴权与用途                                          |
| ------ | --------------------------------------- | --------------------------------------------------- |
| `GET`  | `/.well-known/soms`                     | 公开服务器身份、公钥和能力发现。                    |
| `POST` | `/s2s/v1/ignite`                    | 首次建立并固定 peer identity；不要求预先 trusted。  |
| `GET`  | `/s2s/v1/identity`                  | nonce-bound 身份连续性证明。                        |
| `POST` | `/s2s/v1/feed-revisions`            | 轻量 state/message source revision wake-up。        |
| `GET`  | `/s2s/v1/state-feed`                | PROFILE、好友方向事实、群方向事实和 origin 群快照。 |
| `GET`  | `/s2s/v1/message-feed`              | durable message discovery feed。                    |
| `POST` | `/s2s/v1/call`                      | 临时 WebRTC 生命周期和 SDP/ICE relay。              |
| `GET`  | `/s2s/v1/users/:account`            | 首次用户查询所需的完整公开 profile。                |
| `GET`  | `/s2s/v1/media/:digest`             | 绑定精确消息/thread 所有权的 CAS Range 下载。       |
| `GET`  | `/s2s/v1/forward-bundles/:bundleId` | 有授权的不可变转发 closure。                        |

## 身份与信任

- wire identity 固定为 `{ account, domain }`，不传数据库 id。
- P2P 两端各有本地 thread；group 以 origin 的 `!account` 为稳定身份，每个成员服务器持有本地镜像。
- `trusted` 可正常交换数据；`demoted` 仅表示临时不可用，保留 pinned identity。
- 重启恢复顺序是 identity → state feed → message feed；identity 同时恢复已有 demoted trust edge。
- fingerprint、root key 或 pairwise server identity 冲突进入 `identity_lost`。DNS 修复后管理员可
  手动验证并恢复完全相同的原 pin；新身份仍只能 destructive reset，不能重新 ignite 静默继承授权。
- 迟到的旧网络失败不能覆盖较新的成功心跳。

### SOMS 网络实现边界

本节非规范。SOMS Federation discovery 当前以 SRV/apex 解析配合原生 HTTP fetch 连接服务器侧
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
- `PROFILE` 独立带 revision；群 meta JSON 不嵌头像。群成员服务器可直接应用 origin relay 的
  成员 PROFILE。
- 相同或更旧业务 revision 是完整 no-op：不写业务行、不刷新 `updatedAt`、不写投影、不生成
  feed、不触发下游。
- per-peer feed 按 key 压缩，只保留最高业务 revision。feed revision/cursor 使用 bigint，业务
  revision 使用 int。
- feed page 与 receiver cursor 同事务提交；任一非法 item 回滚整页。

## 消息与媒体

- wake-up 不携正文；receiver 永远先拉 state，再拉 message feed。
- message discovery change 与 message/audience 原子提交。
- feed 按目标 peer 分配。节点从作者服务器 X 拉取并提交消息后，将 self-authored item 分配回 X
  作为持久投递回执：`originSeq` 标识 X 发布的源序列，item `createdAt` 是接收节点的持久化时间；
  X 关联原消息但不得重复插入。
- 从 peer X 拉取的第三方 authored relay 消息不得直接反射回 X，但仍可分配给作者服务器或其他
  已授权 audience。
- SOMS 当前用 nullable `Message.originSeq/originServerTime` 记录上述回执只是本地实现，不是联邦
  协议要求的数据库模型。
- SYSTEM 正文只含结构化事件和稳定 identity，自然语言由客户端按 locale 与时间渲染。
- 退群先写 `GROUP_LEFT`、分配 changeId、固定 creator audience 交付边界，再关闭成员关系。
- 同服务器仍有其他群成员时，共享镜像继续保存消息，退群者重新加入后可查看期间历史；最后一个
  成员离开时冻结 peer audience，重新加入复用镜像并恢复后续消息，但不补无人订阅期间的历史。
- 媒体正文提交与文件下载解耦；pending 下载可跨重启恢复。quota pause 保持可恢复状态，管理员
  加配额后自动唤醒。
- CAS 和 forward bundle 下载均验证精确消息/thread 所有权和 digest/bundle 绑定。

## 当前限制

- 字段与错误模型已由 Federation v1 正式规范冻结；JSON Schema 与 conformance 工具随规范发布，
  但不是运行时前提。
