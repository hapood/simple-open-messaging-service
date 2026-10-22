import { describe, expect, it, vi } from 'vitest';
import { NEVER, of, Subject, firstValueFrom } from 'rxjs';
import type { TranslocoService } from '@jsverse/transloco';
import type { MessageThreadAdapter } from './message-thread-adapter';
import type { MediaTransferService } from '../../services/media-transfer.service';
import type { NativeUploadService } from '../../services/native-upload.service';
import type { DebugToolsService } from '../../services/debug-tools.service';
import type { ToastService } from '../../services/toast.service';
import {
  ThreadAttachmentUploadController,
  WEB_UPLOAD_IDLE_TIMEOUT_MS,
  withUploadIdleTimeout,
  type ThreadAttachmentUploadHost,
} from './thread-attachment-upload.controller';

describe('ThreadAttachmentUploadController', () => {
  it('renews the web upload deadline on actual progress and unsubscribes on a stall', async () => {
    vi.useFakeTimers();
    try {
      const source = new Subject<number>();
      const progress = vi.fn();
      let report!: (loaded: number, total: number) => void;
      const pending = expect(
        firstValueFrom(
          withUploadIdleTimeout((callback) => {
            report = callback;
            return source;
          }, progress),
        ),
      ).rejects.toThrow('Upload stalled');
      await vi.advanceTimersByTimeAsync(WEB_UPLOAD_IDLE_TIMEOUT_MS - 1);
      report(10, 100);
      await vi.advanceTimersByTimeAsync(WEB_UPLOAD_IDLE_TIMEOUT_MS - 1);
      expect(source.observed).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(source.observed).toBe(false);
      expect(progress).toHaveBeenCalledWith(10, 100);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['stage', 'upload'] as const)(
    'fails a stalled voice %s and leaves the bubble retryable',
    async (phase) => {
      vi.useFakeTimers();
      try {
        const failPending = vi.fn(async () => undefined);
        const fail = vi.fn();
        const uploadPart = vi.fn(() => NEVER);
        const controller = new ThreadAttachmentUploadController(
          {
            stageMedia: () => (phase === 'stage' ? NEVER : of({ code: 0 })),
            uploadPart,
          } as unknown as MessageThreadAdapter,
          {
            isUploading: () => true,
            cancelled: () => NEVER,
            cancel: vi.fn(),
            fail,
          } as unknown as MediaTransferService,
          { translate: (key: string) => key } as TranslocoService,
          {} as NativeUploadService,
          { enabled: () => false } as DebugToolsService,
          {} as ToastService,
          {
            threadId: () => 9,
            failPending,
            markAccepted: vi.fn(),
            surfaceQuota: vi.fn(),
          },
        );
        const send = controller.uploadAudio(
          'voice-cid',
          'part',
          { size: 100 } as File,
          { id: -1, data: { type: 'msg' } } as never,
          false,
        );
        await vi.advanceTimersByTimeAsync(WEB_UPLOAD_IDLE_TIMEOUT_MS + 1);
        await send;
        expect(fail).toHaveBeenCalledOnce();
        expect(failPending).toHaveBeenCalledOnce();
        expect(uploadPart).toHaveBeenCalledTimes(phase === 'stage' ? 0 : 1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['uploadImage', 'uploadVideo', 'uploadAudio', 'uploadFile'] as const)(
    '%s rejects a file exactly at 1 GiB before staging network work', async (method) => {
    const fail = vi.fn();
    const failPending = vi.fn(async () => undefined);
    const stageMedia = vi.fn();
    const host = {
      threadId: () => 9,
      failPending,
      markAccepted: vi.fn(),
      surfaceQuota: vi.fn(),
    } satisfies ThreadAttachmentUploadHost;
    const controller = new ThreadAttachmentUploadController(
      { stageMedia } as unknown as MessageThreadAdapter,
      { fail } as unknown as MediaTransferService,
      {
        translate: (key: string) => key,
      } as TranslocoService,
      {} as NativeUploadService,
      { enabled: () => false } as DebugToolsService,
      {} as ToastService,
      host,
    );

    await controller[method](
      'cid',
      'part',
      { size: 1024 * 1024 * 1024 } as File,
      { id: -1, data: { type: 'msg' } } as never,
      false,
    );

    expect(stageMedia).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      'cid',
      'transfer.attachmentTooLarge',
      false,
    );
    expect(failPending).toHaveBeenCalledOnce();
  });

  it.each(['uploadImage', 'uploadVideo', 'uploadAudio', 'uploadFile'] as const)(
    '%s admits a file just below 1 GiB to staging', async (method) => {
      // Stop at staging so no large File or network payload needs to be allocated.
      const stageMedia = vi.fn(() => of({ code: 10000, message: 'test stop', data: null }));
      const controller = new ThreadAttachmentUploadController(
        { stageMedia } as unknown as MessageThreadAdapter,
        { fail: vi.fn(), isUploading: () => true, cancelled: () => NEVER } as unknown as MediaTransferService,
        { translate: (key: string) => key } as TranslocoService,
        {} as NativeUploadService,
        { enabled: () => false } as DebugToolsService,
        {} as ToastService,
        {
          threadId: () => 9,
          failPending: vi.fn(async () => undefined),
          markAccepted: vi.fn(),
          surfaceQuota: vi.fn(),
        },
      );
      await controller[method](
        'cid', 'part', { size: 1024 * 1024 * 1024 - 1 } as File,
        { id: -1, data: { type: 'msg' } } as never, false,
      );
      expect(stageMedia).toHaveBeenCalledOnce();
    },
  );
});
