# 前端并发同步交接文档

## 目的

继续实现前端 feed 并发同步：Thread Feed、Group Meta、Message/Tombstone 等业务 feed 应拥有独立 scheduler；不要把 Group Meta 嵌套在 Thread Feed executor 内。

## 当前结论

- `groupMetaFeedEndId` 是 Group thread 的内容发现坐标。
- P2P wire head 省略该字段；client 内部归一化为 `null`。
- canonical Group head 必须携带该字段；mirror 回 origin 的 Group head 必须省略。
- `State Feed`、Thread Content Head、Message Feed、Tombstone Feed、Group Meta Feed 是不同层次/坐标；Group Meta 不等同于消息正文更新。
- Thread Feed commit 后才可以可靠发现新的 Group Meta target，但这只是 target discovery dependency，不是 executor nesting dependency。

## 已完成的当前改动

### 1. Thread Feed executor 已移除 Group Meta 嵌套

`web/src/app/services/thread-feed-sync.ts` 的 `syncThreadFeed()` 不再调用 `syncGroupMeta()`。

它现在只负责：

1. 读取 `threadFeedCursor`；
2. 拉取 Thread Feed pages；
3. 调用 `mergeThreadStates()` 提交页面；
4. 返回 committed thread states/cursor。

为了兼容旧调用方，函数参数中暂时保留了两个可选的 unused 参数；后续应考虑清理所有调用方后删除兼容参数。

### 2. Worker 中增加独立 Group Meta wake

`web/src/app/services/state-feed-db.worker.ts` 中，bind-thread-feed 时创建：

```text
thread wake
state wake
groupMeta wake
```

Thread Feed 成功后调用：

```ts
if (!result.error) groupMetaWake(target);
```

Group Meta drain 成功后单独向 renderer 发送 `GROUP_META` completion message。

显式 `thread-sync` 请求目前仍在 Thread Feed 完成后执行一次 Group Meta drain，以维持这个 API 的返回语义；这是 worker request 流程中的 sibling step，不再是 `syncThreadFeed()` 内部嵌套。后续可进一步把显式调用改成独立 `group-meta-sync` request。

### 3. 共享 QueuedTargetCoalescer

`shared/trailing-single-flight.ts` 现在包含：

- `TrailingSingleFlight<Arg>`：立即开始执行的 single-flight，支持 one trailing round；适合 foreground feed、profile pull、backend refresh 等。
- `QueuedTargetCoalescer`：外部 queue 延迟执行时的数值 target coalescer。
- `coalesceQueuedTargets(enqueue, run)`：函数式 facade。

`QueuedTargetCoalescer` 语义：

```text
wake(2), wake(5), wake(3)
  -> 一个尚未开始的 queued task
  -> task 开始时 run(5)

run(2) 执行期间 wake(7)
  -> 当前 round 不变
  -> 执行完成后追加一个 run(7)

run 失败
  -> 不自动重试
  -> 后续 wake 才会重新入队
```

`web/src/app/services/thread-feed-sync.ts` 的 `coalesceThreadFeedWakes` 和 `coalesceGroupMetaWakes` 现在都是这个共享 primitive 的 alias。

## 重要：当前 worker 仍然没有 HTTP 并行

worker 仍有：

```ts
let queue = Promise.resolve();
```

scheduler enqueue 仍然使用：

```ts
queue = queue.then(task);
```

所以当前效果是：

```text
scheduler 独立
失败边界独立
但整个 task（包括 HTTP await）仍共享一个串行 Promise queue
```

这不是 IDB 本身要求的；IDB 是 IndexedDB，本地浏览器数据库。原 queue 是为了保护 worker 中账户 open/close、切换用户和 storage handle 生命周期，但作用范围过宽。

下一步前端并发工作应：

1. 保留账户 open/close/switch 的生命周期保护；
2. 不要让长期 HTTP fetch 被全局 queue 包住；
3. 允许不同 feed 的 HTTP drain 并行；
4. 让每个 feed page 的 IndexedDB transaction 原子提交；
5. 对同一资源的 cursor read-modify-write 使用 feed-specific lock/single-flight；
6. 重点检查账户切换时过期请求不能写入新账户数据库。

不要把所有 queue 直接删除；先设计 lifecycle gate 与 feed execution 的边界。

## 后端并发结论

后端没有前端 worker 这种全局 Promise queue。后端主要通过 PostgreSQL MVCC/transaction/row lock、durable task scheduler、per-resource single-flight/coalescing 协调并发。前后端可以共享纯调度 primitive，但不能共享 PostgreSQL transaction 或 durable task executor。

## 测试/验证状态

已验证：

```text
npx prettier --write 相关文件
npx tsc --noEmit -p web/tsconfig.app.json
npx vitest run shared/trailing-single-flight.spec.ts ...
```

shared immediate single-flight 原有测试曾通过；加入 shared queued coalescer 测试后需要重新运行完整 shared spec。

注意：

- 根 `vitest` 对 web spec 的配置不能直接使用 `web/vitest.config.ts`，该文件不存在。
- `web/vitest-base.config.ts` 当前引用缺失的 `/src/test-setup.ts`，直接运行 web specs 会失败。
- Angular DI/TestBed spec 应使用 Angular runner：`cd web && npx ng test`，但当前还会遇到用户 namespace rename WIP 导致的 stale spec compilation errors。
- 根 `tsc` 有大量既有 namespace/profile rename WIP 错误，不要把它们误判为本次并发改动回归。

## 继续工作建议

按顺序：

1. 运行并修复 `shared/trailing-single-flight.spec.ts`，确认 `QueuedTargetCoalescer` 测试语义正确。
2. 检查 `git diff`，尤其确认没有破坏当前用户正在进行的 profile namespace rename WIP。
3. 给 `thread-feed-sync.ts` 增加/恢复 coalescer 测试（最好直接测试 shared primitive，避免重复测试 alias）。
4. 设计 worker 的 lifecycle gate 与 concurrent feed execution，不要直接删除全局 queue。
5. 将 Group Meta 的显式 `thread-sync` 调用路径改成真正独立的 request/flight，逐步删除 Thread Feed API 中保留的兼容参数。
6. 继续主线 Batch 3：friend-add DTO namespaceId、profile binding 到当前 domain 的 rendering join、contact-card add UX、Tauri native profile namespace commands。
7. 最后跑 targeted frontend/backend tests、Angular runner、`ng build --configuration development`。

## 不要做的事

- 不要把 `TrailingSingleFlight` 强行用于 queued worker coalescing。
- 不要把 Group Meta 再放回 `syncThreadFeedUnlocked()`。
- 不要把 `groupMetaFeedEndId` 的 P2P 缺失字段在内部到处当作 `undefined` 防御；入口验证后内部类型是 `string | null`。
- 不要用全局 queue 证明“IDB 必须串行”；它只是当前 worker 的保守生命周期/执行设计。
- 不要 broad reset 或恢复无关 stale specs。
