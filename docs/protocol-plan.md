# 协议栈规划

本文档是 SOMS **后端接口与前后端交互协议栈**的目标设计基准，用于团队对齐与后续渐进式实施。它基于对现有代码（后端 5 个 controller、`EventGateway`、`AuthService`，前端 `AuthInterceptor` / `WebsocketService`）的审查，提出分层目标契约、错误码体系、WS 事件目录与演进路线图。

- **状态**：P0/P1 已完成并验证；实时通信已于 2026-06-30 由 WebSocket 迁移至 **SSE**（§4.5 / §5.5 / §六 P2 已据此重写）；本文档仅保留待办（P2 增量 / P2+ / P3 + ESM 外挂）。最后更新 2026-07-01。
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

> 以下为规划时（2026-06-22）的协议栈快照，其中标 ⚠️ 的项（无 `/api/v1` 前缀、错误全走 HTTP 200、refresh 仅内存字典、`Date.toJSON` hack、无 OpenAPI、无全局过滤器/ValidationPipe）**均已在 P0/P1 修复**。原「WS 无心跳、无序号」遗留已随 2026-06-30 的 **WS→SSE 迁移**消除（SSE `:ping` 心跳 + 帧 `id` + 重连游标补拉）——见 [§4.5](#45-实时通信sse-下行) / [§六 P2](#六演进路线图)。

### 已发现的协议层 bug 与隐患

> 原列 8 条协议层 bug/隐患（refresh 内存字典与 key 错配、renew-refresh 空指针、logout 取错字段、密钥硬编码、CORS 全开、`StandardResponse` 重复定义、file 域死代码、`Date.toJSON` 全局 hack）**均已在 P0/P1 修复**，详见 git 历史。

---

## 三、设计原则与保留项

### 保留的现有设计（规划围绕它们展开）

1. **会话统一抽象**：`MessageThread` / `UserMessageThread` 统一 P2P 与 GROUP，`status` 驱动生命周期。
2. **职责分离**：HTTP 负责「写与查」，SSE 负责「推」。
3. **双 Token 续期**：access 短(无状态) + refresh 长(可吊销)。
4. **游标分页**：`lastId` + `skip/take`。
5. **下行推送（SSE）**：SSE 单向推**完整消息体**（`{ threadId, ...message }`，已 `serializeBody` 序列化），前端收到即可直接渲染、无需二次拉取。HTTP 负责「写与查」+ SSE 负责「推」的职责分离不变。（原 WS 时代的「薄载荷 `{threadId, msgId}` + 二次拉取」设计已在 2026-06-30 的 WS→SSE 迁移中废止——见 [§4.5](#45-实时通信sse-下行)。）

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

### 4.5 实时通信（SSE 下行）

> 2026-06-30 已由 WebSocket 迁移至 **SSE（Server-Sent Events）**：WS 只承担下行推送却背负连接/重连/心跳/子协议鉴权全部复杂度（曾滋生 31 条 token/WS bug），改用 SSE「只推送」专用通道一次根除。下行为 SSE 单向流，**所有客户端上行（发消息、未来的 typing）一律走 HTTP**。

1. **通道**：`GET /api/v1/events`（`text/event-stream`），手动 `res.writeHead` + `X-Accel-Buffering: no`（防 Nginx 攒批缓冲）；首帧 `: connected` 注释冲头触发前端 `onopen`。一个用户可有多条连接（多标签/多端），`res.on('close')` 清理。
2. **鉴权**：复用与普通受保护路由同一套 `JwtAuthGuard`（验签 + 过期 + jti 黑名单 + `tokenVersion` 撤销感知），token 走 `Authorization: Bearer` 头，**不进 URL**（无日志/Referer 泄漏）。失败 → HTTP 401，前端 `onopen` 收到后 renew + 重开。不再需要 WS 的 `AUTH` 握手帧。
3. **心跳与判死**：服务端每 25s 写 `: ping` 注释帧（< Nginx `proxy_read_timeout` 60s）；SSE 单向无 pong，靠 `res.write` 返回 `false`（对端已断/背压）感知断开 → `res.end()` → `close` 回调清理。判死窗口 ≤ 25s。
4. **推送载荷**：推**完整消息体**（`serializeBody({ threadId, ...message })`，BigInt→string / Date→ms，与 HTTP 响应同口径），前端收到即可直接渲染、**无需二次 `query-messages`**（原 WS「薄载荷 `{threadId, msgId}` + 二次拉取」设计已废止）。帧带 `id: <msgId>`。
5. **顺序与完整性**：单条 SSE 连接存活期间，消息**严格有序、完整**到达——由底层 TCP 保证（服务端 `write` 顺序即客户端收到顺序，字节流可靠重组）。SSE 层无需自加 `seq`，这正是迁移省掉的复杂度。
6. **断线续传**：SSE 流本身不回放历史（服务端不消费 `Last-Event-ID`）。连接断开（含 ≤25s 假死窗口）期间的消息会丢，重连成功后前端发 `reconnect$` 信号，各会话按 `newestMsgId` 游标走 HTTP 增量补拉（`refillNewer`）。同一用户的多条连接各自有序、跨连接不保证。
7. **强制下线**：全设备登出 / 改密 / admin 踢下线触发 `auth.sessions-invalidated` 事件 → `SseService` 向该用户所有连接推 `FORCE_LOGOUT` 后立即断开。
8. **扩展事件**（均下行）：`USER_PRESENCE`（待实现）、`NOTIFY`（**已实现**：好友请求触发 `NotifyService.recordFriendRequest` 原子写表 + 点亮角标，并由 `SseService.onNotify` 实时推送，前端 `home` 收到即点亮未读角标；详见 [§六 P2](#p2--实时体验与可靠性)）。注意 `USER_TYPING` 属**客户端上行**，SSE 不能承载，须新增 HTTP 端点。

### 4.6 前后端协同

1. **续期单飞（single-flight）** ✅ 已落地：`renewAccessToken()` 用 `shareReplay({ bufferSize:1, refCount:true })` + `finalize`，并发 401 共享同一在飞请求，替换手写标志位。统一只走 `/auth/renew-access`（后端同时轮换 refresh），删除旧的 7 天定时器 / `renewRefreshToken` / `tokenCreateTime` 机制。
2. **SSE 重连：指数退避 + 全抖动** ✅ 已落地：`delay = random(0, min(1000·2^attempt, 30000))`，base 1s、封顶 30s、成功连上归零（抗惊群）；401 单独走 renew 后立即重开（不计退避）。替代原固定 10s。
3. **前端统一错误处理** ✅ 部分落地：401 → 单飞 renew + 重试 1 次（上限、不递归）；renew 失败（reuse `10006` / 失效 `10003`）→ `redoLoginAuth` 强制重登；SSE `FORCE_LOGOUT` → 断开 + 强登。**待补**：429 退避、5xx 降级提示（见 P3）。

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

### 5.5 SSE 事件目录

通用帧（SSE 文本流，空行 `\n\n` 分帧；`event` 行定事件名，`id` 行做游标，`data` 行为 JSON 字符串）：

```
event: <EVENT_NAME>
id: <msgId>          # 仅 NEW_MESSAGE 带此行
data: <json>
```

鉴权不在帧里——走 HTTP：连接时 `JwtAuthGuard` 失败直接 401（前端 renew + 重开），故**无 `AUTH` 帧**。`: connected` / `: ping` 是 SSE 注释行（不计为事件），用于冲头与心跳。

| 事件 | 方向 | `data` | 说明 |
| --- | --- | --- | --- |
| `NEW_MESSAGE` | S→C | `{ threadId, id, content, contentType, createdAt, ... }`（完整消息体，已序列化） | 对方/群成员发新消息；前端收到即可渲染，无需二次拉取。帧 `id` = 消息 id |
| `FORCE_LOGOUT` | S→C | `{ event:'FORCE_LOGOUT', status:0, message:<reason> }` | 全设备登出 / 改密 / admin 踢下线；前端断开 + 强制重登 |
| `USER_PRESENCE` | S→C（待实现） | `{ userId, online }` | 在线状态 |
| `NOTIFY` | S→C（已实现） | `{ event:'NOTIFY', type:'FRIEND_REQUEST', fromUserId }` | 好友请求触发：原子写 `Notify` 表 + 点亮 `hasUrFriendReq` 角标 + SSE 实时推（`SseService.onNotify`） |

> **上行约束**：SSE 单向，客户端→服务端不发业务消息。`USER_TYPING`（输入中）等上行一律走 HTTP `POST`（待新增端点）。原 WS 时代的 `@SubscribeMessage` 上行通道随迁移删除。

---

## 六、演进路线图

每档列出**内容**、**影响文件**、**验收**。

### P0 — 正确性与安全 ✅ 已完成

全局异常过滤器、ValidationPipe+DTO、refresh_token 落库（修 logout/renew-access/renew-refresh bug）、密钥外置、CORS 白名单+helmet 均已落地并端到端验证；后端依赖升级（NestJS 11 / Prisma 7 / TS 5.9，保持 CJS）完成。详见 git 历史。

### P1 — 契约与接入 ✅ 已完成

Swagger（`/api/v1/docs`）、`/api/v1` 版本前缀、HTTP 状态码对齐、class-validator DTO 全量、OpenAPI 全量、前端 `openapi-typescript` 类型生成、序列化拦截器（去 `Date.toJSON` hack）、业务码段规整均已落地。各端点入参/响应以**实时 OpenAPI**（`/api/v1/docs` + 前端生成类型）为唯一事实源。

> **P1 外挂（工程基建）— 后端整体转 ESM** ✅ **已完成**（2026-07，分支 `refactor/cjs-to-esm`）。落地内容：`tsconfig`(`module/moduleResolution: NodeNext`、`target ES2022`、`esModuleInterop: true`、`useDefineForClassFields: false`——后者须显式 false，否则 ES2022 默认 true 会破坏 Nest 属性注入 + `@nestjs/swagger` 元数据插件) + `package.json` `type:"module"` + 全仓库相对导入补 `.js`(codemod 148 处) + 5 处 CJS-ism 改默认导入(`compression`/`sharp`/`argon2`×2/`dayjs`)。**前置测试网已补**：先建 auth e2e 冒烟(register→login→guarded，`soms_test` 隔离库)，CJS 下 green 作回归锚，ESM 后仍 green。**工具链**：dev 跑 `tsx`(ts-node ESM 已弃用)、测试换 `Vitest`(原生 ESM)。**根治兑现**：Prisma 7 `generate` 在 NodeNext 下产出 ESM client，Node 24 module-detection 不再误判；Dockerfile 的 `COPY tsconfig` 先序保留(`generate` 仍需读 `module`)，但 node 24.16 的 CJS 规避 pin 已撤为 `node:24`。`@nestjs/swagger` CLI 插件注入的 `require("@nestjs/swagger")` 经 tsc emit 为 createRequire 版 `__require`，ESM 下运行正常。详见 memory `prisma-generate-tsconfig-order`。


### P2 — 实时体验与可靠性

> 2026-06-30 WS→SSE 迁移后重对账：原 P2 前两项（WS 心跳 / seq 补拉）是为修 WS 可靠性，SSE 已用更简方式达成；后两项（在线状态·Notify）是纯增量功能，且因 SSE 单向，上行部分须走 HTTP。
> 2026-06-30 已读回执从路线图移除（与 `docs/chat-message-list-design.md`「已读回执：不做」一致）；`UserMessageThread.lastRead` 字段保留为未用死字段（暂不迁移）。

| 内容 | 状态 | 影响 | 验收 |
| --- | --- | --- | --- |
| 心跳与判死 | ✅ SSE 已落地 | `src/gateway/sse.service.ts` | `: ping @25s` + `write` 失败判死；假死连接 ≤25s 清理（原 90s 目标已超越） |
| 断线续传补拉 | ✅ SSE 已落地 | 前端 `websocket.service.ts`（`reconnect$` + `refillNewer`） | 重连后按 `newestMsgId` 游标 HTTP 补齐断线期间漏消息 |
| 输入中 / 在线状态 | ⏳ 待办 | 新增 HTTP 上行端点（typing）+ SSE 下行事件（`USER_PRESENCE`）+ 前端组件 | 在线状态实时刷新。**注意**：SSE 单向，typing 须走 HTTP POST，不能再 `@SubscribeMessage` |
| 接入 Notify | ✅ 已落地 | `notify.service.ts`（`recordFriendRequest` 原子写表+点角标）、`controller/notify.controller.ts`（`mark-friend-req-read` 清角标）、`gateway/sse.service.ts`（`onNotify` 实时推）、前端 `home.component.ts`（收 `NOTIFY` 点角标） | 新好友请求：原子写 `Notify` 表 + 点亮 `hasUrFriendReq` 角标 + SSE 实时推 `NOTIFY`；用户查看后 `mark-friend-req-read` 清角标 |

> **下一步工作重心** = P2 在线状态 / typing（**Notify 已落地**）：SSE 单向下，typing 须新增 HTTP 上行端点 + `USER_PRESENCE` 下行事件 + 前端组件；这是 SSE 迁移后实时体验的主要缺口，也是当前分支 `refactor/sse-token` 合并 `dev` 后的首选续作。

### P2+ — 好友域功能补全（产品对齐）

> 本轮（2026-06-26）已修：互加好友自动批准入参顺序 bug（`makeFriendRequest` FROM_PENDING 分支）、`sendFriendRequest`/`acceptFriendRequest` 状态文案不准确、前端搜索结果按会话状态区分「可加/已是好友/已发过/对方发过你」（不再恒显示 Send Request）、`ngOnInit` 成功时误置错误文案、若干拼写。
> **拒绝好友请求**已实现：`POST user/decline-friend-request` + 前端 Pending 项 Decline 按钮。语义=删除这对请求行（双方 FROM_PENDING/TO_PENDING），回到初始态、不通知对方、允许重发（对标 Telegram）。
> **撤回已发请求**已实现：`POST user/cancel-friend-request` + 前端「我发出的」项 Cancel 按钮。复用 decline 的「双方行 → DELETED」逻辑，语义=我主动撤回自己发出的待处理请求、对方不感知、可重发。
> **实时通知**已实现（随 P2「接入 Notify」落地，见上）：新好友请求经 SSE `NOTIFY` 实时推送，不再依赖前端轮询。
> 以下为遗留**功能缺口**（schema 已建模但无端点 / 无 UI），按产品对标（Telegram/Discord）应补，暂列待办：

| 内容 | 现状 | 影响 |
| --- | --- | --- |
| 删除好友 / 拉黑 | `DELETED`/`BLOCKED` 状态存在但无端点写入 | 无法解除好友、无防骚扰 |
| 请求附言 | `UserMessageThread.reqMessage` 字段未用，`send-friend-request` 仅收 `userId` | 无法带验证信息（对标微信/Telegram 附言） |

### P3 — 工程化与生产就绪

| 内容 | 影响文件 | 验收 |
| --- | --- | --- |
| 结构化日志 + traceId（含响应信封 traceId 字段） | 全局中间件/拦截器、`api-result.ts`、`exception.filter.ts` | 日志含 traceId 串联请求；响应信封注入 traceId（对标 WhatsApp `fbtrace_id`）供客户端报错附上、服务端据此查日志 |
| 响应信封结构化 `details` 字段 | `api-result.ts`、`exception.filter.ts` | 速率限制等附加数据（`bannedUntil`/`retry_after`）走 `details`，对标 Telegram `parameters` / WhatsApp `error_data`；P1b 暂放 `data` |
| 健康检查 | 新增 controller | `/api/v1/health` 返回 DB 状态 |
| 登录限流（共享存储 + 分层响应） | `src/auth/local.strategy.ts` → `@nestjs/throttler` / `rate-limiter-flexible` + Redis | **已落地（进程内内存）**：滑动窗口(15min) + IP/账户(account)双维度 + `trust proxy` 取真实 IP + 渐进封禁（30min/3h/24h 阶梯，见 `local.strategy.ts`）。**P3 待办**：① 多实例共享存储(Redis，当前进程内重启即丢、多副本各自计数)；② 分层响应(CAPTCHA / 增加延迟 / 通知账户所有者，替代纯硬封禁)；③ 封禁时长温和化与阈值精调（当前 24h 偏长，有账号锁定型 DoS 风险）；④ 封禁可观测(结构化日志/告警)；⑤ 覆盖续期/发消息等端点 |
| 文件上传（大文件 / 对象存储） | `src/upload/*`（聊天图片上传 + 头像 `sharp` 多档重写**已落地**） | **已落地**：聊天图片 + 头像上传、返回 `/uploads/...` URL（聊天图不接 `sharp` 以保 GIF 画质，头像接 `sharp`）；**待办**：大文件分片 / 对象存储、速率限制 / 并发内存 / 孤儿清理（见 image-upload 安全路线图） |

---

## 七、附录：改造点 → 文件映射

| 改造点 | 文件 |
| --- | --- |
| 版本前缀 + CORS + 序列化拦截器 + helmet + 全局管道/过滤器 | [src/main.ts](../src/main.ts)、[src/app.module.ts](../src/app.module.ts) |
| 异常过滤器 | 新增 `src/common/exception.filter.ts` |
| DTO 与校验 | [src/controller/*](../src/controller/)、新增 `src/common/dto/` |
| 响应信封合并 | [src/model.ts](../src/model.ts)、[src/controller/utils.ts](../src/controller/utils.ts) |
| refresh 落库 + 修 bug + 密钥 | [src/auth/auth.service.ts](../src/auth/auth.service.ts)、[src/auth/constants.ts](../src/auth/constants.ts)、[src/controller/auth.controller.ts](../src/controller/auth.controller.ts)、[prisma/schema.prisma](../prisma/schema.prisma) |
| SSE 下行（鉴权 / 心跳 / 推送 / 判死 / 强制下线） | [src/gateway/events.controller.ts](../src/gateway/events.controller.ts) + [src/gateway/sse.service.ts](../src/gateway/sse.service.ts) |
| 文件上传 | [src/upload/](../src/upload/)（`upload.controller` + `upload.service`，聊天图片上传已实现；头像 `sharp` 多档重写共用 `src/upload/`） |
| 前端续期单飞 + SSE 重连退避 | [web/src/app/auth.interceptor.ts](../web/src/app/auth.interceptor.ts)、[web/src/app/services/auth.service.ts](../web/src/app/services/auth.service.ts)、[web/src/app/services/websocket.service.ts](../web/src/app/services/websocket.service.ts)（文件名保留，内部已改 `@microsoft/fetch-event-source`） |
| 前端类型生成 | [web/](../web/)（新增 openapi-typescript 流水线） |
