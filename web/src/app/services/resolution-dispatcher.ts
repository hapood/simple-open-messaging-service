import {
  BehaviorSubject,
  Observable,
  ReplaySubject,
  filter,
  firstValueFrom,
  from,
  map,
  race,
  share,
  take,
  timeout,
} from 'rxjs';
import type { WebsocketService } from './websocket.service';

export type ResolutionStart<T> =
  | { status: 'READY'; result: T }
  | { status: 'PENDING'; requestId: string };
export type ResolutionTerminal<T> =
  | { requestId: string; result: T }
  | { requestId: string; reason: string };

/** Shared request/SSE single-flight, early-terminal reconciliation and reconnect recovery. */
export class ResolutionDispatcher<S, T> {
  private readonly active = new Map<string, Observable<T>>();
  private readonly terminals = new Map<
    string,
    { value: ResolutionTerminal<T>; expiresAt: number }
  >();
  private readonly waiters = new Map<
    string,
    BehaviorSubject<ResolutionTerminal<T> | null>
  >();

  constructor(
    private readonly realtime: WebsocketService,
    private readonly start: (selector: S) => Promise<ResolutionStart<T>>,
    decode: (event: unknown) => ResolutionTerminal<T> | null,
  ) {
    realtime.eventSubject.subscribe((event) => {
      const terminal = decode(event);
      if (!terminal) return;
      this.terminals.set(terminal.requestId, {
        value: terminal,
        expiresAt: Date.now() + 60_000,
      });
      while (this.terminals.size > 1000)
        this.terminals.delete(this.terminals.keys().next().value!);
      this.waiters.get(terminal.requestId)?.next(terminal);
    });
  }

  resolve(selector: S): Observable<T> {
    const key = JSON.stringify(selector);
    const existing = this.active.get(key);
    if (existing) return existing;
    const request = new Observable<T>((subscriber) => {
      void this.run(selector).then(
        (result) => {
          subscriber.next(result);
          subscriber.complete();
        },
        (error) => subscriber.error(error),
      );
    }).pipe(
      share({
        connector: () => new ReplaySubject<T>(1),
        resetOnError: false,
        resetOnComplete: false,
        resetOnRefCountZero: false,
      }),
    );
    this.active.set(key, request);
    request.subscribe({
      error: () => this.active.delete(key),
      complete: () => this.active.delete(key),
    });
    return request;
  }

  private async run(selector: S): Promise<T> {
    for (;;) {
      await firstValueFrom(
        this.realtime.helloReady$.pipe(
          filter(Boolean),
          take(1),
          timeout(30_000),
        ),
      );
      const generation = this.realtime.helloGeneration$.value;
      const response = await firstValueFrom(
        from(this.start(selector)).pipe(timeout(30_000)),
      );
      if (response.status === 'READY') return response.result;
      const terminal = await this.awaitTerminal(response.requestId, generation);
      if (!terminal) continue;
      if ('result' in terminal) return terminal.result;
      throw new Error(`resolution failed: ${terminal.reason}`);
    }
  }

  private async awaitTerminal(
    requestId: string,
    generation: number,
  ): Promise<ResolutionTerminal<T> | null> {
    for (const [key, item] of this.terminals)
      if (item.expiresAt <= Date.now()) this.terminals.delete(key);
    const early = this.terminals.get(requestId);
    if (early) return early.value;
    const waiter =
      this.waiters.get(requestId) ??
      new BehaviorSubject<ResolutionTerminal<T> | null>(null);
    this.waiters.set(requestId, waiter);
    try {
      return await firstValueFrom(
        race(
          waiter.pipe(
            filter((value): value is ResolutionTerminal<T> => value !== null),
          ),
          this.realtime.helloGeneration$.pipe(
            filter((value) => value > generation),
            map(() => null),
          ),
        ).pipe(take(1), timeout(30_000)),
      );
    } finally {
      if (this.waiters.get(requestId) === waiter)
        this.waiters.delete(requestId);
    }
  }
}
