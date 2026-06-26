import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsResponse,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { from, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Server } from 'ws';

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

@WebSocketGateway()
export class EventGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
  @WebSocketServer()
  server: Server;
  wsClientDict: Record<number, Client[]> = {};

  constructor(private jwtService: JwtService) {}

  afterInit() {}

  handleConnection(client: WebSocket) {
    // verify 默认校验过期：过期抛 TokenExpiredError，签名/格式错抛其它。
    // A2：原实现把过期判断写在 verify 之后的 else 分支，永远走不到（过期已抛异常进 catch 被报成 invalid）。
    // 现按异常类型区分：过期→AUTH 1（前端 renewAccessToken 后重连），无效→AUTH 2。
    let payload: { sub: number; exp: number };
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
    let list = this.wsClientDict[payload.sub];
    if (list === undefined) {
      list = this.wsClientDict[payload.sub] = [];
    }
    list.push(new Client(client, { userId: payload.sub }));
  }

  handleDisconnect(client: WebSocket) {
    try {
      const payload = this.jwtService.verify(client.protocol);
      const { sub } = payload;
      const list = this.wsClientDict[sub];
      if (list !== undefined) {
        this.wsClientDict[sub] = list.filter((item) => item.ws !== client);
      }
    } catch (e) {}
  }

  onNewMessage(userId: number, data: { threadId: number; msgId: string }) {
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

  // @SubscribeMessage('events')
  // onEvent(client: any, data: any): Observable<WsResponse<number>> {
  //   console.log(data)
  //   return from([1, 2, 3]).pipe(map(item => ({ event: 'events', data: item })));
  // }
}
