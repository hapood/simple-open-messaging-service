import { useEffect, useState } from 'react';
import { API_BASE } from '@/lib/constants';
import { forceLogout } from '@/auth/force-logout';
import type { DownloaderSnapshot } from '@/api/media';
import { consumeSse } from '../../../shared/sse-client';

type State = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Full snapshots replace stale state. Every page owns one abortable connection and retry timer. */
export function useDownloaderStream(page: number, take: number) {
  const [snapshot, setSnapshot] = useState<DownloaderSnapshot>();
  const [state, setState] = useState<State>('connecting');
  useEffect(() => {
    const lifetime = new AbortController();
    let attempt = 0;
    setSnapshot(undefined);
    const run = async () => {
      setState('connecting');
      while (!lifetime.signal.aborted) {
        try {
          await consumeSse(
            `${API_BASE}/admin/media/downloader/stream?skip=${page * take}&take=${take}`,
            {
              signal: lifetime.signal,
              onResponse: (response) => {
                if (response.status === 401 || response.status === 403) {
                  lifetime.abort();
                  setState('closed');
                  setSnapshot(undefined);
                  if (response.status === 401) forceLogout();
                }
              },
              onFrame: ({ event, data }) => {
                if (lifetime.signal.aborted) return;
                if (event === 'access-revoked') {
                  lifetime.abort();
                  setState('closed');
                  setSnapshot(undefined);
                  return;
                }
                if (event !== 'snapshot' || !data) return;
                try {
                  const next = JSON.parse(data) as DownloaderSnapshot;
                  setSnapshot(next);
                  setState('open');
                  attempt = 0;
                } catch {
                  /* A malformed frame must not replace a valid snapshot. */
                }
              },
            },
          );
        } catch {
          /* A closed or failed transport uses the same bounded retry policy. */
        }
        if (lifetime.signal.aborted) return;
        setState('reconnecting');
        const delay = Math.min(1000 * 2 ** Math.min(attempt++, 5), 30_000);
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            lifetime.signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, delay);
          lifetime.signal.addEventListener('abort', finish, { once: true });
        });
      }
    };
    void run();
    return () => lifetime.abort();
  }, [page, take]);
  return { snapshot, state };
}
