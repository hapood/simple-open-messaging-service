import { Injectable, signal } from '@angular/core';
import { isAndroidNative } from './runtime';

export interface NativeSharedText {
  id: string;
  text: string;
}

export interface NativeShareDraft extends NativeSharedText {
  threadIds: readonly number[];
}

/** Receives Android ACTION_SEND text without consuming it. The recipient flow acknowledges only after it
 *  has safely taken ownership, which makes Angular boot and WebView recreation lossless. */
@Injectable({ providedIn: 'root' })
export class NativeShareService {
  readonly pending = signal<NativeSharedText | null>(null);
  /** Recipient-owned draft for the next link-generation phase. The native payload remains unacknowledged
   *  until that workflow has safely sent or fallen back to text. */
  readonly draft = signal<NativeShareDraft | null>(null);

  constructor() {
    if (!isAndroidNative()) return;
    window.__SOMS_SHARE_AVAILABLE__ = () => this.refresh();
    this.refresh();
  }

  refresh(): void {
    const raw = window.SomsShare?.getPending();
    if (!raw) {
      this.pending.set(null);
      return;
    }
    try {
      const value = JSON.parse(raw) as Partial<NativeSharedText>;
      if (typeof value.id !== 'string' || typeof value.text !== 'string')
        return;
      this.pending.set({ id: value.id, text: value.text });
    } catch (error) {
      console.error('[native-share] invalid pending payload:', error);
    }
  }

  acknowledge(id: string): boolean {
    const accepted = window.SomsShare?.acknowledge(id) ?? false;
    if (accepted && this.pending()?.id === id) this.pending.set(null);
    if (accepted && this.draft()?.id === id) this.draft.set(null);
    return accepted;
  }

  claimRecipients(
    payload: NativeSharedText,
    threadIds: readonly number[],
  ): void {
    if (this.pending()?.id !== payload.id) return;
    this.draft.set({ ...payload, threadIds: [...threadIds] });
  }

  releaseDraft(): void {
    this.draft.set(null);
  }
}
