import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import type { MessageEvent } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminRole } from '../database/enums.js';
import { ADMIN_ROLES_KEY } from './admin-roles.decorator.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { ADMIN_AUDIT_KEY } from './audit.decorator.js';
import { MediaFilesDto, MediaPageDto } from './media-admin.dto.js';
import { MediaTransferAdminController } from './media-transfer-admin.controller.js';

afterEach(() => vi.useRealTimers());

describe('media administration boundaries', () => {
  it('restricts every metadata and streaming endpoint to authenticated super administrators', () => {
    expect(
      Reflect.getMetadata(ADMIN_ROLES_KEY, MediaTransferAdminController),
    ).toEqual([AdminRole.SUPER_ADMIN]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, MediaTransferAdminController),
    ).toEqual([AdminAuthGuard, AdminRolesGuard]);
  });

  it('audits every destructive operation but not inventory or streaming reads', () => {
    for (const method of [
      'stopUpload',
      'stopDownload',
      'retryDownload',
      'cleanDownload',
      'reclaim',
      'cleanTemporary',
      'stopPhysicalDownload',
    ] as const) {
      expect(
        Reflect.getMetadata(
          ADMIN_AUDIT_KEY,
          MediaTransferAdminController.prototype[method],
        ),
      ).toBeTruthy();
    }
    for (const method of [
      'files',
      'temporary',
      'activeUploads',
      'downloadsInbox',
      'stream',
    ] as const) {
      expect(
        Reflect.getMetadata(
          ADMIN_AUDIT_KEY,
          MediaTransferAdminController.prototype[method],
        ),
      ).toBeUndefined();
    }
    expect(
      Reflect.getMetadata(
        ADMIN_AUDIT_KEY,
        MediaTransferAdminController.prototype.reclaim,
      ).options,
    ).toEqual({ targetType: 'media-asset', targetBody: 'digest' });
  });

  it('bounds pages and accepts only digest prefixes, not file names or arbitrary searches', async () => {
    expect(
      await validate(
        plainToInstance(MediaPageDto, { skip: '25', take: '25', userId: '7' }),
      ),
    ).toEqual([]);
    for (const input of [
      { take: 0 },
      { take: 101 },
      { skip: -1 },
      { userId: 0 },
    ]) {
      expect(
        await validate(plainToInstance(MediaPageDto, input)),
      ).not.toHaveLength(0);
    }
    expect(
      await validate(plainToInstance(MediaFilesDto, { digest: 'abc123' })),
    ).toEqual([]);
    expect(
      await validate(
        plainToInstance(MediaFilesDto, { digest: 'private-file.pdf' }),
      ),
    ).not.toHaveLength(0);
  });

  it('revalidates live stream access and releases all subscriptions on revocation', async () => {
    vi.useFakeTimers();
    const source = new Subject<unknown>();
    const auth = { validateAdminSession: vi.fn().mockResolvedValue(null) };
    const catalog = { annotateRuntime: vi.fn().mockResolvedValue([]) };
    const scheduler = { observe: vi.fn().mockReturnValue(source) };
    const subject = new MediaTransferAdminController(
      {} as never,
      {} as never,
      catalog as never,
      {} as never,
      scheduler as never,
      auth as never,
    );
    const events: MessageEvent[] = [];
    const subscription = subject
      .stream(new MediaPageDto(), {
        cookies: { admin_session: 'opaque-session' },
        ip: '127.0.0.1',
      } as never)
      .subscribe((event) => events.push(event));
    source.next({ instanceId: 'instance', list: [], total: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(events.some((event) => event.type === 'snapshot')).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(auth.validateAdminSession).toHaveBeenCalledWith(
      'opaque-session',
      '127.0.0.1',
    );
    expect(events.at(-1)?.type).toBe('access-revoked');
    expect(subscription.closed).toBe(true);
    expect(source.observed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
