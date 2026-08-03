import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { optionalIntEnv } from '../common/env.js';
import {
  LogStreamStore,
  atOrAbove,
  type LogRecord,
} from './log-stream-store.js';
import { listLogFiles } from './log-rotator.js';
import { initSseResponse, formatSseFrame } from '../common/sse-stream.js';
import type { AdminLogHistoryDto } from './log-viewer.dto.js';

interface LogClient {
  res: ServerResponse;
  ping: NodeJS.Timeout;
  minLevel?: string;
  scope?: string;
  taskId?: string;
}

export function matchesLogFilters(
  rec: LogRecord,
  filters: { scope?: string; taskId?: string },
): boolean {
  if (filters.scope && rec.scope !== filters.scope) return false;
  if (filters.taskId && rec.taskId !== filters.taskId) return false;
  return true;
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

  attach(
    res: ServerResponse,
    minLevel?: string,
    origin?: string,
    scope?: string,
    taskId?: string,
  ): void {
    const ping = initSseResponse(res, origin);

    // Replay the ring buffer first (newest-last → chronological render order in the viewer).
    for (const rec of this.store.snapshot(minLevel)) {
      if (!matchesLogFilters(rec, { scope, taskId })) continue;
      res.write(formatSseFrame('log', rec));
    }

    const client: LogClient = { res, ping, minLevel, scope, taskId };
    const unsub = this.store.subscribe((rec) => {
      if (minLevel && !atOrAbove(rec.level, minLevel)) return;
      if (!matchesLogFilters(rec, { scope, taskId })) return;
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

  /**
   * Historical log search: scan the current log file + archives (newest-first), filter by level /
   * time-range / substring, return one offset page. Each file is chronological (oldest→newest), so its
   * lines are walked end→start to yield newest-first across the whole window.
   *
   * The scan is bounded by LOG_HISTORY_SCAN_BYTES (default 64MB) so a wildcard search over the full
   * retention window can't OOM. `total` is therefore "matches within the scanned window", not an
   * absolute count — `truncated` signals the cap was hit (older matches exist beyond the window). The
   * read is async (fs/promises) but a single file parse is synchronous work on the event loop; this is
   * an admin-only, on-demand endpoint, never a hot path.
   */
  async history(dto: AdminLogHistoryDto): Promise<{
    list: LogRecord[];
    total: number;
    truncated: boolean;
  }> {
    const skip = dto.skip ?? 0;
    const take = Math.min(dto.take ?? 50, 200);
    const maxBytes = optionalIntEnv('LOG_HISTORY_SCAN_BYTES', 64 * 1024 * 1024);

    const matches: LogRecord[] = [];
    let bytesScanned = 0;
    let truncated = false;
    for (const file of listLogFiles()) {
      if (bytesScanned >= maxBytes) {
        truncated = true;
        break;
      }
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      bytesScanned += content.length;
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        let rec: LogRecord;
        try {
          rec = JSON.parse(line) as LogRecord;
        } catch {
          continue; // a partial/non-JSON line (e.g. a crash mid-write) — skip, don't fail the scan
        }
        if (this.matches(rec, dto)) matches.push(rec);
      }
    }

    return {
      list: matches.slice(skip, skip + take),
      total: matches.length,
      truncated,
    };
  }

  /** AND of the active filters: inclusive level, ms-epoch time range, case-insensitive substring. */
  private matches(rec: LogRecord, dto: AdminLogHistoryDto): boolean {
    if (dto.level && !atOrAbove(rec.level, dto.level)) return false;
    if (dto.scope && rec.scope !== dto.scope) return false;
    if (dto.taskId && rec.taskId !== dto.taskId) return false;
    if (dto.from !== undefined || dto.to !== undefined) {
      const t =
        typeof rec.time === 'number' ? rec.time : Date.parse(String(rec.time));
      if (Number.isNaN(t)) return false;
      if (dto.from !== undefined && t < dto.from) return false;
      if (dto.to !== undefined && t > dto.to) return false;
    }
    if (dto.search) {
      const haystack = `${rec.msg ?? ''} ${rec.context ?? ''}`.toLowerCase();
      if (!haystack.includes(dto.search.toLowerCase())) return false;
    }
    return true;
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
