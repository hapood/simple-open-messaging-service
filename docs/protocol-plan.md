# 协议栈规划

本文档是 SOMS **后端接口与前后端交互协议栈**的目标设计基准，用于团队对齐与后续渐进式实施。它基于对现有代码（后端 5 个 controller、`EventGateway`、`AuthService`，前端 `AuthInterceptor` / `WebsocketService`）的审查，提出分层目标契约、错误码体系、WS 事件目录与演进路线图。

- **状态**：规划草案（2026-06-22）
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

## 二、现状评估

### 协议栈速览

| 层 | 现状 | 评价 |
| --- | --- | --- |
| 传输 | HTTP/1.1 + 原生 `ws`（同端口 3000） | OK |
| HTTP 方法 | 全 `POST`（含所有查询），无 `/api/v1` 前缀 | ⚠️ 丢 HTTP 语义、无版本策略 |
| 响应信封 | `{ status, message, data }`，`status:0` 成功 | 业务码可行，但**所有错误都走 HTTP 200** |
| 鉴权 | `Authorization: Bearer`，公共接口用 `'public'` 哨兵 | 思路 OK |
| Token | access 15min(内存) + refresh 14d(**仅内存字典**) | ⚠️ 重启失效、有删除 bug、不可水平扩展 |
| 序列化 | 全局 `Date.prototype.toJSON` hack + 手动 `convertBigIntId` | ⚠️ 全进程副作用 |
| WS 鉴权 | 子协议 `Sec-WebSocket-Protocol` 传 token | 能 work，非主流 |
| WS 事件 | `AUTH` / `NEW_MESSAGE`，仅推 `{threadId,msgId}` | 薄载荷+二次拉取合理；**无心跳、无序号、事件少** |
| 契约 | 无 OpenAPI，类型前后端手抄 | ⚠️ 冲突接入目标 |
| 校验/异常 | 手写 `if`，无全局过滤器/ValidationPipe | ⚠️ 500 会泄漏堆栈 |

### 已发现的协议层 bug 与隐患

| # | 位置 | 问题 |
| --- | --- | --- |
| 1 | [src/auth/auth.service.ts](../src/auth/auth.service.ts) | refresh_token 仅存内存 `_refreshTokenDict`；`removeRefreshToken` 与清理定时器存在 **key 错配**（按 `userId` 查字典，字典以 token 为 key），续期/登出的删除实际不生效 |
| 2 | [src/controller/auth.controller.ts](../src/controller/auth.controller.ts) `renew-refresh` | 在 `if (info !== undefined)` 之前就调用 `removeRefreshToken(info.sub, ...)`，`info` 为 `undefined` 时抛 500 |
| 3 | [src/controller/auth.controller.ts](../src/controller/auth.controller.ts) `logout` | 从 `req.user['refreshToken']` 取 refreshToken，但 **JWT payload 里只有 `sub`**，取不到值；前端实际是把 refreshToken 放在 body 里、且走 `'public'` 头 |
| 4 | [src/auth/constants.ts](../src/auth/constants.ts)、[src/group/group.service.ts](../src/group/group.service.ts) | JWT / 邀请 token 签名密钥**硬编码** |
| 5 | [src/main.ts](../src/main.ts) | `app.enableCors()` 默认全开（生产不安全） |
| 6 | [src/model.ts](../src/model.ts) ↔ [src/controller/utils.ts](../src/controller/utils.ts) | `StandardResponse` 重复定义 |
| 7 | [src/controller/file.controller.ts](../src/controller/file.controller.ts) | `/file/send-video` 路由重复（音频端点误用同路径）；handler 仅 `console.log`，不落库不返回 URL |
| 8 | [src/main.ts](../src/main.ts) | 全局覆盖 `Date.prototype.toJSON`，影响整个进程 |

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

**HTTP 层**（反映传输/鉴权/参数结果，标准客户端据此分支）：

| 场景 | HTTP | 备注 |
| --- | --- | --- |
| 成功 | 200 / 201 | 201 用于资源创建 |
| 参数错误 | 400 | DTO 校验失败 |
| 未认证 | 401 | token 缺失/过期 |
| 无权限 | 403 | 鉴权通过但越权 |
| 资源不存在 | 404 | |
| 限流 | 429 | |
| 服务异常 | 500 | 全局过滤器兜底，不泄漏堆栈 |

