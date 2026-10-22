import { effect, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../message-cards/chat-item';
import { MediaTransferService } from '../../services/media-transfer.service';
import type { TranslocoService } from '@jsverse/transloco';
import type { ToastService } from '../../services/toast.service';
import { NativeVoiceUploadController } from './native-voice-upload.controller';
import type { NativeVoiceUploadEvent } from '../../services/native-composer.service';

afterEach(() => vi.unstubAllGlobals());

it('retains a failed native voice for retry using the same client message id', async () => {
  const item = {
    id: -1,
    clientMessageId: 'voice-cid',
    data: { type: 'msg' },
  } as CbItem<ChatItemData>;
  const retain = vi.fn();
  const fail = vi.fn(async () => undefined);
  const start = vi.fn();
  const controller = new NativeVoiceUploadController(
    {
      start,
      fail: vi.fn(),
      registerCancel: vi.fn(),
      progress: vi.fn(),
    } as unknown as MediaTransferService,
    { translate: () => 'upload failed' } as unknown as TranslocoService,
    { warn: vi.fn() } as unknown as ToastService,
    { makeItem: () => item, dispatch: vi.fn(), accept: vi.fn(), fail, retain },
  );
  controller.handle({
    phase: 'started',
    clientMessageId: 'voice-cid',
    contextId: 1,
    threadId: 4,
    durationMs: 1000,
    size: 512,
  });
  controller.handle({
    phase: 'failed',
    clientMessageId: 'voice-cid',
    contextId: 1,
    threadId: 4,
    durationMs: 1000,
    size: 512,
    error: 'network',
  });
  expect(retain).toHaveBeenCalledWith('voice-cid', 4, 512);
  controller.forget('voice-cid'); // simulate a thread remount before retry
  vi.stubGlobal('__TAURI__', { core: { invoke: vi.fn(async () => undefined) } });
  controller.retry('voice-cid', item, 4, 512);
  expect(start).toHaveBeenLastCalledWith(
    expect.objectContaining({
      clientMessageId: 'voice-cid',
      threadId: 4,
      size: 512,
    }),
  );
  expect(controller.owns('voice-cid')).toBe(true);
  controller.forget('voice-cid');
  expect(controller.owns('voice-cid')).toBe(false);
});

it('handles a failed upload once when dispatched from an Angular effect', () => {
  TestBed.configureTestingModule({});
  const transfers = new MediaTransferService();
  const order: string[] = [];
  const warn = vi.fn(() => order.push('warn'));
  const fail = vi.fn(async () => {
    order.push('fail');
  });
  const item = { id: -1, clientMessageId: 'voice-cid', data: { type: 'msg' } } as CbItem<ChatItemData>;
  const controller = new NativeVoiceUploadController(
    transfers,
    { translate: () => 'upload failed' } as unknown as TranslocoService,
    { warn } as unknown as ToastService,
    { makeItem: () => item, dispatch: vi.fn(), accept: vi.fn(), fail, retain: vi.fn() },
  );
  const event = signal<NativeVoiceUploadEvent | null>(null);
  const threadId = signal(4);
  TestBed.runInInjectionContext(() =>
    effect(() => {
      const current = event();
      if (current && current.threadId === threadId()) controller.handle(current);
    }),
  );
  event.set({
    phase: 'started', clientMessageId: 'voice-cid', contextId: 1,
    threadId: 4, durationMs: 1000, size: 512,
  });
  TestBed.flushEffects();
  event.set({
    phase: 'failed', clientMessageId: 'voice-cid', contextId: 1,
    threadId: 4, durationMs: 1000, size: 512, error: 'network',
  });
  TestBed.flushEffects();
  TestBed.flushEffects();

  expect(transfers.tasks()).toEqual([expect.objectContaining({ status: 'failed' })]);
  expect(fail).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(order).toEqual(['fail', 'warn']);
});
