import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { LogStreamStore, atOrAbove } from './log-stream-store.js';
import { initSseResponse, formatSseFrame } from '../common/sse-stream.js';

interface LogClient {
  res: ServerResponse;
  ping: NodeJS.Timeout;
  minLevel?: string;
}

/**
 * Live log tail over SSE for the admin console. On connect: replay the ring buffer (filtered to records
 * at/above an optional level), then stream every new matching record. The connect-plumbing (headers +
 * 25s `ping` heartbeat + frame format) is the shared `common/sse-stream.ts` — the same wire format the
 * chat SseService and the consumer sse.worker.ts use.
 *
 * One flat subscriber set (NOT keyed by user): the viewer is admin-scoped, and fan-out is a plain Set.
 * It is a separate service from SseService (chat-keyed, event-emitter-driven) rather than overloading
 * it — the connect plumbing is shared, the subscriber model is not.
 */
@Injectable()
export class LogViewerService implements OnModuleDestroy {
  private readonly clients = new Set<LogClient>();

  constructor(@Inject(LogStreamStore) private readonly store: LogStreamStore) {}

  attach(res: ServerResponse, minLevel?: string): void {
    const ping = initSseResponse(res);

    // Replay the ring buffer first (newest-last → chronological render order in the viewer).
    for (const rec of this.store.snapshot(minLevel)) {
      res.write(formatSseFrame('log', rec));
    }

    const client: LogClient = { res, ping, minLevel };
    const unsub = this.store.subscribe((rec) => {
      if (minLevel && !atOrAbove(rec.level, minLevel)) return;
      try {
        res.write(formatSseFrame('log', rec));
      } catch {
        // Dropped connection: the close handler + heartbeat cleanup owns teardown.
      }
    });
    this.clients.add(client);

    res.on('close', () => {
      clearInterval(client.ping);
      unsub();
      this.clients.delete(client);
    });
  }

  /** Process exit / hot reload: clear heartbeats and close held connections to avoid handle leaks. */
  onModuleDestroy(): void {
    for (const c of this.clients) {
      clearInterval(c.ping);
      try {
        c.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
