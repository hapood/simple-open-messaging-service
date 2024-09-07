import * as WebSocket from 'ws';
import { WebSocketAdapter, INestApplicationContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MessageMappingProperties } from '@nestjs/websockets';
import { Observable, fromEvent, EMPTY, mergeMap, filter } from 'rxjs';

class AuthWsAdapter
  implements WebSocketAdapter {
  constructor(private app: INestApplicationContext,
    private jwtService: JwtService) { }

  public create(port: number, options: any = {}) {
    return new WebSocket.Server({
      port, ...options,
      verifyClient: ({ req }) => {
        const token = req.headers['sec-websocket-protocol']
        return token !== undefined && this.jwtService.verify(token as string)
      }
    });
  }

  public bindClientConnect(
    server: WebSocket.Server,
    callback: (client: Client) => void
  ) {
    server.on("connection", (socket, req) => {
      // Coercion to nonnull and Claims is possible because we provide
      // `verifyClient` to WebSocket.Server.
      const token = req.headers['sec-websocket-protocol']
      const claims = this.jwtService.decode(token);
      const client = new Client(socket, claims);
      callback(client);
    });
  }

  // Explicit `this` preservation due to https://github.com/kamilmysliwiec/nest/issues/150
  public bindClientDisconnect = (
    client: Client,
    callback: (client: Client) => void
  ) => {
    client.ws.on("close", () => {
      callback(client);
    });
  };

  public bindMessageHandlers(
    client: Client,
    handlers: MessageMappingProperties[],
    process: (data: any) => Observable<any>,
  ) {

    fromEvent(client.ws, 'message')
      .pipe(
        mergeMap(data => this.bindMessageHandler(data, handlers, process)),
        filter(result => result != null),
      )
      .subscribe(response => client.send(response));
  }

  bindMessageHandler(
    buffer,
    handlers: MessageMappingProperties[],
    process: (data: any) => Observable<any>,
  ): Observable<any> {
    const message = JSON.parse(buffer.data);
    const messageHandler = handlers.find(
      handler => handler.message === message.event,
    );
    if (!messageHandler) {
      return EMPTY;
    }
    return process(messageHandler.callback(message.data));
  }

  close(server) {
    server.close();
  }
}
/**
 * A wrapper to associate claims (from the URL) with a WebSocket. This allows us
 * to know who is connected to each socket.
 */
class Client {
  constructor(public readonly ws: WebSocket, public readonly claims: any) { }

  public send(message: Object) {
    this.ws.send(JSON.stringify(message));
  }
}