**业务 `code` 段分配**（业务结果细分，HTTP 通常仍为 200）：

| 段 | 含义 | 示例 |
| --- | --- | --- |
| `0` | 成功 | |
| `10xxx` | 通用业务 | `10001` 资源不存在 |
| `20xxx` | 好友/会话状态机 | 沿用现有语义：`0` 首次 / `20001` 已是好友 / `20002` 重新发起 / `20003` 对方先请求直接建立 / `20005` 不再打扰 |
| `30xxx` | 消息域 | `30001` 无内容、`30002` 会话未建立 |
| `40xxx` | 群组域 | `40001` 非群成员、`40002` 非好友不可邀请 |

> 原则：HTTP 码回答「请求在协议层是否成立」，业务 `code` 回答「业务结果是什么」。两者不冲突。

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

### P0 — 正确性与安全（必须先堵）

> ✅ **本轮已完成 4/5**：全局异常过滤器、refresh_token 落库（修 logout / renew-access / renew-refresh bug）、密钥外置、CORS 白名单 + helmet。② ValidationPipe + DTO 仍按 **P1a** 推进（与 Swagger 同做，避免返工）。迁移命令 `npx prisma migrate dev --name add_refresh_token` 需 PG 可连通后执行。
>
> ✅ **已端到端验证**（PG18/Timescale 实例，真实 DB）：重启后续期可用、refresh 轮换、`renew-access` 不销毁 refresh、登出真正吊销、异常过滤器不泄漏堆栈、CORS 白名单生效（非白名单 origin 被拦）。
>
> 📌 **验证中额外发现并修复**（均归入 P0）：① refresh token 加 `jti`（防同一秒为同一用户签发导致的 `tokenHash` 唯一冲突）；② `main.ts` 接入 `dotenv/config` 自加载 `.env`；③ `start:prod` 路径修正（`dist/main` → `dist/src/main`）；④ 迁移顺手补上历史 drift（`ContentType` 枚举 `FILE`/`AUDIO` 此前只改了 schema 未建迁移）。
>
> 📌 **依赖升级**（NestJS 10→11 / Prisma 5→7 / Angular 18→最新）经决定作为**独立任务**，不并入 P0——避免 P0 爆炸半径过大。

| 内容 | 影响文件 | 验收 |
| --- | --- | --- |
| 全局异常过滤器 | 新增 `src/common/exception.filter.ts` | 任意异常返回 `ApiResult` + 正确 HTTP 码，无堆栈泄漏 |
| ValidationPipe + DTO | `src/controller/*`、新增 DTO 目录 | 缺字段/类型错返回 400 + 字段级错误信息 |
| refresh_token 落库 + 修 logout/renew-refresh bug | `schema.prisma`、`src/auth/auth.service.ts`、`auth.controller.ts` | 重启后续期仍有效；登出真正吊销；续期轮换 |
| 密钥外置 | `src/auth/constants.ts`、`src/group/group.service.ts`、`.env.example` | 无硬编码 secret，缺 env 启动报错 |
| CORS 白名单 + helmet | `src/main.ts` | 生产仅允许配置的 origin |

### P1 — 契约与接入（服务第三方接入目标）

P1 拆为两步推进：**P1a 最小子集先行**（解锁契约 + 前端 mock），**P1b 补齐其余**。

**P1a — 最小子集（优先落地）**

| 内容 | 影响文件 | 验收 |
| --- | --- | --- |
| Swagger + `/api/v1/docs` + 核心接口 OpenAPI | `main.ts` + 核心 DTO（login / register / send-message / query-messages / query-thread / send-friend-request 等） | OpenAPI 可访问、核心接口入参与响应 schema 完整 |

> 为什么优先：P1a 一完成，即可用 Prism 做契约驱动 mock（见下方「前端 mock 衔接」），前端开发不再依赖完整后端。它本身就是 P1 该做的，不欠债，又对冲了「前端临时要写却没有 mock」的风险——建议作为 P1 的第一块。

**P1b — 其余契约化**

