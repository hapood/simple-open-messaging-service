import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { WebdbService } from './webdb.service';
import { isAndroidNative, isTauri } from './runtime';

export interface ComposerDraft {
  threadId: number;
  html: string;
  plainText: string;
  linkUrl?: string;
  generationId?: string;
  generationExpiresAt?: number;
  generationTriggered?: boolean;
  updatedAt: number;
}

const META_KEY = 'composerDrafts';

@Injectable({ providedIn: 'root' })
export class ComposerDraftService {
  private readonly webdb = inject(WebdbService);
  private readonly draftsState = signal<ReadonlyMap<number, ComposerDraft>>(
    new Map(),
  );
  private hydrated = false;
  private writeRevision = 0;

  readonly drafts = this.draftsState.asReadonly();
  readonly threadIds = computed(
    () => new Set(Array.from(this.draftsState().keys())),
  );

  constructor() {
    effect(() => {
      if ((!isTauri() || isAndroidNative()) && this.webdb.ready() && !this.hydrated) {
        this.hydrated = true;
        void this.restore();
      }
      if (!this.webdb.ready()) {
        this.hydrated = false;
        this.draftsState.set(new Map());
      }
    });
  }

  get(threadId: number): ComposerDraft | undefined {
    return this.draftsState().get(threadId);
  }

  save(draft: ComposerDraft): void {
    if (isTauri() && !isAndroidNative()) return;
    this.writeRevision++;
    const next = new Map(this.draftsState());
    if (draft.plainText.trim()) next.set(draft.threadId, draft);
    else next.delete(draft.threadId);
    this.draftsState.set(next);
    void this.persist(next);
  }

  clear(threadId: number): void {
    if ((isTauri() && !isAndroidNative()) || !this.draftsState().has(threadId))
      return;
    this.writeRevision++;
    const next = new Map(this.draftsState());
    next.delete(threadId);
    this.draftsState.set(next);
    void this.persist(next);
  }

  private async restore(): Promise<void> {
    const revision = this.writeRevision;
    const value = await this.webdb.getMeta(META_KEY);
    if (
      !this.hydrated ||
      revision !== this.writeRevision ||
      !Array.isArray(value)
    )
      return;
    const drafts = new Map<number, ComposerDraft>();
    for (const item of value) {
      if (!isComposerDraft(item) || !item.plainText.trim()) continue;
      drafts.set(item.threadId, item);
    }
    this.draftsState.set(drafts);
  }

  private persist(drafts: ReadonlyMap<number, ComposerDraft>): Promise<void> {
    return this.webdb.putMeta(META_KEY, Array.from(drafts.values()));
  }
}

function isComposerDraft(value: unknown): value is ComposerDraft {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ComposerDraft>;
  return (
    typeof item.threadId === 'number' &&
    typeof item.html === 'string' &&
    typeof item.plainText === 'string' &&
    typeof item.updatedAt === 'number'
  );
}
