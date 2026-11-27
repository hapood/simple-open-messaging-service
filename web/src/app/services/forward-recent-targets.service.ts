import { Injectable, inject } from '@angular/core';
import { AppStateStorage } from './preference-storage';
import {
  SessionLifecycleService,
  type SessionWorkScope,
} from './session-lifecycle.service';
import { isTauri, tauriInvoke } from './runtime';

const RECENT_TARGETS_KEY = 'forwardRecentThreads';
const MAX_RECENT_TARGETS = 12;

/** Browser policy only; native validation and ordering belong to Rust. */
function validThreadIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((id): id is number => Number.isSafeInteger(id) && id > 0),
    ),
  ].slice(0, MAX_RECENT_TARGETS);
}

function ownsHistory(
  state: ReadonlyMap<string, unknown>,
  scope: SessionWorkScope,
): boolean {
  return (
    scope.sessionId !== null &&
    state.get('lifecycleState') === 'active' &&
    state.get('sessionUuid') === scope.sessionId
  );
}

/** Recent targets belong to the current login and are removed by logout cleanup. */
@Injectable({ providedIn: 'root' })
export class ForwardRecentTargetsService {
  private readonly appState = new AppStateStorage();
  private readonly lifecycle = inject(SessionLifecycleService);
  private pending: Promise<unknown> = Promise.resolve();

  read(scope = this.lifecycle.capture()): Promise<number[]> {
    return this.pending
      .then(async () => {
        if (scope.sessionId === null || !this.lifecycle.isCurrent(scope))
          return [];
        let recent: number[];
        if (isTauri()) {
          recent = await tauriInvoke<number[]>('forward_recent_targets_read', {
            expectedSessionUuid: scope.sessionId,
          });
        } else {
          const state = await this.appState.readSnapshot();
          recent = ownsHistory(state, scope)
            ? validThreadIds(state.get(RECENT_TARGETS_KEY))
            : [];
        }
        return this.lifecycle.isCurrent(scope) ? recent : [];
      })
      .catch(() => []);
  }

  remember(
    threadIds: readonly number[],
    scope = this.lifecycle.capture(),
  ): Promise<number[]> {
    // Snapshot caller-owned input before queueing, without duplicating native policy.
    const selected = [...threadIds];
    const next = this.pending.then(async () => {
      if (scope.sessionId === null || !this.lifecycle.isCurrent(scope))
        return [];
      const recent = isTauri()
        ? await tauriInvoke<number[]>('forward_recent_targets_remember', {
            expectedSessionUuid: scope.sessionId,
            threadIds: selected,
          })
        : await this.appState.update((state) => {
            if (!this.lifecycle.isCurrent(scope) || !ownsHistory(state, scope))
              return [];
            const recent = validThreadIds([
              ...selected,
              ...validThreadIds(state.get(RECENT_TARGETS_KEY)),
            ]);
            state.set(RECENT_TARGETS_KEY, recent);
            return recent;
          });
      return this.lifecycle.isCurrent(scope) ? recent : [];
    });
    // Optional history must not fail a completed forward or poison subsequent writes.
    this.pending = next.catch(() => undefined);
    return next.catch(() => []);
  }
}
