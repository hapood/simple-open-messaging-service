import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/** Explicit local-session boundaries, including logout before HELLO identifies the user. */
@Injectable({ providedIn: 'root' })
export class SessionLifecycleService {
  private epoch = 0;
  private readonly invalidated = new Subject<number>();
  readonly invalidated$ = this.invalidated.asObservable();
  private readonly ended = new Subject<void>();
  readonly ended$ = this.ended.asObservable();

  /** In-memory only. Async work captures this value before it starts. */
  get accountEpoch(): number {
    return this.epoch;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.epoch;
  }

  /** Invalidate old work synchronously, before waiting for durable cleanup. */
  invalidateSession(): void {
    this.invalidated.next(++this.epoch);
  }

  /** Called after durable account cleanup succeeds. Subscribers reset synchronously before login. */
  endSession(): void {
    this.ended.next();
  }
}
