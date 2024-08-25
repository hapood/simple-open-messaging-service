import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class WebsocketService {
  private readonly url = 'ws://127.0.0.1:3000'
  private _ws: WebSocket | null = null
  readonly eventSubject = new Subject<MessageEvent>();

  constructor() {
    this.connect()
  }

  public connect() {
    let ws = new WebSocket(this.url);
    ws.onerror = (error) => {
      this._ws = null
      console.error(error)
      console.error("ws connect error, try reconnceting")
      this.reconnect(60000)
    }
    ws.onclose = () => {
      this._ws = null
      console.error("ws connect closed by server, try reconnceting")
      this.reconnect(60000)
    }
    ws.onmessage = (message) => {
      console.log(message);
      this.eventSubject.next(message)
    }
    ws.onopen = () => {
      this._ws = ws
      console.log("Successfully connected: " + this.url);
    }
  }

  reconnect(delay: number) {
    setTimeout(() => {
      this.connect()
    }, delay)
  }

  send(data: Object) {
    const ws = this._ws
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data))
      return true
    }
    return false
  }
}
