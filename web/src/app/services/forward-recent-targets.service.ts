import { Injectable, inject } from '@angular/core';
import { PreferenceStore } from './preference-store.service';

const RECENT_TARGETS_KEY = 'forward-recent-threads';
const MAX_RECENT_TARGETS = 12;

function validThreadIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((id): id is number => Number.isSafeInteger(id) && id > 0),
    ),
  ].slice(0, MAX_RECENT_TARGETS);
}

/** Account-scoped forwarding history, independent of the signed-in message cache lifecycle. */
@Injectable({ providedIn: 'root' })
export class ForwardRecentTargetsService {
  private readonly preferences = inject(PreferenceStore);
  private readonly pending = new Map<number, Promise<number[]>>();

  read(userId: number): Promise<number[]> {
    let current = this.pending.get(userId);
    if (!current) {
      current = this.preferences
        .get<unknown>(`account:${userId}`, RECENT_TARGETS_KEY)
        .then(validThreadIds);
      this.pending.set(userId, current);
    }
    return current;
  }

  remember(userId: number, threadIds: readonly number[]): Promise<number[]> {
    const selected = validThreadIds(threadIds);
    const next = this.read(userId).then(async (previous) => {
      const recent = validThreadIds([...selected, ...previous]);
      try {
        await this.preferences.set(
          `account:${userId}`,
          RECENT_TARGETS_KEY,
          recent,
        );
      } catch {
        // Forwarding succeeds even when optional recent-target storage fails.
      }
      return recent;
    });
    this.pending.set(userId, next);
    return next;
  }
}
