import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// Mock sharp: the render path becomes a fixed PNG, so the spec pins the cache + layout logic without
// depending on librsvg being present in the test environment.
const toBuffer = vi.fn(async () => Buffer.from('fake-png'));
vi.mock('sharp', () => ({
  default: vi.fn(() => ({ png: () => ({ toBuffer }) })),
}));

// Import AFTER vi.mock so the service picks up the mock.
const sharp = (await import('sharp')).default;
const { AvatarStackService } = await import('./avatar-stack.service.js');

describe('AvatarStackService', () => {
  let uploadDir: string;
  let svc: InstanceType<typeof AvatarStackService>;

  beforeEach(() => {
    uploadDir = mkdtempSync(join(tmpdir(), 'soms-icons-'));
    svc = new AvatarStackService({ uploadDir } as never);
    vi.mocked(sharp).mockClear();
    toBuffer.mockClear();
  });

  afterEach(() => {
    rmSync(uploadDir, { recursive: true, force: true });
  });

  it('returns null for empty input (nothing to draw)', async () => {
    expect(await svc.composeStackedAvatar([])).toBeNull();
    expect(sharp).not.toHaveBeenCalled();
  });

  it('composites senders with no avatar (initial-circle path) → returns a /uploads/notif-icons URL', async () => {
    const url = await svc.composeStackedAvatar([
      { avatarUrl: '', displayName: 'Alice', userId: 1 },
      { avatarUrl: '', displayName: 'Bob', userId: 2 },
    ]);
    expect(url).toMatch(/^\/uploads\/notif-icons\/[0-9a-f]+\.png$/);
    expect(url && existsSync(join(uploadDir, url!.slice('/uploads/'.length)))).toBe(true);
    expect(sharp).toHaveBeenCalledTimes(1); // rendered once
  });

  it('cache key is order-independent — reordered inputs hit the cache (rendered once total)', async () => {
    const a = [{ avatarUrl: '', displayName: 'Alice', userId: 1 }, { avatarUrl: '', displayName: 'Bob', userId: 2 }];
    const b = [...a].reverse();
    const url1 = await svc.composeStackedAvatar(a);
    const url2 = await svc.composeStackedAvatar(b);
    expect(url1).toBe(url2); // same sorted key
    expect(sharp).toHaveBeenCalledTimes(1); // second call was a cache hit
  });

  it('a different avatarUrl produces a different cache key (auto-invalidation on avatar change)', async () => {
    const url1 = await svc.composeStackedAvatar([{ avatarUrl: '', displayName: 'A', userId: 1 }]);
    const url2 = await svc.composeStackedAvatar([
      { avatarUrl: '/uploads/avatars/x-512.webp', displayName: 'A', userId: 1 },
    ]);
    expect(url1).not.toBe(url2);
    // The avatar file does not exist on disk → the tile degrades to the initial-circle (no throw).
    expect(url2).toMatch(/^\/uploads\/notif-icons\/[0-9a-f]+\.png$/);
  });

  it('caps at MAX_TILES — 6 senders still render exactly once (the body carries the rest)', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      avatarUrl: '',
      displayName: `U${i}`,
      userId: 100 + i,
    }));
    const url = await svc.composeStackedAvatar(six);
    expect(url).toMatch(/^\/uploads\/notif-icons\/[0-9a-f]+\.png$/);
    expect(sharp).toHaveBeenCalledTimes(1);
  });
});
