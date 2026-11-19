import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { AdminRole } from '../database/enums.js';
import { ADMIN_ROLES_KEY } from './admin-roles.decorator.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { ADMIN_AUDIT_KEY } from './audit.decorator.js';
import {
  CleanTemporaryGarbageDto,
  TemporaryGarbageAdminController,
} from './temporary-garbage-admin.controller.js';
import { MediaTransferAdminController } from './media-transfer-admin.controller.js';

describe('garbage administration boundary', () => {
  it('requires authenticated super administrators and audits cleanup only', () => {
    expect(
      Reflect.getMetadata(ADMIN_ROLES_KEY, TemporaryGarbageAdminController),
    ).toEqual([AdminRole.SUPER_ADMIN]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, TemporaryGarbageAdminController),
    ).toEqual([AdminAuthGuard, AdminRolesGuard]);
    expect(
      Reflect.getMetadata(
        ADMIN_AUDIT_KEY,
        TemporaryGarbageAdminController.prototype.clean,
      ),
    ).toMatchObject({ action: 'media.temporary.clean' });
    expect(
      Reflect.getMetadata(
        ADMIN_AUDIT_KEY,
        TemporaryGarbageAdminController.prototype.scan,
      ),
    ).toBeUndefined();
  });
  it('accepts opaque UUID tokens and strict boolean recursive confirmation, never paths', async () => {
    expect(
      await validate(
        plainToInstance(CleanTemporaryGarbageDto, {
          token: '00000000-0000-4000-8000-000000000001',
          confirmDirectory: true,
        }),
      ),
    ).toEqual([]);
    for (const value of [
      { token: '../../etc/passwd' },
      {
        token: '00000000-0000-4000-8000-000000000001',
        confirmDirectory: 'true',
      },
    ])
      expect(
        await validate(plainToInstance(CleanTemporaryGarbageDto, value)),
      ).not.toHaveLength(0);
  });
  it('retires the old task-deletion-dependent temporary endpoints', async () => {
    const maintenance = { cleanTemporary: vi.fn(), temporary: vi.fn() };
    const controller = new MediaTransferAdminController(
      {} as never,
      {} as never,
      {} as never,
      maintenance as never,
      {} as never,
      {} as never,
    );
    await expect(
      controller.cleanTemporary({ digest: 'a'.repeat(64) }),
    ).rejects.toThrow('Garbage file cleanup');
    await expect(controller.temporary({ skip: 0, take: 20 })).rejects.toThrow(
      'Garbage file cleanup',
    );
    expect(maintenance.cleanTemporary).not.toHaveBeenCalled();
    expect(maintenance.temporary).not.toHaveBeenCalled();
  });
});
