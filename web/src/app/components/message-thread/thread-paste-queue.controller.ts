import { computed, signal } from '@angular/core';
import { uuid } from '../../lib/uuid';
import type { PastePanelItem } from '../../lib/chat-input/paste-panel.component';
import type { NativeUploadSelection } from '../../services/native-upload.service';

export type ThreadPasteItem = PastePanelItem &
  (
    | { source: 'web'; file: File; fingerprint: string }
    | { source: 'native'; selection: NativeUploadSelection }
  );

/** Owns paste deduplication and preview-URL lifetime independently of sending. */
export class ThreadPasteQueueController {
  constructor(private readonly discardNative: (uploadId: string) => void) {}

  readonly items = signal<ThreadPasteItem[]>([]);
  readonly open = computed(() => this.items().length > 0);

  appendWeb(files: readonly File[]): void {
    const existing = new Set(
      this.items()
        .filter((item) => item.source === 'web')
        .map((item) => item.fingerprint),
    );
    const additions: ThreadPasteItem[] = [];
    for (const file of files) {
      const fingerprint = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
      if (existing.has(fingerprint)) continue;
      existing.add(fingerprint);
      additions.push({
        id: `web:${fingerprint}:${uuid()}`,
        source: 'web',
        file,
        fingerprint,
        name: file.name,
        size: file.size,
        previewUrl: file.type.startsWith('image/')
          ? URL.createObjectURL(file)
          : undefined,
      });
    }
    this.items.update((items) => [...items, ...additions]);
  }

  appendNative(files: readonly NativeUploadSelection[]): void {
    const existing = new Set(
      this.items()
        .filter((item) => item.source === 'native')
        .map((item) => item.selection.uploadId),
    );
    const additions = files
      .filter((selection) => {
        if (existing.has(selection.uploadId)) return false;
        existing.add(selection.uploadId);
        return true;
      })
      .map(
        (selection): ThreadPasteItem => ({
          id: `native:${selection.uploadId}`,
          source: 'native',
          selection,
          name: selection.name,
          size: selection.size,
          previewUrl: selection.preview ?? undefined,
        }),
      );
    this.items.update((items) => [...items, ...additions]);
  }

  remove(id: string): void {
    const item = this.items().find((candidate) => candidate.id === id);
    if (!item) return;
    this.release(item);
    this.items.update((items) =>
      items.filter((candidate) => candidate.id !== id),
    );
  }

  take(): ThreadPasteItem[] {
    const items = this.items();
    this.items.set([]);
    return items;
  }

  cancel(): void {
    for (const item of this.items()) this.release(item);
    this.items.set([]);
  }

  release(item: ThreadPasteItem): void {
    if (item.source === 'native') this.discardNative(item.selection.uploadId);
    else if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
}