| 内容 | 影响文件 | 验收 |
| --- | --- | --- |
| `/api/v1` 版本前缀 + HTTP 状态码对齐 | 全部 controller、`main.ts` | 4xx/5xx 走标准码，业务码在 200 |
| class-validator DTO 全量（覆盖 P1a 未含接口） | controller + DTO 目录 | 所有端点入参有 DTO 与文档 |
| OpenAPI 全量补齐 | 剩余接口 | 所有端点文档完整 |
| 前端类型生成 | `web/` 接入 `openapi-typescript` | 前端 service 类型由生成产物驱动 |
| 序列化拦截器 + 去 `Date.toJSON` hack | `src/main.ts`、新增拦截器、移除 `convertBigIntId` 调用 | Date/BigInt 统一序列化，无全局副作用 |

#### P1a 核心接口 checklist

下表为 P1a 需补全 OpenAPI 的核心接口，覆盖前端 mock 一个可用 IM 的最小闭环：**注册 → 登录 → 会话列表 → 发消息 → 查历史 → 加好友**。群组接口（create/invite/join/info）、`thread-info`、`by-user-id` 等归 P1b。

> 约定：P1b 起统一加 `/api/v1` 前缀（下表列相对路径）；写/查接口均为 `POST` + JSON body + `ApiResult` 返回（见 5.1）；业务码沿用当前实现，P1b 起按 5.2 错误码段规整。

**共享类型**（定义一次，各接口引用）

- `User`：`{ id, uniqName, isForeigner, domain?, createdAt, updatedAt, isDeleted, userExtra:{name,avatar}, userNotiBox }`（不含 hashPwd）
- `Message`：`{ id:string, contentType, content, threadId, creator, createdAt, updatedAt, isDeleted }`（id 为 BigInt→string）
- `UserMessageThread`：`{ id, userId, status, toObjType, toObjId, reqMessage, threadId?, createdAt, updatedAt, isDeleted, lastRead?:string }`
- 枚举：`MessageThreadType=P2P|GROUP`；`UserMessageThreadStatus=FROM_PENDING|TO_PENDING|APPROVED|BLOCKED|DELETED`；`ContentType=PURE_TEXT|INVITE|IMAGE|VIDEO|FILE|AUDIO`
- 序列化：Date→毫秒时间戳(number)；BigInt id→string

**① 认证**（除 logout 外均 public）

| 接口 | 鉴权 | 入参 | 响应 data | 备注 |
| --- | --- | --- | --- | --- |
| `POST /auth/login` | Local | `{ uniqName, password }` | `{ access_token, refresh_token }` | code: 1 凭据错；2 IP 封禁 `data.bannedUntil` |
| `POST /user/register` | public | `{ uniqName, password }` | `{ id, uniqName }` | uniqName 正则 + pwd 6–20；code: 2 已存在 |
| `POST /auth/renew-access` | public | `{ refreshToken }` | `{ access_token }` | code: 1 invalid |
| `POST /auth/renew-refresh` | public | `{ refreshToken }` | `{ access_token, refresh_token }` | ⚠️ P0 修 info 空指针；code: 1 invalid |
| `POST /auth/logout` | JWT | `{ refreshToken }` | — | ⚠️ P0 修：挂了 JwtAuthGuard 但前端发 public、且从 JWT 取 refreshToken（取不到），鉴权方式需统一 |

**② 会话**（均 JWT）

| 接口 | 入参 | 响应 data |
| --- | --- | --- |
| `POST /user/query-thread/valid` | `{ skip, take, lastId?, toObjType? }` | `UserMessageThread[]`；P2P 项带 `userItem:User`、GROUP 项带 `groupItem` |
| `POST /user/query-thread/to-pending` | `{ beforeDate, take, skip }` | `UserMessageThread[]`（含 threadItem） |

**③ 消息**（均 JWT）

| 接口 | 入参 | 响应 data | 备注 |
| --- | --- | --- | --- |
| `POST /send-message` | `{ userThreadId, content }` | `Message`（新建） | code: 0 成功 / 1 会话未 approved / 2 无内容；副作用 WS 推 NEW_MESSAGE |
| `POST /query-messages` | `{ userThreadId, skip, take, lastId?, orderBy }` | `Message[]` | 游标分页；code: 2 无此会话 |

**④ 好友**（均 JWT）

