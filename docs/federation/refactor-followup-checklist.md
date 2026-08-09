# 联邦状态、消息与媒体重构验收清单

> 更新日期：2026-08-09
>
> 状态说明：`TODO` 尚未处理；`IN PROGRESS` 正在改造；`VERIFY` 代码可能已覆盖但必须以定向测试验收；
> `DONE` 已实现且测试通过；`OBSOLETE` 已被新模型替代。

本清单是联邦重构的完成门槛。不能在重启首个签名 GET、退群交付边界和媒体恢复双节点测试
全部通过前将项目标记为完成。

## A. 联邦消息与媒体主线

- [x] **DONE：进程重启后的首个签名数据 GET 不返回 401。** 双节点代理记录重启后的真实
      S2S 请求；恢复顺序为 identity → signed ping（恢复对端可能 demoted 的入站 trust）→
      state-feed → message-feed。定向测试断言 ping 与首个 state 数据请求均为 200、全程无 401，
      并继续完成 PendingMedia 恢复。迟到的旧网络失败不能覆盖较新的成功心跳。
- [x] **DONE：退群消息与历史交付边界。** 在一个事务序列中写 `GROUP_LEFT` SYSTEM、分配
      changeId、固定 CREATOR audience 的 `deliverThroughChangeId`，再停止后续路由。覆盖主动退群、
      被踢、peer 最后成员、peer 仍有其他成员、重新入群、重复退群和 SYSTEM 纯展示约束。
- [x] **DONE：媒体恢复与下载生命周期。** 双节点测试覆盖
      message-feed HWM、重启恢复 PendingMedia、quota 暂停与管理员调额自动唤醒；仍需覆盖
      其余 digest 合并、每 peer/全局并发、终止/墓碑、管理员物理删除、临时分块
      GC 后重试、有/无分块 digest、CAS/ForwardBundle 授权和失败隔离由媒体单元/E2E 矩阵覆盖。
- [x] **DONE：删除协议。** 已删除正文不再产生 discovery change/被 feed 返回；SYSTEM 不可
      客户端伪造、撤回、举报、转发、多选或引用；墓碑不可普通 retry 复活；只有管理员物理删除任务；
      临时文件仍由 GC 管理；共享 digest 的断点数据可复用。

## B. Per-peer state feed

- [x] **DONE：统一关系事实模型。** 好友使用两条有向 `FriendRequest` 与一个无向
      `FriendPair` 锁；允许保留另一方许可并单边复活。群使用 origin `GROUP_INVITE_INTENT` 与
      member `GROUP_JOIN_INTENT` 两个方向，最终 roster 只由 origin 的 `GROUP_META` 确认。
- [x] **DONE：删除旧 S2S 邀请命令。** 删除 `/s2s/invite`、`/invite-accept`、`/invite-revoke`
      和相应 dedup/DTO/handler；本地客户端操作改为目标 identity，不再依赖 Invite ID。
- [x] **DONE：删除旧关系/profile/meta 探测。** 最终不存在 `/s2s/thread-access`、
      `queryThreadAccess()`、`assertP2PWritable()` 远程查询、用户 revision endpoint、
      `sync-peer-profile`、`sync-meta`、chat/profile-open probe、旧 `/s2s/messages?take=1` 判断，
      以及相关测试、注释和生成类型。
- [x] **DONE：业务状态与 feed 原子提交。** 用户/群资料、好友方向、群 invite/join、
      退群/踢人、角色、群主、解散和 peer 最后成员变更，都必须在业务事务内增长 revision、锁 peer
      allocator 并覆盖 feed；只在提交后发送 wake-up。
- [x] **DONE：state-feed 验收矩阵。** 单元、PostgreSQL E2E 与双节点 E2E 共同覆盖崩溃窗口、同 key 最大 revision、好友状态防回退、
      最后远端成员最终快照、大头像/大 roster/分页字节限制、非法整页 cursor 回滚、wake-up 丢失/
      乱序/重复/重启、peer 隔离、reset 隔离，以及删除旧查询后双节点收敛。

## C. 命名与协议冻结

- [x] **DONE：S2S 命名。** `init` 改为 `ignite`；`miss-feed` 改为 `message-feed`；
      HWM 字段使用 `messageFeedRev`。客户端仍使用 `missed-summary`。
- [x] **DONE：版本只在 URL。** `/api/v1` 是唯一 wire schema 版本；state body 不再重复
      `version`。不兼容升级使用 `/api/v2`。
- [x] **DONE：SYSTEM 纯展示。** body 只保存结构化事件/稳定 identity，不保存自然语言；
      客户端按事件类型、资料和消息时间本地化渲染。好友申请与同意也写 SYSTEM 消息。

## D. 清理、文档与最终验证

- [x] **DONE：运行时清理。** 空 `onModuleDestroy()`、legacy buffer/new-msg-map、旧 messages/
      deletion pull、过期代理字段、未使用 import/DTO/BusinessCode 和旧前后端调用。
- [x] **DONE：文档与生成物。** 更新 api closure audit、protocol baseline、S2S API、federation
      README、database overview、身份/持久发现设计和 `web/src/app/services/api-types.ts`；删除
      new-msg-map、thread 级 messages、chat-open probes、thread-access 与过期严格顺序描述。
- [x] **DONE：最终命令。** 已依次通过：
  - `npm run build`
  - `npm test`
  - `npm run test:e2e`
  - `npm run build --prefix web`
  - `npm test --prefix web`
  - `npm run build --prefix admin-web`
