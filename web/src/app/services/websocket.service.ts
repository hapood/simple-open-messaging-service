import { Injectable } from '@angular/core';
import { Subject, take, switchMap, filter } from 'rxjs';
import { AuthService } from './auth.service';

export interface StandardMessage<T = any> {
  event: string,
  status: number,
  message: string,
  data?: T
}
@Injectable({
  providedIn: 'root'
})
export class WebsocketService {
  private readonly url = 'ws://127.0.0.1:3000'
  private _ws: WebSocket | null = null
  private _isConning = false
  readonly eventSubject = new Subject<StandardMessage>();

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
      next: (({ nextToken }) => {
        let ws = new WebSocket(this.url, [nextToken]);
        ws.onerror = (error) => {
          this._ws = null
          console.error(error)
        }
        ws.onclose = () => {
          this._ws = null
          console.error("ws connect closed, try reconnceting")
          this._isConning = false
          this.reconnect(10000)
        }
        ws.onmessage = (message) => {
          const obj = JSON.parse(message.data)
          if (obj.event === 'AUTH') {
            if (obj.status === 1) {
              this.authService.renewAccessToken()
            } else {
              console.error(obj)
            }
          } else {
            this.eventSubject.next(obj)
          }
        }
        ws.onopen = () => {
          this._ws = ws
          console.info("ws successfully connected: " + this.url);
        }
      }
      )
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
