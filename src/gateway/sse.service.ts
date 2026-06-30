import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Response } from 'express';

/**
 * SSE（Server-Sent Events）下行推送服务：只推送，不收业务上行。
 *
 * 与 WS 相比，SSE 是「单向推送」专用通道，浏览器原生断线续传（Last-Event-ID）+
 * fetch-event-source 的可控重连，从根上消除「连接/重连/鉴权」一整类复杂度。
 *
 * 一个用户可有多个在线 SSE 连接（多标签/多端），用数组收纳。
 * res.on('close') 清理，避免引用残留（内存泄漏）。
 */
@Injectable()
export class SseService implements OnModuleDestroy {
  /** 心跳间隔（须 < Nginx proxy_read_timeout 默认 60s）。注释行 `: ping` 不被前端当事件。 */
  private static readonly HEARTBEAT_MS = 25000;
  private readonly clients: Record<
    number,
    { res: Response; ping: NodeJS.Timeout; since: number }[]
  > = {};

  /**
   * 注册一条 SSE 长连接：
   * 1. 写出流式响应头（X-Accel-Buffering:no 告诉 Nginx 不要缓冲，否则消息会被攒批延迟推送）
   * 2. 写一帧 `: connected` 注释，把响应头/初始字节立即冲出去（触发前端 onopen）
   * 3. 计入 userId 的连接列表 + 启动心跳
   * 4. res.on('close') 时清理连接与心跳定时器
   *
   * 鉴权已由 JwtAuthGuard 在进入本服务前完成（verify 签名/过期 + 撤销感知 jti 黑名单/tokenVersion），
   * 故此处只做推送，不再校验。
   */
  register(userId: number, res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const ping = setInterval(() => {
      // 心跳：注释帧。写入失败（连接已断）→ 主动 end，让 close 回调兜底清理。
      if (!res.write(': ping\n\n')) {
        try {
          res.end();
        } catch {}
      }
    }, SseService.HEARTBEAT_MS);

    const entry = { res, ping, since: Date.now() };
    (this.clients[userId] ??= []).push(entry);

    res.on('close', () => {
      clearInterval(ping);
      const list = this.clients[userId];
      if (!list) return;
      const idx = list.indexOf(entry);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) delete this.clients[userId];
    });
  }

  /**
   * 当前在线 SSE 连接快照（供 admin 控制台观测，只读）。
   * 按用户聚合：一个用户多标签 → 多条连接合并为一条，since 取其最早建立时间。
   * 不含任何敏感信息（无 token/无 IP），仅 userId + 连接数 + 建连时刻。
   */
  snapshot(): {
    total: number;
    uniqueUsers: number;
    clients: { userId: number; connections: number; since: number }[];
  } {
    const uids = Object.keys(this.clients).map(Number);
    const clients = uids.map((uid) => {
      const list = this.clients[uid];
      return {
        userId: uid,
        connections: list.length,
        since: list.reduce((min, c) => Math.min(min, c.since), Date.now()),
      };
    });
    clients.sort((a, b) => a.since - b.since);
    return {
      total: clients.reduce((sum, c) => sum + c.connections, 0),
      uniqueUsers: clients.length,
      clients,
    };
  }

  /** 新消息：推给该用户的所有在线 SSE 连接。id=消息 id（前端据此做 Last-Event-ID 断线续传游标）。 */
  onNewMessage(userId: number, data: unknown) {
    const list = this.clients[userId];
    if (!list || list.length === 0) return;
    const id = (data as { id?: string | number } | null)?.id;
    const frame =
      `event: NEW_MESSAGE\n` +
      (id !== undefined && id !== null ? `id: ${id}\n` : '') +
      `data: ${JSON.stringify(data)}\n\n`;
    // 倒序遍历，写失败/已断的连接边写边清，避免残留。
    for (let i = list.length - 1; i >= 0; i--) {
      const { res } = list[i];
      try {
        if (!res.write(frame)) {
          // 背压：写缓冲满，先不处理（下一帧/心跳会感知断开）。保持连接，不主动 end。
        }
      } catch {
        // 连接已坏：清理本条，避免后续 forEach 抛错中断群发。
        clearInterval(list[i].ping);
        list.splice(i, 1);
      }
    }
    if (list.length === 0) delete this.clients[userId];
  }

  /** 全设备登出/改密/强制下线：推 FORCE_LOGOUT 后立即断开该用户所有 SSE 连接。 */
  @OnEvent('auth.sessions-invalidated')
  onSessionsInvalidated(payload: { userId: number; reason: string }) {
    const list = this.clients[payload.userId];
    if (!list) return;
    const frame =
      `event: FORCE_LOGOUT\n` +
      `data: ${JSON.stringify({ event: 'FORCE_LOGOUT', status: 0, message: payload.reason })}\n\n`;
    list.forEach(({ res, ping }) => {
      clearInterval(ping);
      try {
        res.write(frame);
        res.end();
      } catch {}
    });
    delete this.clients[payload.userId];
  }

  /** 进程退出/热更：清所有心跳定时器，避免句柄泄漏告警。 */
  onModuleDestroy() {
    for (const uid of Object.keys(this.clients)) {
      const id = Number(uid);
      this.clients[id].forEach(({ ping }) => clearInterval(ping));
      delete this.clients[id];
    }
  }
}
