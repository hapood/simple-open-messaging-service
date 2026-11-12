import {
  DestroyRef,
  computed,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  EMPTY,
  Subscription,
  expand,
  finalize,
  firstValueFrom,
  map,
  switchMap,
  tap,
  timer,
} from 'rxjs';
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
  private readonly polls = new Map<string, Subscription>();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      for (const subscription of this.polls.values())
        subscription.unsubscribe();
      this.polls.clear();
    });
  }

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

  /** Cold request: the caller owns HTTP cancellation until the response arrives.
   * Cancelling transport does not undo a generation already admitted by the server. */
  begin$(url: string, text = '', generationId?: string) {
    return this.start(url, text, generationId).pipe(
      map((response): LinkGenerationView => {
        if (!response.data) throw new Error('link generation was not started');
        return {
          ...response.data,
          polling: response.data.status === 'pending',
        };
      }),
      tap((state) => {
        this.setState(state);
        if (state.status === 'pending') this.poll(state.generationId);
      }),
    );
  }

  begin(
    url: string,
    text = '',
    generationId?: string,
  ): Promise<LinkGenerationView> {
    return firstValueFrom(this.begin$(url, text, generationId));
  }

  resume(generation: LinkCardGeneration): void {
    this.setState({ ...generation, polling: generation.status === 'pending' });
    if (generation.status === 'pending') this.poll(generation.generationId);
  }

  forget(generationId: string): void {
    this.stopPoll(generationId);
    const next = { ...this.states() };
    delete next[generationId];
    this.states.set(next);
  }

  pause(generationId: string): void {
    this.stopPoll(generationId);
    const previous = this.states()[generationId];
    if (previous) this.setState({ ...previous, polling: false });
  }

  private stopPoll(generationId: string): void {
    const subscription = this.polls.get(generationId);
    this.polls.delete(generationId);
    subscription?.unsubscribe();
  }

  private poll(generationId: string): void {
    if (this.polls.has(generationId)) return;
    const owner = new Subscription();
    this.polls.set(generationId, owner);
    const request = (delay: number) =>
      timer(delay).pipe(
        switchMap(() => this.get(generationId)),
        map((response) => {
          if (!response.data) throw new Error('generation expired');
          return response.data;
        }),
      );
    owner.add(
      request(0)
        .pipe(
          expand((generation) =>
            generation.status === 'pending' ? request(600) : EMPTY,
          ),
          finalize(() => this.polls.delete(generationId)),
        )
        .subscribe({
          next: (generation) =>
            this.setState({
              ...generation,
              polling: generation.status === 'pending',
            }),
          error: () => {
            const previous = this.states()[generationId];
            if (previous)
              this.setState({
                ...previous,
                status: 'failed',
                polling: false,
                unavailable: true,
              });
          },
        }),
    );
  }

  private setState(state: LinkGenerationView): void {
    this.states.set({ ...this.states(), [state.generationId]: state });
  }
}
