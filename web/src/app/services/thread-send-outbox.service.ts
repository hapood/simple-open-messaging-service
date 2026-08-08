import { Injectable } from '@angular/core';
import type { CbItem } from '../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../components/message-cards/chat-item';
import type { NativeUploadSelection } from './native-upload.service';

export type PendingSendResource =
  | {
      type: 'web-attachment';
      file: File;
      partId: string;
      mediaKind: 'image' | 'file' | 'video' | 'audio';
    }
  | {
      type: 'native-attachment';
      selection: NativeUploadSelection;
      partId: string;
      release: () => void;
      discard: () => void;
    }
  | {
      type: 'voice';
      file: File;
      partId: string;
      duration: number;
      previewUrl: string;
    }
  | {
      type: 'web-gallery';
      parts: readonly {
        file: File;
        partId: string;
        position: number;
        intent: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';
      }[];
      previewUrls: readonly string[];
    }
  | {
      type: 'native-gallery';
      parts: readonly {
        selection: NativeUploadSelection;
        partId: string;
        position: number;
      }[];
      release: () => void;
      discard: () => void;
    };

/**
 * Application-scoped, memory-only optimistic-send outbox.
 *
 * A HttpItemSource is recreated whenever its thread view is recreated. Keeping pending sends here,
 * keyed by threadId, lets the new source remount the same optimistic bubbles without introducing
 * IndexedDB/native persistence. The server-confirmed Message remains the durable truth; this store
 * only survives for the lifetime of the current JavaScript application.
 */
@Injectable({ providedIn: 'root' })
export class ThreadSendOutbox {
  private readonly byThread = new Map<number, CbItem<ChatItemData>[]>();
  private readonly resources = new Map<string, PendingSendResource>();
  private nextPlaceholderId = -1;

  /** Return the live array owned by this outbox. HttpItemSource is the sole mutator. */
  forThread(threadId: number): CbItem<ChatItemData>[] {
    let pending = this.byThread.get(threadId);
    if (!pending) {
      pending = [];
      this.byThread.set(threadId, pending);
    }
    return pending;
  }

  /** Allocate an application-wide synthetic id that cannot collide across restored thread sources. */
  allocatePlaceholderId(): number {
    return this.nextPlaceholderId--;
  }

  retainResource(clientMessageId: string, resource: PendingSendResource): void {
    this.releaseResource(clientMessageId, true);
    this.resources.set(clientMessageId, resource);
  }

  resource(clientMessageId: string): PendingSendResource | undefined {
    return this.resources.get(clientMessageId);
  }

  /** Release retry data only when its pending send is confirmed or explicitly discarded. */
  releaseResource(clientMessageId: string, discard = false): void {
    const resource = this.resources.get(clientMessageId);
    if (!resource) return;
    this.resources.delete(clientMessageId);
    if (resource.type === 'native-attachment') {
      if (discard) resource.discard();
      else resource.release();
    }
    if (resource.type === 'voice') URL.revokeObjectURL(resource.previewUrl);
    if (resource.type === 'web-gallery') {
      for (const url of resource.previewUrls) URL.revokeObjectURL(url);
    }
    if (resource.type === 'native-gallery') {
      if (discard) resource.discard();
      else resource.release();
    }
  }

  /** Drop the empty thread bucket once all optimistic sends have been confirmed or discarded. */
  releaseIfEmpty(threadId: number): void {
    if (this.byThread.get(threadId)?.length === 0)
      this.byThread.delete(threadId);
  }

  /** Session teardown hook; intentionally does not persist anything across a JavaScript restart. */
  clear(): void {
    for (const clientMessageId of [...this.resources.keys()])
      this.releaseResource(clientMessageId, true);
    this.byThread.clear();
    this.nextPlaceholderId = -1;
  }
}
