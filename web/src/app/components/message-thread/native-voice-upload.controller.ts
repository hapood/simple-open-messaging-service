import type { TranslocoService } from '@jsverse/transloco';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import { tauriInvoke } from '../../services/runtime';
import type { MediaTransferService } from '../../services/media-transfer.service';
import type { ToastService } from '../../services/toast.service';
import type { NativeVoiceUploadEvent } from '../../services/native-composer.service';
import type { ChatItemData } from '../message-cards/chat-item';
import { VOICE_BAR_H, VOICE_BAR_W } from '../message-cards/media-row/layout';

export interface NativeVoiceUploadHost {
  makeItem(
    clientMessageId: string,
    duration: number,
    size: number,
  ): CbItem<ChatItemData>;
  dispatch(item: CbItem<ChatItemData>): void;
  accept(item: CbItem<ChatItemData>): Promise<void>;
  fail(item: CbItem<ChatItemData>): Promise<void>;
}

/** Owns native-recorder upload progress and optimistic voice-message reconciliation. */
export class NativeVoiceUploadController {
  private readonly items = new Map<string, CbItem<ChatItemData>>();

  constructor(
    private readonly transfers: MediaTransferService,
    private readonly transloco: TranslocoService,
    private readonly toast: ToastService,
    private readonly host: NativeVoiceUploadHost,
  ) {}

  owns(clientMessageId: string): boolean {
    return this.items.has(clientMessageId);
  }

  progress(clientMessageId: string, loaded: number, total: number): void {
    if (this.owns(clientMessageId))
      this.transfers.progress(clientMessageId, loaded, total);
  }

  handle(event: NativeVoiceUploadEvent): void {
    const cid = event.clientMessageId;
    if (event.phase === 'started') {
      if (this.items.has(cid)) return;
      const item = this.host.makeItem(cid, event.durationMs / 1000, event.size);
      this.items.set(cid, item);
      this.transfers.start({
        clientMessageId: cid,
        threadId: event.threadId,
        kind: 'audio',
        name: 'voice.m4a',
        size: event.size,
      });
      this.transfers.registerCancel(cid, () => {
        void tauriInvoke('cancel_upload', { clientMessageId: cid });
      });
      this.host.dispatch(item);
      return;
    }
    const item = this.items.get(cid);
    if (!item) return;
    if (event.phase === 'completed') {
      this.transfers.complete(cid);
      void this.host.accept(item);
      this.items.delete(cid);
      return;
    }
    const reason =
      event.error || String(this.transloco.translate('transfer.uploadFailed'));
    this.transfers.fail(cid, reason);
    this.toast.warn(reason, { duration: 6000 });
    void this.host.fail(item);
  }
}

export function nativeVoicePreview(duration: number, size: number) {
  return [
    {
      kind: 'audio' as const,
      src: '',
      w: VOICE_BAR_W,
      h: VOICE_BAR_H,
      size,
      duration,
      name: 'voice.m4a',
    },
  ];
}
