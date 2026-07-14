// Unit tests for MessageService.attachMediaStatus — the bulk ready/failed判定 that backs the
// query-messages mediaStatus field + the scroll-probe media-status endpoint. Prisma is mocked.
import { describe, it, expect, vi } from 'vitest';
import { MessageService } from './message.service.js';
import type { Message, ContentType } from '../prisma/generated/client.js';

/** Minimal Message row (only the fields attachMediaStatus reads: id, seq, content, contentType). */
function mk(p: Partial<Message> & { id: bigint; seq: number; content: string }): Message {
  return {
    threadId: 1,
    creator: 1,
    contentType: 'IMAGE' as ContentType,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDeleted: false,
    ...p,
  } as Message;
}

const DIG = 'a'.repeat(64); // 64 lowercase hex (sha256) — matches extractDigests' CAS regex
const D2 = 'b'.repeat(64);
const url = (d: string): string => `/uploads/shards/${d.slice(0, 2)}/${d.slice(2, 4)}/${d}.jpg`;

describe('MessageService.attachMediaStatus', () => {
  it('returns [] for empty input', async () => {
    const prisma = { mediaMessage: { findMany: vi.fn() }, mediaAsset: { findMany: vi.fn() } };
    const svc = new MessageService(prisma as never);
    expect(await svc.attachMediaStatus([])).toEqual([]);
    expect(prisma.mediaMessage.findMany).not.toHaveBeenCalled();
  });

  it('a non-media message (no digest) is ready', async () => {
    const prisma = {
      mediaMessage: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: { findMany: vi.fn() },
    };
    const svc = new MessageService(prisma as never);
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, contentType: 'PURE_TEXT', content: 'hello' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].mediaStatus).toBe('ready');
    expect(out[0].sv).toBe(5);
    expect('id' in out[0]).toBe(false); // id is stripped (throughput side-channel)
  });

  it('every digest has an authz row + asset refs>0 → ready', async () => {
    const prisma = {
      mediaMessage: { findMany: vi.fn().mockResolvedValue([{ messageId: 1n, digest: DIG }]) },
      mediaAsset: { findMany: vi.fn().mockResolvedValue([{ digest: DIG, refs: 1 }]) },
    };
    const svc = new MessageService(prisma as never);
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }),
    ]);
    expect(out[0].mediaStatus).toBe('ready');
  });

  it('a digest with no authz row → failed', async () => {
    const prisma = {
      mediaMessage: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const svc = new MessageService(prisma as never);
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }),
    ]);
    expect(out[0].mediaStatus).toBe('failed');
  });

  it('a digest whose asset has refs=0 → failed (bytes gone / GC)', async () => {
    const prisma = {
      mediaMessage: { findMany: vi.fn().mockResolvedValue([{ messageId: 1n, digest: DIG }]) },
      mediaAsset: { findMany: vi.fn().mockResolvedValue([{ digest: DIG, refs: 0 }]) },
    };
    const svc = new MessageService(prisma as never);
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }),
    ]);
    expect(out[0].mediaStatus).toBe('failed');
  });

  it('a batch is served by ONE mediaMessage + ONE mediaAsset query (no per-row N+1)', async () => {
    const prisma = {
      mediaMessage: { findMany: vi.fn().mockResolvedValue([{ messageId: 1n, digest: DIG }]) },
      mediaAsset: { findMany: vi.fn().mockResolvedValue([{ digest: DIG, refs: 1 }]) },
    };
    const svc = new MessageService(prisma as never);
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }), // ready
      mk({ id: 2n, seq: 6, content: JSON.stringify({ url: url(D2) }) }), // failed (D2 absent)
    ]);
    expect(out[0].mediaStatus).toBe('ready');
    expect(out[1].mediaStatus).toBe('failed');
    expect(prisma.mediaMessage.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledTimes(1);
  });
});
