import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '@/lib/constants';
import { forceLogout } from '@/auth/force-logout';
import { consumeSse } from '../../../shared/sse-client';

export type LogStreamState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** One structured log record received from the backend. */
export interface LogRecord {
  level: string;
  time: string | number;
  msg: string;
  context?: string;
  req?: {
    id?: string;
    method?: string;
    url?: string;
    remoteAddress?: string;
    userId?: number;
    adminId?: number;
  };
  res?: { statusCode?: number | null };
  responseTime?: number;
  [key: string]: unknown;
}

const MAX_LINES = 1000;

/** Log projection and reconnect policy. The shared SSE reader owns transport
 * liveness and disposes every attempt before another connection can start. */
export function useLogStream(filters?: {
  scope?: string;
  taskId?: string;
  enabled?: boolean;
}) {
  const [lines, setLines] = useState<LogRecord[]>([]);
  const [state, setState] = useState<LogStreamState>('connecting');

  useEffect(() => {
    if (filters?.enabled === false) {
      setLines([]);
      setState('closed');
      return;
    }
    const lifetime = new AbortController();
    let attempt = 0;
    setLines([]);

    const run = async (): Promise<void> => {
      setState('connecting');
      while (!lifetime.signal.aborted) {
        try {
          const params = new URLSearchParams();
          if (filters?.scope) params.set('scope', filters.scope);
          if (filters?.taskId) params.set('taskId', filters.taskId);
          const url = `${API_BASE}/admin/logs/stream${params.size ? `?${params}` : ''}`;
          await consumeSse(url, {
            signal: lifetime.signal,
            onResponse: (response) => {
              if (response.status === 401) {
                lifetime.abort();
                setState('closed');
                forceLogout();
              }
            },
            onOpen: () => {
              attempt = 0;
              setState('open');
              // Each connection replays a snapshot rather than resuming a cursor.
              setLines([]);
            },
            onFrame: ({ event, data }) => {
              if (event !== 'log' || !data) return;
              try {
                const rec = JSON.parse(data) as LogRecord;
                setLines((prev) => [...prev.slice(-(MAX_LINES - 1)), rec]);
              } catch {
                // Ignore malformed log records without terminating the transport.
              }
            },
          });
        } catch {
          // A transport failure follows the same backoff path as a clean close.
        }
        if (lifetime.signal.aborted) return;
        setState('reconnecting');
        attempt++;
        const ms = Math.random() * Math.min(1000 * 2 ** attempt, 30_000);
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            lifetime.signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, ms);
          lifetime.signal.addEventListener('abort', finish, { once: true });
        });
      }
    };

    void run();
    return () => lifetime.abort();
  }, [filters?.scope, filters?.taskId, filters?.enabled]);

  const clear = useCallback(() => setLines([]), []);
  return { lines, state, clear };
}
