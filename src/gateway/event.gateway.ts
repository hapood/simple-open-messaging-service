import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { Socket } from "socket.io";

@WebSocketGateway(null, { cors: '*' })
export class EventGateway {
  @SubscribeMessage('newMessage')
  handleMessage(@MessageBody() body: any, @ConnectedSocket() client: Socket) {
    console.log(body)
  }
}