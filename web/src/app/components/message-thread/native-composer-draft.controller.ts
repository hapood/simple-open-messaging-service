import { signal } from '@angular/core';
import { type Observable, Subscription } from 'rxjs';
import type { AccountComposerDraft } from '../../../../../shared/account-state';
import type {
  LinkCardGeneration,
  LinkGenerationView,
} from '../../services/link-card-generation.service';

/** The draft persistence operations this controller needs. */
export interface ComposerDraftStore {
  get(threadId: number): AccountComposerDraft | undefined;
  save(draft: AccountComposerDraft): void;
}

/** The link-generation operations this controller needs. */
export interface LinkGenerationClient {
  begin$(url: string, text: string): Observable<LinkGenerationView>;
  resume(generation: LinkCardGeneration): void;
  forget(generationId: string): void;
  pause(generationId: string): void;
  snapshot(generationId: string): LinkGenerationView | undefined;
}

/** Owns native-composer draft persistence and link-generation lifecycle. */
export class NativeComposerDraftController {
  readonly text = signal('');
  private linkUrl: string | null = null;
  private generationId: string | null = null;
  private generationStarting = false;
  private generationRequest?: Subscription;

  constructor(
    private readonly drafts: ComposerDraftStore,
    private readonly generations: LinkGenerationClient,
  ) {}

  open(threadId: number): string {
    this.reset();
    const saved = this.drafts.get(threadId);
    this.text.set(saved?.plainText ?? '');
    this.linkUrl = saved?.linkUrl ?? null;
    this.generationId = saved?.generationId ?? null;
    if (
      saved?.generationId &&
      saved.generationExpiresAt &&
      saved.generationExpiresAt > Date.now()
    ) {
      this.generations.resume({
        generationId: saved.generationId,
        status: 'pending',
        expiresAt: saved.generationExpiresAt,
      });
    }
    return this.text();
  }

  set(text: string): void {
    this.text.set(text);
  }

  append(text: string): void {
    if (text) this.text.update((draft) => (draft ? `${draft}\n${text}` : text));
  }

  consumeLink(url: string | null, text: string): void {
    if (
      url === this.linkUrl &&
      (!url || this.generationStarting || this.generationId)
    )
      return;
    this.stopGenerationRequest();
    if (this.generationId) this.generations.forget(this.generationId);
    this.linkUrl = url;
    this.generationId = null;
    this.generationStarting = Boolean(url);
    if (!url) return;
    this.generationRequest = this.generations.begin$(url, text).subscribe({
      next: (generation) => {
        this.generationId = generation.generationId;
        this.generationStarting = false;
      },
      error: () => {
        this.generationStarting = false;
      },
    });
  }

  clearLink(): void {
    this.stopGenerationRequest();
    if (this.generationId) this.generations.forget(this.generationId);
    this.linkUrl = null;
    this.generationId = null;
    this.generationStarting = false;
  }

  save(threadId: number, escapeHtml: (text: string) => string): void {
    const text = this.text();
    this.drafts.save({
      threadId,
      html: escapeHtml(text),
      plainText: text,
      linkUrl: this.linkUrl ?? undefined,
      generationId: this.generationId ?? undefined,
      generationExpiresAt: this.generationId
        ? this.generations.snapshot(this.generationId)?.expiresAt
        : undefined,
      generationTriggered: Boolean(this.generationId),
      updatedAt: Date.now(),
    });
  }

  private stopGenerationRequest(): void {
    this.generationRequest?.unsubscribe();
    this.generationRequest = undefined;
  }

  reset(): void {
    this.stopGenerationRequest();
    if (this.generationId) this.generations.pause(this.generationId);
    this.generationId = null;
    this.linkUrl = null;
    this.generationStarting = false;
    this.text.set('');
  }
}
