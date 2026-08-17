import { computed, Injectable, signal } from '@angular/core';
import type {
  LinkCardGeneration,
  LinkGenerationView,
} from '../app/services/link-card-generation.service';
import { uuid } from '../app/lib/uuid';

/** In-memory link-card generation used by the production composer inside the playground. */
@Injectable({ providedIn: 'root' })
export class PlaygroundLinkGeneration {
  private readonly generations = signal<
    Readonly<Record<string, LinkGenerationView>>
  >({});

  state(generationId: string) {
    return computed(() => this.generations()[generationId]);
  }

  snapshot(generationId: string): LinkGenerationView | undefined {
    return this.generations()[generationId];
  }

  async begin(
    url: string,
    text = '',
    generationId = uuid(),
  ): Promise<LinkGenerationView> {
    const parsed = new URL(url);
    const generation: LinkGenerationView = {
      generationId,
      status: 'failed',
      expiresAt: Date.now() + 60_000,
      polling: false,
      content: {
        url,
        title: parsed.hostname.replace(/^www\./i, ''),
        description: descriptionFallback(text, url) || url,
      },
    };
    this.generations.update((items) => ({
      ...items,
      [generationId]: generation,
    }));
    return generation;
  }

  resume(generation: LinkCardGeneration): void {
    this.generations.update((items) => ({
      ...items,
      [generation.generationId]: { ...generation, polling: false },
    }));
  }

  forget(generationId: string): void {
    const next = { ...this.generations() };
    delete next[generationId];
    this.generations.set(next);
  }

  pause(_generationId: string): void {}
}

function descriptionFallback(text: string, url: string): string {
  return text.split(url).join(' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}
