import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsResponse, OnGatewayConnection, OnGatewayDisconnect,
  OnGatewayInit
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { from, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Server } from 'ws';

class Client {
  constructor(public readonly ws: WebSocket, public readonly userInfo: { userId: number }) { }

  public send(message: Object) {
    this.ws.send(JSON.stringify(message));
  }
}

@WebSocketGateway()
export class EventGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
  @WebSocketServer()
  server: Server;
  wsClientDict: Record<number, Client[]> = {};

  constructor(private jwtService: JwtService) { }

  afterInit() {
  }

  handleConnection(client: WebSocket) {
    try {
      const payload = this.jwtService.verify(client.protocol)
      let { sub, exp } = payload
      if (new Date().getTime() < exp * 1000) {
        let list = this.wsClientDict[sub]
        if (list === undefined) {
          list = this.wsClientDict[sub] = []
        }
        list.push(new Client(client, { userId: sub }))
      } else {
        client.send(JSON.stringify({ event: 'AUTH', status: 1, message: 'token expired' }))
        client.close()
      }
    } catch (e) {
      client.send(JSON.stringify({ event: 'AUTH', status: 2, message: 'not valid token' }))
      client.close()
    }
  }

  handleDisconnect(client: WebSocket) {
    try {
      const payload = this.jwtService.verify(client.protocol)
      const { sub } = payload
      const list = this.wsClientDict[sub]
      if (list !== undefined) {
        this.wsClientDict[sub] = list.filter(item => item.ws !== client)
      }
    } catch (e) {
    }
  }

  onNewMessage(userId: number, threadId: number) {
    const list = this.wsClientDict[userId]
    const data = {
      threadId,
    }
    list.forEach(item => item.send({ event: 'NEW_MESSAGE', status: 0, message: 'new message', data }))
  }

  // @SubscribeMessage('events')
  // onEvent(client: any, data: any): Observable<WsResponse<number>> {
  //   console.log(data)
  //   return from([1, 2, 3]).pipe(map(item => ({ event: 'events', data: item })));
  // }
}