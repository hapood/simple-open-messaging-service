import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/** Explicit local-session boundaries, including logout before HELLO identifies the user. */
@Injectable({ providedIn: 'root' })
export class SessionLifecycleService {
  private readonly ended = new Subject<void>();
  readonly ended$ = this.ended.asObservable();

  /** Called after durable account cleanup succeeds. Subscribers reset synchronously before login. */
  endSession(): void {
    this.ended.next();
  }
}
