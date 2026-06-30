import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Server } from 'ws';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma.service';

class Client {
  constructor(
    public readonly ws: WebSocket,
    public readonly userInfo: { userId: number },
  ) {}

  public send(message: object) {
    // 连接未就绪/已关闭时跳过，避免 send 抛错中断群发 forEach（B2：错误隔离）
    if (this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      // 单连接发送失败不波及其它连接的推送
    }
  }
}

type WsPayload = { sub: number; jti?: string; tver?: number; exp?: number };

@WebSocketGateway()
export class EventGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
  @WebSocketServer()
  server: Server;
  wsClientDict: Record<number, Client[]> = {};

  constructor(
    private jwtService: JwtService,
    private redis: RedisService,
    private prisma: PrismaService,
  ) {}

  afterInit() {}

  handleConnection(client: WebSocket) {
    // verify：过期抛 TokenExpiredError，签名/格式错抛其它。
    // 过期→AUTH 1（前端 renew 后重连），无效→AUTH 2，撤销→AUTH 3（强制重登）。
    let payload: WsPayload;
    try {
      payload = this.jwtService.verify(client.protocol);
    } catch (e) {
      const expired = (e as Error)?.name === 'TokenExpiredError';
      client.send(
        JSON.stringify({
          event: 'AUTH',
          status: expired ? 1 : 2,
          message: expired ? 'token expired' : 'not valid token',
        }),
      );
      client.close();
      return;
    }
    // 撤销感知（与 JwtStrategy 同口径）：黑名单 + tokenVersion。期间连接未入 dict。
    this.assertRevoked(payload).then((revoked) => {
      if (revoked) {
        client.send(
          JSON.stringify({ event: 'AUTH', status: 3, message: 'session revoked' }),
        );
        client.close();
        return;
      }
      // 握手期（assertRevoked await 期间）client 可能已断开：不入 dict，避免残留无人清。
      if (client.readyState !== WebSocket.OPEN) return;
      let list = this.wsClientDict[payload.sub];
      if (list === undefined) {
        list = this.wsClientDict[payload.sub] = [];
      }
      list.push(new Client(client, { userId: payload.sub }));
    });
  }

  /** true=已撤销（jti 命中黑名单 或 tokenVersion 不匹配）。旧 token（无 jti/tver）放行。 */
  private async assertRevoked(payload: WsPayload): Promise<boolean> {
    if (!payload.jti || payload.tver === undefined) return false;
    if (this.redis.enabled) {
      const blocked = await this.redis
        .existsKey(`access:jti:${payload.jti}`)
        .catch(() => false);
      if (blocked) return true;
      const cached = await this.redis
        .get(`access:tver:${payload.sub}`)
        .catch(() => null);
      if (cached !== null) return Number(cached) !== payload.tver;
    }
    const u = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true },
    });
    return (u ? u.tokenVersion : -1) !== payload.tver;
  }

  handleDisconnect(client: WebSocket) {
    // 不依赖 verify：token 可能已过期/吊销（verify 抛错），但仍需清理 dict，否则 ws 引用残留=内存泄漏。
    // 按 ws 引用遍历定位所属 list，移除该连接；list 空则 delete，不留空数组壳。
    for (const uid of Object.keys(this.wsClientDict)) {
      const id = Number(uid);
      const filtered = this.wsClientDict[id].filter((item) => item.ws !== client);
      if (filtered.length === 0) {
        delete this.wsClientDict[id];
      } else {
        this.wsClientDict[id] = filtered;
      }
    }
  }

  onNewMessage(userId: number, data: unknown) {
    const list = this.wsClientDict[userId];
    list?.forEach((item) =>
      item.send({
        event: 'NEW_MESSAGE',
        status: 0,
        message: 'new message',
        data,
      }),
    );
  }

  /** 全设备登出/改密/强制下线：踢该用户所有在线 WS 连接，前端清 token 重登。 */
  @OnEvent('auth.sessions-invalidated')
  onSessionsInvalidated(payload: { userId: number; reason: string }) {
    const list = this.wsClientDict[payload.userId];
    if (!list) return;
    list.forEach((item) =>
      item.send({ event: 'FORCE_LOGOUT', status: 0, message: payload.reason }),
    );
    list.forEach((item) => {
      try {
        item.ws.close();
      } catch {}
    });
    delete this.wsClientDict[payload.userId];
  }
}
