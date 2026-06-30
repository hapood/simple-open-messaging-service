import { Injectable } from '@angular/core';
import { Subject, Subscription, filter, take, finalize } from 'rxjs';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { AuthService } from './auth.service';
import { sseUrl } from './constants';

export interface StandardMessage<T = any> {
  event: string,
  status: number,
  message: string,
  data?: T
}

/** onopen 收到 401（access 过期）时抛出 → 外层循环走 renew 拿新 token 后立即重开（不计入退避）。 */
class AuthNeededError extends Error {
  constructor() {
    super('auth-needed')
    this.name = 'AuthNeededError'
  }
}

/**
 * 实时下行通道（SSE）。文件名保留 `websocket.service.ts` 以零改 9 处 import，内部已由 WS 改为
 * `@microsoft/fetch-event-source`（fetch + ReadableStream，支持 Bearer header + 完全可控重连）。
 *
 * 只推送：发消息/拉消息全走 HTTP，这里只收 NEW_MESSAGE / FORCE_LOGOUT 下行事件。
 *
 * 重连策略（外层 _run 循环统一控制，禁用库内置重连）：
 * - 网络/服务端错误 → 指数退避 + 全抖动 + 封顶 30s（抗惊群：服务重启时把所有客户端重连打散）；
 * - 401 access 过期 → renew-access 拿新 token 后立即重开（重置退避，不等待）；
 * - renew 失败(reuse/失效) → renew 内已 redoLoginAuth → 停止重连；
 * - 收 FORCE_LOGOUT / 主动 disconnect → 不再重连。
 *
 * 断线续传：SSE 流本身不回放历史（服务端不消费 Last-Event-ID）。重连成功后发 reconnect$ 信号，
 * 各线程的 http-item-source 据此用 newestMsgId 游标补拉断线期间漏掉的消息。
 */
@Injectable({
  providedIn: 'root',
})
export class WebsocketService {
  private readonly url = sseUrl
  /** 是否在 _run 重连循环中（含等待 token / 流开 / 退避睡眠）。connect 幂等靠它。 */
  private _running = false
  /** 主动断开（登出/强登）置位，使循环退出、onclose 不再重连。 */
  private _manualClose = false
  /** 退避计数（失败累加，成功连上/onopen 后归零）。 */
  private _attempt = 0
  /** 是否曾成功建过流——用于区分「首连」与「重连」（仅重连发 reconnect$）。 */
  private _openedOnce = false
  private _abort?: AbortController
  private _tokenSub?: Subscription

  readonly eventSubject = new Subject<StandardMessage>();
  /** 重连成功信号：http-item-source 订阅后用 newestMsgId 游标补拉断线期间漏掉的消息。 */
  readonly reconnect$ = new Subject<void>();

  constructor(private authService: AuthService) {
    this.connect()
  }

  public connect() {
    if (this._running) {
      return
    }
    this._running = true
    this._manualClose = false
    this._attempt = 0
    void this._run()
  }

  /** 登出/强登：中断流与等待，置 _manualClose 使循环不再重连，直到下次 connect()。 */
  public disconnect() {
    this._manualClose = true
    this._running = false
    this._tokenSub?.unsubscribe()
    this._tokenSub = undefined
    this._abort?.abort()
    this._abort = undefined
  }

  /** 重连主循环：每次 _openOnce 代表一次完整的建流尝试。 */
  private async _run() {
    while (!this._manualClose) {
      try {
        await this._openOnce()
        if (this._manualClose) break
        // 流被服务端正常关闭（如重启）→ 退避后重连
        this._attempt++
        await this._sleep(this._backoff())
      } catch (err) {
        if (this._manualClose) break
        if (err instanceof AuthNeededError) {
          // 401：renew 拿新 token，成功则立即重开（重置退避），失败则停（已 redoLoginAuth）
          const ok = await this._renewForReconnect()
          if (!ok || this._manualClose) break
          this._attempt = 0
          continue
        }
        // 网络/其它错误：退避重试
        this._attempt++
        await this._sleep(this._backoff())
      }
    }
    this._running = false
  }

  /** 发起一次 SSE 流。成功 onopen → 重置退避（重连则发 reconnect$）；401 → 抛 AuthNeededError；其它错误 → 抛出交外层退避。 */
  private async _openOnce() {
    const token = await this._waitForToken()
    if (token == null || this._manualClose) return

    this._abort = new AbortController()
    await fetchEventSource(this.url, {
      signal: this._abort.signal,
      headers: { Authorization: `Bearer ${token}` },
      // 后台标签也保持接收（聊天推送不应在切后台时暂停）
      openWhenHidden: true,
      onopen: async (res) => {
        if (res.status === 401) {
          throw new AuthNeededError()
        }
        if (!res.ok) {
          throw new Error(`SSE open failed: ${res.status}`)
        }
        // 成功建流 → 退避归零；非首次建流即为重连 → 通知补拉
        this._attempt = 0
        if (this._openedOnce) this.reconnect$.next()
        this._openedOnce = true
      },
      onmessage: (ev) => {
        this._dispatch(ev.event, ev.data)
      },
      onerror: (err) => {
        // 抛出 → 禁用库内置自动重连，统一交外层 _run 处理（退避/鉴权）
        throw err
      },
    })
  }

  /** 按 event 字段分发；包成 StandardMessage 与原 WS 下游一致（http-item-source 零改）。 */
  private _dispatch(event: string, rawData: string | undefined) {
    const data = rawData ? JSON.parse(rawData) : undefined
    if (event === 'FORCE_LOGOUT') {
      // 服务端主动踢（全设备登出/改密）→ 清 token 重登，不再重连
      this.disconnect()
      this.authService.redoLoginAuth()
      return
    }
    this.eventSubject.next({ event, status: 0, message: 'new message', data })
  }

  /** 等待有效 access token：有即用；无则等 acTkSub 推非空（login/renew 后）。disconnect 时 resolve(null)。 */
  private _waitForToken(): Promise<string | null> {
    const cur = this.authService.accessToken
    if (cur) return Promise.resolve(cur)
    return new Promise<string | null>((resolve) => {
      let resolved = false
      const done = (v: string | null) => {
        if (!resolved) { resolved = true; resolve(v) }
      }
      this._tokenSub = this.authService.acTkSub.pipe(
        filter((t): t is string => t !== null),
        take(1),
        // 拿到 token（take 完成）或被 disconnect 取消订阅 → 都 resolve
        finalize(() => done(null)),
      ).subscribe((t) => done(t))
    })
  }

  /** 401 后单飞 renew；成功(返回 true) 外层立即重开，失败(返回 false) 外层停止（已 redoLoginAuth）。 */
  private _renewForReconnect(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let resolved = false
      this.authService.renewAccessToken().subscribe({
        next: (res) => { if (!resolved) { resolved = true; resolve(res.code === 0) } },
        error: () => { if (!resolved) { resolved = true; resolve(false) } },
      })
    })
  }

  /** 指数退避 + 全抖动（full jitter）：delay = random(0, min(1000·2^attempt, 30000))。base 1s，封顶 30s。 */
  private _backoff(): number {
    const ceil = Math.min(1000 * 2 ** this._attempt, 30000)
    return Math.random() * ceil
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
