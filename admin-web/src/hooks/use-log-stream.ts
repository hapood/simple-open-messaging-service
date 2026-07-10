import { useCallback, useEffect, useState } from 'react'
import { API_BASE } from '@/lib/constants'
import { getAccessToken } from '@/auth/token-store'
import { refreshOnce } from '@/auth/refresh-singleton'

export type LogStreamState = 'connecting' | 'open' | 'reconnecting' | 'closed'

/** One structured log record — the parsed pino JSON line the backend streams. `level` is a string
 *  label ('info'|'warn'|…), `time` an ISO string, plus the pino fields (context, req, res, …). */
export interface LogRecord {
  level: string
  time: string | number
  msg: string
  context?: string
  req?: {
    id?: string
    method?: string
    url?: string
    remoteAddress?: string
    userId?: number
    adminId?: number
  }
  res?: { statusCode?: number | null }
  responseTime?: number
  [key: string]: unknown
}

/** No frame within STALE_MS while open → the stream silently stalled (half-open TCP); abort + reconnect. ~2× the 25s heartbeat. */
const STALE_MS = 60_000
const WATCHDOG_CHECK_MS = 5_000
/** Browser-side cap on retained lines (the server ring buffer holds more; the disk holds everything). */
const MAX_LINES = 1000

/** Parse one SSE frame (the text between blank lines) into { event, data }. A leading `:` line is a
 *  comment (ignored); a frame with no `event:` field is dropped. Multiple `data:` lines join with `\n`
 *  per spec. Direct port of the consumer web/src/app/services/sse.worker.ts parser. */
function parseFrame(raw: string): { event: string; data?: string } | undefined {
  let event = ''
  let data = ''
  let hasData = false
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') {
      data = hasData ? `${data}\n${value}` : value
      hasData = true
    }
  }
  if (!event) return undefined
  return { event, data: hasData ? data : undefined }
}

/** Consume the SSE byte stream, invoking onFrame per complete frame. Resolves on a clean stream end;
 *  rejects on a read/abort error so the caller can back off + reconnect. */
async function readFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (event: string, data?: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = parseFrame(buffer.slice(0, idx))
      buffer = buffer.slice(idx + 2)
      if (frame) onFrame(frame.event, frame.data)
    }
  }
  decoder.decode()
}

/** Exponential backoff + full jitter: delay = random(0, min(1000·2^attempt, 30000)). Base 1s, cap 30s. */
function backoff(attempt: number): number {
  const ceil = Math.min(1000 * 2 ** attempt, 30000)
  return Math.random() * ceil
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Live log tail over SSE: GET /api/v1/admin/logs/stream[?level=]. Opened with fetch + ReadableStream
 * (NOT EventSource — the admin Bearer must ride in the Authorization header; EventSource can't set
 * one, and a `?token=` fallback would leak the token into our own access logs). Owns the reconnect
 * loop, single-flight token refresh on 401, exponential backoff, and a liveness watchdog.
 *
 * `level` filters server-side (the ring-buffer replay + the live fan-out); changing it reconnects and
 * clears the local view. The browser keeps only the newest MAX_LINES records — older records are on
 * disk (the Phase-3 history view).
 *
 * Auto-scroll / "stick to bottom" is NOT done here — react-virtuoso's followOutput owns it in the page.
 */
export function useLogStream(level: string | undefined) {
  const [lines, setLines] = useState<LogRecord[]>([])
  const [state, setState] = useState<LogStreamState>('connecting')

  useEffect(() => {
    let manualClose = false
    let aborter: AbortController | undefined
    let attempt = 0
    let lastFrameAt = 0
    let watchdog: ReturnType<typeof setInterval> | undefined

    const stopWatchdog = () => {
      if (watchdog) {
        clearInterval(watchdog)
        watchdog = undefined
      }
    }

    // A level change re-filters the server ring-buffer replay; clear the local view so levels don't mix.
    setLines([])

    const run = async (): Promise<void> => {
      setState('connecting')
      while (!manualClose) {
        try {
          let token = getAccessToken()
          if (!token) {
            const ok = await refreshOnce()
            if (!ok || manualClose) return
            token = getAccessToken()
            if (!token) return
          }

          aborter = new AbortController()
          const url = `${API_BASE}/admin/logs/stream${level ? `?level=${level}` : ''}`
          const res = await fetch(url, {
            signal: aborter.signal,
            headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
            cache: 'no-store',
          })

          if (res.status === 401) {
            // Token expired mid-session: single-flight refresh, then reopen at once (no backoff).
            const ok = await refreshOnce()
            if (!ok || manualClose) return
            attempt = 0
            continue
          }
          if (!res.ok || !res.body) throw new Error(`SSE open failed: ${res.status}`)

          attempt = 0
          setState('open')
          lastFrameAt = Date.now()
          stopWatchdog()
          watchdog = setInterval(() => {
            if (lastFrameAt && Date.now() - lastFrameAt > STALE_MS) aborter?.abort()
          }, WATCHDOG_CHECK_MS)

          await readFrames(res.body, (event, data) => {
            lastFrameAt = Date.now()
            if (event !== 'log' || !data) return
            try {
              const rec = JSON.parse(data) as LogRecord
              setLines((prev) => {
                const next =
                  prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev
                return [...next, rec]
              })
            } catch {
              /* skip a malformed line */
            }
          })

          if (manualClose) break
          setState('reconnecting')
          attempt++
          await sleep(backoff(attempt))
        } catch {
          if (manualClose) break
          // A persistently failing refresh already force-logged-out inside refreshOnce; back off + retry transport errors.
          setState('reconnecting')
          attempt++
          await sleep(backoff(attempt))
        }
      }
      setState('closed')
    }

    void run()
    return () => {
      manualClose = true
      aborter?.abort()
      stopWatchdog()
    }
  }, [level])

  const clear = useCallback(() => setLines([]), [])
  return { lines, state, clear }
}
