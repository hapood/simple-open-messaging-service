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
  private sessionEpoch = 0;
  private readonly active = new Map<string, Observable<T>>();
  private readonly initial = new Map<string, Promise<void>>();
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
    let initialDone!: () => void;
    this.initial.set(
      key,
      new Promise<void>((resolve) => (initialDone = resolve)),
    );
    const request = new Observable<T>((subscriber) => {
      void this.run(selector, initialDone).then(
        (result) => {
          subscriber.next(result);
          subscriber.complete();
          initialDone();
        },
        (error) => {
          subscriber.error(error);
          initialDone();
        },
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
      error: () => {
        if (this.active.get(key) !== request) return;
        this.active.delete(key);
        this.initial.delete(key);
      },
      complete: () => {
        if (this.active.get(key) !== request) return;
        this.active.delete(key);
        this.initial.delete(key);
      },
    });
    return request;
  }

  /** Detach completed-session requests from future selectors. Existing subscribers own their teardown. */
  reset(): void {
    this.sessionEpoch++;
    this.active.clear();
    this.initial.clear();
    this.terminals.clear();
    this.waiters.clear();
  }

  /** Wait for the first response, including delivery of READY data, but never for a PENDING terminal. */
  prepare(selector: S): Promise<void> {
    this.resolve(selector);
    // An offline/cold connection has no immediate response to wait for. Keep cached rows usable;
    // the existing request resumes through HELLO and enriches them in the background.
    if (!this.realtime.helloReady$.value) return Promise.resolve();
    return this.initial.get(JSON.stringify(selector)) ?? Promise.resolve();
  }

  private async run(selector: S, initialDone: () => void): Promise<T> {
    const epoch = this.sessionEpoch;
    const assertSession = () => {
      if (epoch !== this.sessionEpoch)
        throw new Error('resolution session ended');
    };
    for (;;) {
      await firstValueFrom(
        this.realtime.helloReady$.pipe(
          filter(Boolean),
          take(1),
          timeout(30_000),
        ),
      );
      assertSession();
      const generation = this.realtime.helloGeneration$.value;
      const response = await firstValueFrom(
        from(this.start(selector)).pipe(timeout(30_000)),
      );
      assertSession();
      if (response.status === 'READY') return response.result;
      initialDone();
      const terminal = await this.awaitTerminal(response.requestId, generation);
      assertSession();
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
