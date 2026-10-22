import { signal } from '@angular/core';
import type { ComposerDraftService } from '../../services/composer-draft.service';
import type { LinkCardGenerationService } from '../../services/link-card-generation.service';

/** Owns native-composer draft persistence and link-generation lifecycle. */
export class NativeComposerDraftController {
  readonly text = signal('');
  private linkUrl: string | null = null;
  private generationId: string | null = null;
  private generationStarting = false;
  private generationRevision = 0;

  constructor(
    private readonly drafts: ComposerDraftService,
    private readonly generations: LinkCardGenerationService,
  ) {}

  open(threadId: number): string {
    const saved = this.drafts.get(threadId);
    this.generationRevision++;
    this.generationStarting = false;
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
    const revision = ++this.generationRevision;
    if (this.generationId) this.generations.forget(this.generationId);
    this.linkUrl = url;
    this.generationId = null;
    this.generationStarting = Boolean(url);
    if (!url) return;
    void this.generations
      .begin(url, text)
      .then((generation) => {
        if (revision !== this.generationRevision || url !== this.linkUrl) {
          this.generations.forget(generation.generationId);
          return;
        }
        this.generationId = generation.generationId;
        this.generationStarting = false;
      })
      .catch(() => {
        if (revision === this.generationRevision)
          this.generationStarting = false;
      });
  }

  clearLink(): void {
    this.generationRevision++;
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

  reset(): void {
    this.text.set('');
  }
}
