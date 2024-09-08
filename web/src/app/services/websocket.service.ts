import { Injectable } from '@angular/core';
import { Subject, take, switchMap, filter } from 'rxjs';
import { AuthService } from './auth.service';

@Injectable({
  providedIn: 'root'
})
export class WebsocketService {
  private readonly url = 'ws://127.0.0.1:3000'
  private _ws: WebSocket | null = null
  private _isConning = false
  readonly eventSubject = new Subject<MessageEvent>();

  constructor(private authService: AuthService) {
    this.connect()
  }

  public connect() {
    if (this._isConning === true) {
      return
    }
    return this.authService.acTkSub.pipe(filter(token => token !== undefined),
      take(1)
    ).subscribe({
      next: (token => {
        let ws = new WebSocket(this.url, [token]);
        ws.onerror = (error) => {
          this._ws = null
          console.error(error)
          console.error("ws connect error, try reconnceting")
          this.reconnect(1000)
        }
        ws.onclose = () => {
          this._ws = null
          console.error("ws connect closed by server, try reconnceting")
          this.reconnect(1000)
        }
        ws.onmessage = (message) => {
          console.log(message);
          this.eventSubject.next(message)
        }
        ws.onopen = () => {
          this._ws = ws
          console.log("successfuly connected: " + this.url);
        }
      }
      ), complete: () => {
        this._isConning = false
      }
    })

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
