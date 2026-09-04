import { Injectable } from '@angular/core';
import {
  BehaviorSubject,
  Observable,
  filter,
  firstValueFrom,
  shareReplay,
  take,
  map,
  race,
} from 'rxjs';
import { UserService } from './user.service';
import { WebsocketService } from './websocket.service';

export interface ResolvedProfile {
  account: string;
  domain: string;
  rev: number;
  name: string;
  bio: string;
  avatarBase64: string | null;
}

export type ProfileSelector =
  | { account: string; domain: string; rev: number }
  | { threadId: number; messageSeq: number }
  | { threadId: number; memberAccount: string; memberDomain: string };

type Terminal =
  | { requestId: string; profile: ResolvedProfile }
  | {
      requestId: string;
      reason: 'NOT_FOUND' | 'NOT_DISCLOSED' | 'TEMPORARILY_UNAVAILABLE';
    };

/** Root-scoped profile dispatcher sharing the one authenticated /events stream. */
@Injectable({ providedIn: 'root' })
export class ProfileResolutionService {
  private readonly active = new Map<string, Observable<ResolvedProfile>>();
  private readonly terminals = new Map<
    string,
    { value: Terminal; expiresAt: number }
  >();
  private readonly waiters = new Map<
    string,
    BehaviorSubject<Terminal | null>
  >();
  private readonly results = new Map<string, ResolvedProfile>();

  constructor(
    private readonly users: UserService,
    private readonly realtime: WebsocketService,
  ) {
    this.realtime.eventSubject.subscribe((event) => {
      if (
        (event.event !== 'PROFILE_RESOLVED' &&
          event.event !== 'PROFILE_FAILED') ||
        event.status !== 0 ||
        !event.data
      ) {
        return;
      }
      const terminal = event.data as Terminal;
      if (!this.validTerminal(terminal)) return;
      this.rememberTerminal(terminal);
      this.waiters.get(terminal.requestId)?.next(terminal);
      if ('profile' in terminal) this.rememberResult(terminal.profile);
    });
  }

  resolve(selector: ProfileSelector): Observable<ResolvedProfile> {
    const normalized = normalizeSelector(selector);
    const key = JSON.stringify(normalized);
    const cached =
      'rev' in normalized
        ? this.results.get(
            profileKey(normalized.account, normalized.domain, normalized.rev),
          )
        : undefined;
    if (cached)
      return new Observable((subscriber) => {
        subscriber.next(cached);
        subscriber.complete();
      });
    const running = this.active.get(key);
    if (running) return running;
    const request = new Observable<ResolvedProfile>((subscriber) => {
      let cancelled = false;
      void this.run(normalized)
        .then((profile) => {
          if (!cancelled) subscriber.next(profile);
          if (!cancelled) subscriber.complete();
        })
        .catch((error) => {
          if (!cancelled) subscriber.error(error);
        });
      return () => {
        cancelled = true;
      };
    }).pipe(shareReplay({ bufferSize: 1, refCount: false }));
    this.active.set(key, request);
    request.subscribe({
      next: (profile) => this.rememberResult(profile),
      error: () => this.active.delete(key),
      complete: () => this.active.delete(key),
    });
    return request;
  }

  private async run(selector: ProfileSelector): Promise<ResolvedProfile> {
    for (;;) {
      await firstValueFrom(
        this.realtime.helloReady$.pipe(filter(Boolean), take(1)),
      );
      const generation = this.realtime.helloGeneration$.value;
      const response = await firstValueFrom(
        this.users.startProfileResolution(selector),
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message);
      if (response.data.status === 'READY') return response.data.profile;
      const profile = await this.awaitTerminalOrReconnect(
        response.data.requestId,
        generation,
      );
      if (profile) return profile;
    }
  }

  private async awaitTerminalOrReconnect(
    requestId: string,
    generation: number,
  ): Promise<ResolvedProfile | null> {
    this.pruneTerminals();
    const raced = this.terminals.get(requestId)?.value;
    if (raced) return this.unwrap(raced);
    let waiter = this.waiters.get(requestId);
    if (!waiter) {
      waiter = new BehaviorSubject<Terminal | null>(null);
      this.waiters.set(requestId, waiter);
    }
    try {
      const outcome = await firstValueFrom(
        race(
          waiter.pipe(
            filter((value): value is Terminal => value !== null),
            map((terminal) => ({ kind: 'terminal' as const, terminal })),
          ),
          this.realtime.helloGeneration$.pipe(
            filter((value) => value > generation),
            map(() => ({ kind: 'reconnect' as const })),
          ),
        ).pipe(take(1)),
      );
      return outcome.kind === 'terminal' ? this.unwrap(outcome.terminal) : null;
    } finally {
      if (this.waiters.get(requestId) === waiter)
        this.waiters.delete(requestId);
    }
  }

  private unwrap(terminal: Terminal): ResolvedProfile {
    if ('profile' in terminal) return terminal.profile;
    throw new Error(`profile resolution failed: ${terminal.reason}`);
  }

  private rememberTerminal(value: Terminal): void {
    this.terminals.delete(value.requestId);
    this.terminals.set(value.requestId, {
      value,
      expiresAt: Date.now() + 60_000,
    });
    this.pruneTerminals();
    while (this.terminals.size > 1000)
      this.terminals.delete(this.terminals.keys().next().value!);
  }

  private pruneTerminals(): void {
    const now = Date.now();
    for (const [key, item] of this.terminals) {
      if (item.expiresAt <= now) this.terminals.delete(key);
    }
  }

  private rememberResult(profile: ResolvedProfile): void {
    const key = profileKey(profile.account, profile.domain, profile.rev);
    this.results.delete(key);
    this.results.set(key, profile);
    while (this.results.size > 1000)
      this.results.delete(this.results.keys().next().value!);
  }

  private validTerminal(value: Terminal): boolean {
    if (!value || typeof value.requestId !== 'string') return false;
    if ('profile' in value) {
      return (
        typeof value.profile?.account === 'string' &&
        typeof value.profile.domain === 'string' &&
        Number.isSafeInteger(value.profile.rev) &&
        typeof value.profile.name === 'string' &&
        typeof value.profile.bio === 'string' &&
        (value.profile.avatarBase64 === null ||
          typeof value.profile.avatarBase64 === 'string')
      );
    }
    return ['NOT_FOUND', 'NOT_DISCLOSED', 'TEMPORARILY_UNAVAILABLE'].includes(
      value.reason,
    );
  }
}

function normalizeSelector(selector: ProfileSelector): ProfileSelector {
  if ('rev' in selector)
    return {
      account: selector.account.trim().toLowerCase(),
      domain: selector.domain.trim().toLowerCase(),
      rev: selector.rev,
    };
  if ('messageSeq' in selector)
    return { threadId: selector.threadId, messageSeq: selector.messageSeq };
  return {
    threadId: selector.threadId,
    memberAccount: selector.memberAccount.trim().toLowerCase(),
    memberDomain: selector.memberDomain.trim().toLowerCase(),
  };
}

function profileKey(account: string, domain: string, rev: number): string {
  return JSON.stringify([domain.toLowerCase(), account.toLowerCase(), rev]);
}
