# 任务：优化联邦批量消息入库（inbound message ingestion）的数据库往返

## 背景

这是一个 NestJS + Drizzle + PostgreSQL 的联邦聊天服务。联邦轮次（forward/reverse round）从对端服务器拉取消息页（page），在**单个调用方事务**内逐条入库。当前实现已经是两阶段：

- Phase 1（事务外）：纯校验、内容投影、摘要计算，畸形项 warn + 过滤 —— 见 `src/federation/federation-inbound-message-page.service.ts` 的 `apply()`。
- Phase 2（事务内）：逐条 SAVEPOINT 隔离 → 路由解析 → 已存在检查 → `store()` 插入 —— 见 `src/federation/federation-inbound-message-store.service.ts`。

问题：Phase 2 仍是**逐条消息 10+ 次 DB round trip**，一页 50 条约 500+ 次往返。

## 已确认的逐条热点

| # | 操作 | 位置 | 优化方向 |
|---|---|---|---|
| 1 | SAVEPOINT/RELEASE 每条 2 次 RT | page service Phase 2 | 协议要求的单条隔离语义，原则上保留 |
| 2 | 路由解析 `resolveMessage` 每条一次查询 | page service | 同 thread item 可缓存/合并 |
| 3 | 已存在检查 `existingMessage`（`threadId+publisherNamespaceId+originSeq`） | page service | ✅ 全页一条 `IN (originSeqs...)` |
| 4 | **重复的已存在检查 `racedMessage`**（与 #3 同条件） | `store()` | ✅ 纯重复，删掉或改为信任预取结果 |
| 5 | `assertResponseWritable`（thread 存在性 SELECT）每条一次 | `store()` | ✅ 冗余防御检查（后续 INSERT 有 FK 兜底），可去；注意它和页级 `assertPeerResponseWritable`（namespace token 校验）不是同一断言 |
| 6 | tombstone `findFirst` 每条一次 | `store()` | ✅ 全页 `IN` 一次 |
| 7 | 反向 seq 可用性：读 `curSeq` + occupied `findFirst` 每条一次 | `assertMappedMessageSeqAvailable` | ✅ curSeq 读一次 + 全页 occupied 一次 |
| 8 | thread `authorizationEpoch` SELECT 每条一次（stub 分支） | `store()` | ✅ 每线程一次 |
| 9 | `allocateMessageSeq`：每条一个 `UPDATE MessageThread SET curSeq = curSeq + 1 RETURNING`（仅正向路径） | `store()` | ✅ 事务开始一次 `+n RETURNING` 批量分配区间；反向路径 seq 是映射的，不能走区间分配 |
| 10 | `Message` INSERT 逐条 | `store()` | ✅ 多行 VALUES；见下方"风险" |
| 11 | `FileSyncProgress` 逐 digest 循环 INSERT | stub 分支 | ✅ 多行 INSERT |
| 12 | `enqueueFanout`：每条重读 thread head + enqueue | `store()` | ✅ 批尾一次（head 在批内已知） |
| 13 | `quota.tickLax` 每条一次 | `store()` | ✅ 批量计数 tick |

## 必须保留的正确性约束（不可为批量牺牲）

1. **逐条 SAVEPOINT 隔离语义**：`FEDERATION_MALFORMED` 单条 warn+跳过、其余错误整页回滚。这是对不可信 peer 的协议行为。
2. **锁序与锁模式**：线程内容锁、`lockFederatedIdentity`、`FOR NO KEY UPDATE`（非 key 读改写）/`FOR UPDATE`（物理删除/引用键保护）的既有约定与资源获取顺序不能变。
3. 授权纪元（authorizationEpoch）CAS 校验语义不能削弱。
4. `applyProcessingReceipt`（LOCAL 回执分支）的逐条 CAS 语义保留，但其消息查找可批量化。
5. 项目准则：不为交付速度牺牲正确性/安全/可维护性；最小改动优先，但该大改时就大改。

## 已知风险点（设计时必须解决）

**批量 INSERT 与单条隔离的张力**：若预取过滤漏掉并发窗口内插入的冲突项，多行 INSERT 整批失败会退化成整页回滚重放，恶意/异常 peer 可借此放大成本。方案需分层：批量预取过滤已知冲突 → 保守的逐条 fallback（或冲突后降级为逐条重放），并论证最坏情况仍是 O(页大小) 而非 O(页大小²) 重试。

## 请你（Grok）做什么

1. 在上述热点和约束下，给出一个**分阶段的改造方案**（Phase A 纯重复消除 / Phase B 批量预取 / Phase C 批量写 / Phase D seq 区间分配），每阶段列出：
   - 具体代码改动点（文件、函数）；
   - 需要新增/修改的批量 SQL（Drizzle 写法）；
   - 对并发语义的影响分析与兜底；
   - 验证方式（现有 `*.spec.ts` 单测 + `test/*.e2e-spec.ts` PostgreSQL e2e，尤其并发冲突场景）。
2. 特别论证 Phase C（Message 多行 INSERT）与 savepoint 隔离的共存方案，以及 Phase D 区间分配在「正向页中途遇到 tombstone/待决媒体/回执混合页」时的正确性。
3. 估算每阶段把每页 DB 往返从 ~500+ 压到多少，以及事务持锁时间的变化。
4. 指出任何我上面分析里遗漏的隐藏成本或不可行项。

先只输出方案，不要改代码；等我确认方案后再分阶段实施。
