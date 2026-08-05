import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiPrefix } from './constants';
import type { StandardResponse } from './model';

export interface LinkCardContent {
  url: string;
  title: string;
  description: string;
  siteName?: string;
  image?: string;
  favicon?: string;
}

export type LinkCardGenerationStatus = 'pending' | 'succeeded' | 'failed';

export interface LinkCardGeneration {
  generationId: string;
  status: LinkCardGenerationStatus;
  expiresAt: number;
  /** May arrive while the rest of the card is still pending. */
  favicon?: string;
  content?: LinkCardContent;
}

export interface LinkGenerationView extends LinkCardGeneration {
  polling: boolean;
  unavailable?: boolean;
}

@Injectable({ providedIn: 'root' })
export class LinkCardGenerationService {
  private readonly http = inject(HttpClient);
  private readonly states = signal<
    Readonly<Record<string, LinkGenerationView>>
  >({});
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  state(generationId: string) {
    return computed(() => this.states()[generationId]);
  }

  snapshot(generationId: string): LinkGenerationView | undefined {
    return this.states()[generationId];
  }

  start(url: string, text = '', generationId?: string) {
    return this.http.post<StandardResponse<LinkCardGeneration>>(
      `${apiPrefix()}/link-preview/generations`,
      { url, text, ...(generationId ? { generationId } : {}) },
    );
  }

  get(generationId: string) {
    return this.http.get<StandardResponse<LinkCardGeneration>>(
      `${apiPrefix()}/link-preview/generations/${encodeURIComponent(generationId)}`,
    );
  }

  async begin(
    url: string,
    text = '',
    generationId?: string,
  ): Promise<LinkGenerationView> {
    const response = await firstValueFrom(this.start(url, text, generationId));
    if (!response.data) throw new Error('link generation was not started');
    const state = {
      ...response.data,
      polling: response.data.status === 'pending',
    };
    this.setState(state);
    if (state.status === 'pending') this.poll(state.generationId);
    return state;
  }

  resume(generation: LinkCardGeneration): void {
    this.setState({ ...generation, polling: generation.status === 'pending' });
    if (generation.status === 'pending') this.poll(generation.generationId);
  }

  forget(generationId: string): void {
    const timer = this.timers.get(generationId);
    if (timer) clearTimeout(timer);
    this.timers.delete(generationId);
    const next = { ...this.states() };
    delete next[generationId];
    this.states.set(next);
  }

  pause(generationId: string): void {
    const timer = this.timers.get(generationId);
    if (timer) clearTimeout(timer);
    this.timers.delete(generationId);
    const previous = this.states()[generationId];
    if (previous) this.setState({ ...previous, polling: false });
  }

  private poll(generationId: string): void {
    if (this.timers.has(generationId)) return;
    const tick = async () => {
      this.timers.delete(generationId);
      try {
        const response = await firstValueFrom(this.get(generationId));
        const generation = response.data;
        if (!generation) throw new Error('generation expired');
        this.setState({
          ...generation,
          polling: generation.status === 'pending',
        });
        if (generation.status === 'pending') this.schedule(generationId, tick);
      } catch {
        const previous = this.states()[generationId];
        if (previous)
          this.setState({
            ...previous,
            status: 'failed',
            polling: false,
            unavailable: true,
          });
      }
    };
    this.schedule(generationId, tick, 0);
  }

  private schedule(generationId: string, tick: () => void, delay = 600): void {
    this.timers.set(generationId, setTimeout(tick, delay));
  }

  private setState(state: LinkGenerationView): void {
    this.states.set({ ...this.states(), [state.generationId]: state });
  }
}
