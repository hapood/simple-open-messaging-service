import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { IS_PUBLIC } from '../common/public.decorator.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationController } from './notification.controller.js';

describe('notification subscription surface', () => {
  it('exposes only the public VAPID configuration route', () => {
    const prototype = NotificationController.prototype;
    expect(
      Object.getOwnPropertyNames(prototype).filter(
        (key) => key !== 'constructor',
      ),
    ).toEqual(['vapidKey']);
    expect(Reflect.getMetadata(PATH_METADATA, prototype.vapidKey)).toBe(
      'notifications/vapid-key',
    );
    expect(Reflect.getMetadata(IS_PUBLIC, prototype.vapidKey)).toBe(true);
  });

  it('returns the configured public key and an empty key when disabled', () => {
    const settings = { getVapid: () => ({ publicKey: 'public-key' }) };
    const controller = new NotificationController(settings as SettingsService);
    expect(controller.vapidKey()).toEqual({ publicKey: 'public-key' });
    const disabled = new NotificationController({
      getVapid: () => undefined,
    } as unknown as SettingsService);
    expect(disabled.vapidKey()).toEqual({ publicKey: '' });
  });
});
