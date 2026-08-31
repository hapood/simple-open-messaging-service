import { describe, expect, it, vi } from 'vitest';
import type { TranslocoService } from '@jsverse/transloco';
import type { MessageThreadAdapter } from './message-thread-adapter';
import type { MediaTransferService } from '../../services/media-transfer.service';
import type { NativeUploadService } from '../../services/native-upload.service';
import type { DebugToolsService } from '../../services/debug-tools.service';
import type { ToastService } from '../../services/toast.service';
import {
  ThreadAttachmentUploadController,
  type ThreadAttachmentUploadHost,
} from './thread-attachment-upload.controller';

describe('ThreadAttachmentUploadController', () => {
  it('rejects an oversized image before staging network work', async () => {
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

    await controller.uploadImage(
      'cid',
      'part',
      { size: 11 * 1024 * 1024 } as File,
      { id: -1, data: { type: 'msg' } } as never,
      false,
    );

    expect(stageMedia).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith('cid', 'transfer.fileTooLarge', false);
    expect(failPending).toHaveBeenCalledOnce();
  });
});
