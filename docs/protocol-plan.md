# 协议栈规划

本文档是 SOMS **后端接口与前后端交互协议栈**的目标设计基准，用于团队对齐与后续渐进式实施。它基于对现有代码（后端 5 个 controller、`EventGateway`、`AuthService`，前端 `AuthInterceptor` / `WebsocketService`）的审查，提出分层目标契约、错误码体系、WS 事件目录与演进路线图。

- **状态**：P0/P1 已完成并验证；本文档仅保留待办（P2/P3 + ESM 外挂）。最后更新 2026-06-26。
- **范围**：HTTP 接口、数据契约、认证、实时通信、前后端协同
- **目标**：在「简洁、易被第三方应用接入」的定位下，补齐契约、正确性与可靠性

---

## 目录

- [一、背景与目标](#一背景与目标)
- [二、现状评估](#二现状评估)
- [三、设计原则与保留项](#三设计原则与保留项)
- [四、目标协议栈分层](#四目标协议栈分层)
- [五、目标契约规范（汇总）](#五目标契约规范汇总)
- [六、演进路线图](#六演进路线图)
- [七、附录：改造点 → 文件映射](#七附录改造点--文件映射)

---

## 一、背景与目标

SOMS 的核心链路（注册登录、好友、P2P/群组会话、消息收发与实时推送）已可用。但当前的接口协议在**规范性、契约化、正确性、可靠性**上存在系统性缺口，主要表现为：

- 所有错误以 HTTP 200 + 业务 `status` 返回，丢失 HTTP 语义，标准客户端无法走错误分支。
- 无 OpenAPI、无 DTO、前后端类型手抄，与「易被第三方接入」的定位冲突。
- 存在真实 bug 与安全隐患（refresh 仅内存、`logout` 取错字段、密钥硬编码、CORS 全开）。
- WS 无心跳、无消息序号，弱网下推送可靠性无保障。

**目标**：在保留现有优良设计的前提下，分四档优先级（P0–P3）把协议栈演进到「契约清晰、语义正确、可靠可观测」，并对第三方接入提供可发现、可生成、版本化的 API。

---

## 二、现状评估（P0/P1 前基线，仅供回溯）

> 以下为规划时（2026-06-22）的协议栈快照，其中标 ⚠️ 的项（无 `/api/v1` 前缀、错误全走 HTTP 200、refresh 仅内存字典、`Date.toJSON` hack、无 OpenAPI、无全局过滤器/ValidationPipe）**均已在 P0/P1 修复**。唯一遗留：WS「无心跳、无序号」——见 [六、P2](#六演进路线图)。

### 已发现的协议层 bug 与隐患

> 原列 8 条协议层 bug/隐患（refresh 内存字典与 key 错配、renew-refresh 空指针、logout 取错字段、密钥硬编码、CORS 全开、`StandardResponse` 重复定义、file 域死代码、`Date.toJSON` 全局 hack）**均已在 P0/P1 修复**，详见 git 历史。

---

## 三、设计原则与保留项

### 保留的现有设计（规划围绕它们展开）

1. **会话统一抽象**：`MessageThread` / `UserMessageThread` 统一 P2P 与 GROUP，`status` 驱动生命周期。
2. **职责分离**：HTTP 负责「写与查」，WebSocket 负责「推」。
3. **双 Token 续期**：access 短(无状态) + refresh 长(可吊销)。
4. **游标分页**：`lastId` + `skip/take`。
5. **WS 薄载荷推送**：只推 `{threadId, msgId}` 触发客户端增量拉取——利于多端一致性、WS 小包。**保持不变。**

### 设计原则

- **契约优先**：OpenAPI 作为单一事实源，前端类型由其生成。
- **语义正确**：HTTP 状态码反映传输/鉴权/参数层结果，业务码承载业务结果细分。
- **渐进演进**：保留现有 `{status,message,data}` 信封心智，分档迭代，不做大爆炸式重写。
- **可观测、可排障**：统一异常出口 + 结构化日志 + traceId。

---

## 四、目标协议栈分层

### 4.1 传输与 HTTP 协议

1. **版本前缀**：所有接口置于 `/api/v1` 下。对第三方接入是刚需——破坏性变更走版本号。
2. **方法语义化**：保留现有 **动作式 RPC 路径**（`POST /api/v1/message/send`），符合 IM 平台惯例（Slack/Discord/开放平台均如此），不强转 REST。读/写用 HTTP 方法区分，但**关键是 HTTP 状态码要正确**。
3. **HTTP 状态码 + 业务信封并用**：
   - 鉴权/参数/限流/服务异常 → 对应 HTTP 4xx/5xx，让标准客户端走错误分支。
   - 业务结果（已是好友、状态机分支等）→ HTTP 200 + 业务 `code`。

### 4.2 数据契约

1. **DTO + 校验**：引入 `class-validator` + `class-transformer` + 全局 `ValidationPipe`，每端点一个 DTO 类，参数规则下沉到装饰器（替代 `register` 里的手写正则）。
2. **OpenAPI**：引入 `@nestjs/swagger`，文档挂 `/api/v1/docs`，作为第三方接入的核心交付物。
3. **前端类型生成**：用 `openapi-typescript` 从 OpenAPI 生成 TS 类型，消除手抄。
4. **统一分页 DTO**：收敛散落的 `skip/take/lastId/orderBy` 为 `CursorPageQuery<T>` + `CursorPage<T>`。
5. **去 hack 化序列化**：移除全局 `Date.prototype.toJSON`，改用**响应序列化拦截器**统一 `Date → 毫秒戳`、`BigInt → string`，替换手动 `convertBigIntId`。

### 4.3 异常与可观测性

1. **全局 `ExceptionFilter`**：所有异常（含未捕获）统一转 `ApiResult` + 正确 HTTP 码，禁止泄漏堆栈。
2. **结构化日志**（`nest-winston` / `pino`）+ 每请求注入 `traceId`，并写入 `ApiResult.traceId`。
3. **健康检查** `GET /api/v1/health`（含 DB 连通性），供部署探针使用。

### 4.4 认证与安全

1. **refresh_token 落库**（替换内存字典）：见 [五、4](#5-3-认证与安全契约)。支持多端、可吊销、重启不丢，顺手修掉 key 错配 bug。
2. **修 `logout`**：refreshToken 从请求 body 取，不从 JWT payload 取。
3. **密钥外置**：JWT secret、邀请 token secret 改 `env`。
4. **限流**：`@nestjs/throttler` 全局，登录/续期/发消息加严。
5. **生产安全**：CORS 显式 origin 白名单、`helmet`、强制 HTTPS/WSS、请求体大小限制。
6. access_token 保持纯 JWT 短期无状态；需「立即踢下线」时再加短 TTL 吊销列表（Redis 黑名单）。

### 4.5 实时通信（WebSocket）

保留「薄载荷 + 二次拉取」与子协议鉴权，补齐可靠性与事件：

1. **心跳**：服务端 30s ping（原生 ping/pong 帧），3 次无 pong 判死并清理 `wsClientDict`。
2. **消息 `seq`**：每连接维护递增 seq，前端据 seq 去重 + 检测缺口触发补拉（解决弱网丢推送）。
3. **事件目录枚举**：前后端共享 `WsEvent` 常量表。
4. **鉴权方式**：子协议方案保留（优点：不进 URL 日志）；若需更标准，改为「连接后首条消息 `{type:'AUTH',token}` 握手」。择一并文档化。
5. **扩展事件**（按优先级）：`MESSAGE_READ`（配合已建模却未用的 `UserMessageThread.lastRead`）、`USER_TYPING`、`USER_PRESENCE`、`NOTIFY`（接入已建模却未用的 `Notify` 表）。

### 4.6 前后端协同

1. **续期单飞（single-flight）**：HTTP 401 续期并发时只发一次，其余请求 `await` 同一 Promise，替换手写的 `_isReACTk` 标志位。
2. **WS 重连指数退避 + 抖动**：1s→2s→…→30s 封顶，替代固定 10s。
3. **前端统一错误处理**：401 续期/重登、429 退避、5xx 降级提示。

---

## 五、目标契约规范（汇总）

### 5.1 统一响应信封

```ts
// 沿用现有结构，字段语义化；status 可保留或更名为 code
interface ApiResult<T = unknown> {
  code: number;        // 0 = 成功；非 0 = 业务错误码（稳定、可枚举）
  message: string;
  data?: T;
  traceId?: string;    // 便于排障
}
```

### 5.2 HTTP 状态码 + 业务错误码表

**HTTP 状态码**（仅协议/系统层错误保留 HTTP 码给大类；业务结果一律 200 + 业务码）：

| 场景 | HTTP | 备注 |
| --- | --- | --- |
| 成功 / 业务失败 | 200 | 业务结果（含 DTO 参数校验失败）一律 200 + 业务 `code` |
| 未认证 | 401 | token 缺失/过期（JwtAuthGuard） |
| 资源不存在 | 404 | Prisma P2025 |
| 冲突 | 409 | Prisma P2002（唯一约束） |
| 服务异常 | 500 | 全局过滤器兜底，不泄漏堆栈 |

> 设计取舍（对标 WhatsApp/Telegram，见 §一/§三）：业务码是错误权威来源，HTTP 码只给系统层大类。
> 故 DTO 参数校验失败**纳入业务流**（200 + `10000`），而非 400——让前端在 success 回调统一按 `code` 分支。
> 201/403/429 暂未使用（资源创建走 200；越权/限流归业务码或 P3 throttler）。

**业务 `code` 段分配**（按域前缀分组，对标 WhatsApp Cloud API；完整定义见 `src/common/business-code.ts`）：

| 段 | 含义 | 主要码值 |
| --- | --- | --- |
| `0` | 成功 | `OK` |
| `10xxx` | 通用 | `10000` 参数校验 / `10001` 不存在 / `10002` 已存在 / `10003` 未认证 / `10004` 无权限 / `10005` 限流·IP封禁 / `10999` 服务器异常 |
| `20xxx` | 好友·会话状态机 | `20001` 自加好友 / `20002` 未知状态 / `20003` 无待处理请求 |
| `30xxx` | 消息域 | `30001` 空内容 / `30002` 会话未批准 / `30003` 无此会话 |
| `40xxx` | 群组域 | `40001` 非群成员 / `40002` 非好友不可邀请 / `40003` 无效邀请 token |

> 原则：HTTP 码回答「协议/系统层是否成立」，业务 `code` 回答「业务结果是什么」。两者不冲突。
> P1b 已落地：19 个业务失败点按上表重编号（详见 [docs/api.md](./api.md) 「业务错误码」小节）。

### 5.3 认证与安全契约

**refresh_token 落库**（Prisma 草案，替换 `_refreshTokenDict`）：

```prisma
model RefreshToken {
  id         BigInt   @id @default(autoincrement())
  userId     Int
  user       User     @relation(fields: [userId], references: [id])
  tokenHash  String   @unique          // 存哈希，不存明文
  device     String?                   // 多端标识
  createdAt  DateTime @default(now())
  expiresAt  DateTime
  revokedAt  DateTime?                 // 软吊销
  @@index([userId])
}
```

- 登录：签发后 `(userId, hash(token), device, expiresAt)` 入库。
- 续期：校验 `hash` 命中且未过期未吊销 → 旧记录置 `revokedAt`、签发新记录（**轮换**）。
- 登出：置 `revokedAt`。
- 定时清理 `expiresAt` 过期记录（替代现有 15 天内存清理）。

**密钥**（`.env`）：

```bash
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...   # 建议与 access 分离
GROUP_INVITE_SECRET=...
```

### 5.4 分页契约

```ts
interface CursorPageQuery<TCursor = number> {
  cursor?: TCursor;   // 对应现有 lastId
  take: number;       // 上限由后端钳制（如 ≤ 50）
  order: 'asc' | 'desc';
}

interface CursorPage<T> {
  list: T[];
  nextCursor?: number;
  hasMore: boolean;
}
```

### 5.5 WebSocket 事件目录

通用帧：

```ts
interface WsFrame<T = unknown> {
  event: WsEvent;
  code: number;       // 0 = 成功
  message: string;
  data?: T;
  seq?: number;       // 服务端→客户端递增，用于去重/补拉
}
```

| 事件 | 方向 | `data` | 说明 |
| --- | --- | --- | --- |
| `AUTH` | S→C | — | 鉴权结果（已有，保留） |
| `NEW_MESSAGE` | S→C | `{ threadId: number, msgId: string }` | 已有，加 `seq` |
| `MESSAGE_READ` | S→C | `{ threadId: number, userId: number, lastRead: string }` | 已读回执，消费 `lastRead` 字段 |
| `USER_TYPING` | S→C | `{ threadId: number, userId: number }` | 输入中 |
| `USER_PRESENCE` | S→C | `{ userId: number, online: boolean }` | 在线状态 |
| `NOTIFY` | S→C | `{ type: NotifyType, ... }` | 接入 `Notify` 表 |

> 客户端→服务端当前不发业务消息（保持）。`USER_TYPING` 等若需上行，再开启对应 `@SubscribeMessage`。

---

## 六、演进路线图

每档列出**内容**、**影响文件**、**验收**。

### P0 — 正确性与安全 ✅ 已完成

全局异常过滤器、ValidationPipe+DTO、refresh_token 落库（修 logout/renew-access/renew-refresh bug）、密钥外置、CORS 白名单+helmet 均已落地并端到端验证；后端依赖升级（NestJS 11 / Prisma 7 / TS 5.9，保持 CJS）完成。详见 git 历史。

### P1 — 契约与接入 ✅ 已完成

Swagger（`/api/v1/docs`）、`/api/v1` 版本前缀、HTTP 状态码对齐、class-validator DTO 全量、OpenAPI 全量、前端 `openapi-typescript` 类型生成、序列化拦截器（去 `Date.toJSON` hack）、业务码段规整均已落地。各端点入参/响应以**实时 OpenAPI**（`/api/v1/docs` + 前端生成类型）为唯一事实源。

> **P1 外挂（工程基建）— 后端整体转 ESM**（独立小任务，可与 P1a/P1b 并行；非 P1 契约范畴，仅就近归档）。`type:"module"` + `tsconfig`(`module/moduleResolution: NodeNext`、`target ES2023`、`esModuleInterop`) + 相对导入补 `.js`(全仓库 ~50–100 处) + `__dirname`/`require` → `import.meta.url`/`fileURLToPath` + CJS-only 工具(loader/ts-node)处理。**非必需**：Prisma 7 已验证兼容 CJS 消费(`@prisma/client` exports 提供 `require` 条件)。**前置依赖**：本轮「依赖升级」(NestJS 11 / Prisma 7 / TS 5.9)落地后再做。**触发点**(择一即可动手)：需引入 ESM-only 依赖 / 换 Vitest / Node 对 CJS 收紧。**注意**：代价≈范围/风险翻倍，且当前零后端测试网——动手前先补 auth e2e 冒烟。


### P2 — 实时体验与可靠性

| 内容 | 影响文件 | 验收 |
| --- | --- | --- |
| WS 心跳 | `src/gateway/event.gateway.ts` | 假死连接 90s 内被清理 |
| 消息 `seq` + 补拉 | gateway + 前端 `websocket.service.ts` | 弱网下推送缺口能补齐 |
| 已读回执 / 输入中 / 在线状态 | gateway、前端组件 | `lastRead` 被消费、状态实时刷新 |
| 接入 Notify | `src/notify/*`、`app.module.ts` | 通知表被写入与推送 |

### P2+ — 好友域功能补全（产品对齐）

> 本轮（2026-06-26）已修：互加好友自动批准入参顺序 bug（`makeFriendRequest` FROM_PENDING 分支）、`sendFriendRequest`/`acceptFriendRequest` 状态文案不准确、前端搜索结果按会话状态区分「可加/已是好友/已发过/对方发过你」（不再恒显示 Send Request）、`ngOnInit` 成功时误置错误文案、若干拼写。
> **拒绝好友请求**已实现：`POST user/decline-friend-request` + 前端 Pending 项 Decline 按钮。语义=删除这对请求行（双方 FROM_PENDING/TO_PENDING），回到初始态、不通知对方、允许重发（对标 Telegram）。
> 以下为遗留**功能缺口**（schema 已建模但无端点 / 无 UI），按产品对标（Telegram/Discord）应补，暂列待办：

| 内容 | 现状 | 影响 |
| --- | --- | --- |
| 撤回已发请求 | `FROM_PENDING` 无法 cancel | 用户无法撤回误发请求 |
| 删除好友 / 拉黑 | `DELETED`/`BLOCKED` 状态存在但无端点写入 | 无法解除好友、无防骚扰 |
| 请求附言 | `UserMessageThread.reqMessage` 字段未用，`send-friend-request` 仅收 `userId` | 无法带验证信息（对标微信/Telegram 附言） |
| 实时通知 | 新请求无推送，依赖前端轮询 Pending | 已纳入上方 P2「接入 Notify」 |

### P3 — 工程化与生产就绪

| 内容 | 影响文件 | 验收 |
| --- | --- | --- |
| 结构化日志 + traceId（含响应信封 traceId 字段） | 全局中间件/拦截器、`api-result.ts`、`exception.filter.ts` | 日志含 traceId 串联请求；响应信封注入 traceId（对标 WhatsApp `fbtrace_id`）供客户端报错附上、服务端据此查日志 |
| 响应信封结构化 `details` 字段 | `api-result.ts`、`exception.filter.ts` | 速率限制等附加数据（`bannedUntil`/`retry_after`）走 `details`，对标 Telegram `parameters` / WhatsApp `error_data`；P1b 暂放 `data` |
| 健康检查 | 新增 controller | `/api/v1/health` 返回 DB 状态 |
| 登录限流（共享存储 + 分层响应） | `src/auth/local.strategy.ts` → `@nestjs/throttler` / `rate-limiter-flexible` + Redis | **已落地（进程内内存）**：滑动窗口(15min) + IP/账户(uniqName)双维度 + `trust proxy` 取真实 IP + 渐进封禁（30min/3h/24h 阶梯，见 `local.strategy.ts`）。**P3 待办**：① 多实例共享存储(Redis，当前进程内重启即丢、多副本各自计数)；② 分层响应(CAPTCHA / 增加延迟 / 通知账户所有者，替代纯硬封禁)；③ 封禁时长温和化与阈值精调（当前 24h 偏长，有账号锁定型 DoS 风险）；④ 封禁可观测(结构化日志/告警)；⑤ 覆盖续期/发消息等端点 |
| 实现文件上传 | 新增 `src/file/*` + controller | 落库到 Message、返回可访问 URL（参考 [api.md](./api.md) 文件 API 设计意图）；大文件可走分片/对象存储 |

---

## 七、附录：改造点 → 文件映射

| 改造点 | 文件 |
| --- | --- |
| 版本前缀 + CORS + 序列化拦截器 + helmet + 全局管道/过滤器 | [src/main.ts](../src/main.ts)、[src/app.module.ts](../src/app.module.ts) |
| 异常过滤器 | 新增 `src/common/exception.filter.ts` |
| DTO 与校验 | [src/controller/*](../src/controller/)、新增 `src/common/dto/` |
| 响应信封合并 | [src/model.ts](../src/model.ts)、[src/controller/utils.ts](../src/controller/utils.ts) |
| refresh 落库 + 修 bug + 密钥 | [src/auth/auth.service.ts](../src/auth/auth.service.ts)、[src/auth/constants.ts](../src/auth/constants.ts)、[src/controller/auth.controller.ts](../src/controller/auth.controller.ts)、[prisma/schema.prisma](../prisma/schema.prisma) |
| WS 心跳/seq/事件 | [src/gateway/event.gateway.ts](../src/gateway/event.gateway.ts) |
| 文件上传 | P3 新增 `src/file/*` + controller（原死代码 P1b 已删） |
| 前端续期单飞 + WS 退避 | [web/src/app/auth.interceptor.ts](../web/src/app/auth.interceptor.ts)、[web/src/app/services/auth.service.ts](../web/src/app/services/auth.service.ts)、[web/src/app/services/websocket.service.ts](../web/src/app/services/websocket.service.ts) |
| 前端类型生成 | [web/](../web/)（新增 openapi-typescript 流水线） |
