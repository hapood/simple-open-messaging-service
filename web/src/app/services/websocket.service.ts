import { Injectable } from '@angular/core';
import { Subject, Subscription, take, filter } from 'rxjs';
import { AuthService } from './auth.service';
import { wsUrl } from './constants';
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
  private readonly url = wsUrl
  private _ws: WebSocket | null = null
  // 握手进行中（已订阅 acTkSub 等 token，socket 尚未 open）。
  // 防止 constructor / home.ngOnInit / onclose 重连重复建连。
  private _connecting = false
  // 登出主动断开时置位，使 onclose 不再自动重连，直到下次 connect()（重新登录）。
  private _manualClose = false
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private _connSub: Subscription | undefined
  readonly eventSubject = new Subject<StandardMessage>();

  constructor(private authService: AuthService) {
    this.connect()
  }

  public connect() {
    if (this._ws !== null || this._connecting) {
      return
    }
    this._manualClose = false
    this._connecting = true
    this._connSub = this.authService.acTkSub.pipe(filter(token => token !== undefined),
      take(1)
    ).subscribe({
      next: (({ nextToken }) => {
        this._connecting = false
        let ws = new WebSocket(this.url, [nextToken]);
        ws.onerror = (error) => {
          this._ws = null
          console.error(error)
        }
        ws.onclose = () => {
          this._ws = null
          // 登出主动关闭：不再自动重连，等下次登录 connect()
          if (this._manualClose) {
            return
          }
          console.error("ws connect closed, try reconnceting")
          this.reconnect(10000)
        }
        ws.onmessage = (message) => {
          const obj = JSON.parse(message.data)
          if (obj.event === 'AUTH') {
            if (obj.status === 1) {
              // access 过期 → 刷新后重连
              this.authService.renewAccessToken()
            } else if (obj.status === 3) {
              // session 已吊销（全设备登出/改密/撤销）→ 强制重登，不再重连
              this.disconnect()
              this.authService.redoLoginAuth()
            } else {
              console.error(obj)
            }
          } else if (obj.event === 'FORCE_LOGOUT') {
            // 服务端主动踢（全设备登出/改密）→ 清 token 重登
            this.disconnect()
            this.authService.redoLoginAuth()
          } else {
            this.eventSubject.next(obj)
          }
        }
        ws.onopen = () => {
          this._ws = ws
          console.info("ws successfully connected: " + this.url);
        }
      }),
      error: () => {
        this._connecting = false
      },
    })
  }

  reconnect(delay: number) {
    this._reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay)
  }

  // 登出时调用：立即断开 socket，取消待重连定时器，取消握手中的订阅，
  // 并阻止 onclose 自动重连，直到下次登录 connect()。
  disconnect() {
    this._manualClose = true
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = undefined
    }
    if (this._connSub !== undefined) {
      this._connSub.unsubscribe()
      this._connSub = undefined
    }
    if (this._ws !== null) {
      this._ws.close()
      this._ws = null
    }
    this._connecting = false
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