| 接口 | 入参 | 响应 | 备注（对外 code） |
| --- | --- | --- | --- |
| `POST /user/send-friend-request` | `{ userId }` | `code/message` | 0 成功（首次/已是好友/重新发起/对方先请求→建立）/ 2 用户不存在 / 3 不可加自己 / 1 未知 |
| `POST /user/approve-friend-request` | `{ userId }`（发起方） | `code/message` | 0 建立成功 / 1 未收到请求 |

**⑤ 用户**（均 JWT）

| 接口 | 入参 | 响应 data | 备注 |
| --- | --- | --- | --- |
| `POST /user/my-profile` | — | `User`（当前用户） | |
| `POST /user/query` | `{ userIds:number[] }` | `User[]` | ≤100；code: 1 超限 |
| `POST /user/by-uniq-name` | `{ uniqName }` | `User` | code: 1 找不到 |

**WebSocket 事件**（非 OpenAPI，前端 mock 需手写——往 `eventSubject` 灌帧）

| 事件 | data | mock 用途 |
| --- | --- | --- |
| `AUTH` | — | 连接鉴权结果（code 0/1/2） |
| `NEW_MESSAGE` | `{ threadId:number, msgId:string }` | 模拟对方/群成员发消息，触发前端增量拉取 |

> mock 提示：登录/续期返回的 token 用任意字符串即可（mock 不校验签名）；发消息后由 mock 主动推一条 `NEW_MESSAGE` 即可驱动 UI；状态化场景（好友审批、消息顺序）需 mock 自维护内存状态——这正是 Prism 静态 mock 的局限（见下方）。

#### 前端 mock 衔接（P1a 之后）

P1a 完成后，前端 mock 由 OpenAPI 契约驱动，无需手写：

| 方案 | 适用 | 说明 |
| --- | --- | --- |
| **Prism + OpenAPI**（首选） | P1a 之后 | `prism mock openapi.yaml` 起契约 mock server，前端 `apiPrefix` 指向它；后端改 spec→mock 自动跟随 |
| **SQLite 开发后端**（备选） | 嫌 PG 重、要真联调 | Prisma 开发期换 SQLite provider，真实后端秒起，不废弃、无 mock 债 |
| **MSW / MockInterceptor**（过渡） | P1a 之前急需写前端 | 仅作过渡，P1a 后被 Prism 取代；勿为短期需求搭建会被丢弃的 mock |

> 局限：Prism 基于 schema 生成数据，类型对但业务不真。IM 的状态化场景（消息时序、好友状态机、已读回执）等「有状态」交互，静态 mock 可能不够，仍需少量手写补状态（例如往 WS `eventSubject` 灌模拟帧）。

### P2 — 实时体验与可靠性

| 内容 | 影响文件 | 验收 |
| --- | --- | --- |
| WS 心跳 | `src/gateway/event.gateway.ts` | 假死连接 90s 内被清理 |
| 消息 `seq` + 补拉 | gateway + 前端 `websocket.service.ts` | 弱网下推送缺口能补齐 |
| 已读回执 / 输入中 / 在线状态 | gateway、前端组件 | `lastRead` 被消费、状态实时刷新 |
| 接入 Notify | `src/notify/*`、`app.module.ts` | 通知表被写入与推送 |

### P3 — 工程化与生产就绪

| 内容 | 影响文件 | 验收 |
| --- | --- | --- |
| 结构化日志 + traceId | 全局中间件/拦截器 | 日志含 traceId，可串联一次请求 |
| 健康检查 | 新增 controller | `/api/v1/health` 返回 DB 状态 |
| 限流 | `@nestjs/throttler` | 登录/续期/发消息有明确配额 |
| 补全文件上传 | `src/file/*`、`file.controller.ts` | 落库、返回 URL、修重复路由；大文件可走分片/对象存储 |

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
| 文件上传 | [src/controller/file.controller.ts](../src/controller/file.controller.ts)、[src/file/*](../src/file/) |
| 前端续期单飞 + WS 退避 | [web/src/app/auth.interceptor.ts](../web/src/app/auth.interceptor.ts)、[web/src/app/services/auth.service.ts](../web/src/app/services/auth.service.ts)、[web/src/app/services/websocket.service.ts](../web/src/app/services/websocket.service.ts) |
| 前端类型生成 | [web/](../web/)（新增 openapi-typescript 流水线） |
