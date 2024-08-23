import { SubscribeMessage, WebSocketGateway, MessageBody, ConnectedSocket, WsResponse } from '@nestjs/websockets';
import { Socket, Server } from "socket.io";

@WebSocketGateway(null, { cors: '*' })
export class EventGateway {
  @SubscribeMessage('newMessage')
  handleMessage(@MessageBody() body: any, @ConnectedSocket() client: Socket): WsResponse<unknown> {
    console.log(body)
    return {
      event: '1233', data: { a: 1 }
    }
  }
  private clients: Set<Socket> = new Set();

  afterInit(server: Server) {
    console.log('WebSocket Gateway initialized');
  }

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
    this.clients.add(client);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
    this.clients.delete(client);
  }

}