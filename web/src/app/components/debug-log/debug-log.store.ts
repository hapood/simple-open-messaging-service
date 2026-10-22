import { computed, Injectable, signal } from '@angular/core';
import {
  compileLogSearch,
  type IdentifiedLine,
  type LogLevel,
  type MergedLine,
  reconcileSnapshot,
} from './debug-log-merge';

@Injectable()
export class DebugLogStore {
  private readonly maxView = 1500;
  private readonly levelRank: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    log: 3,
    debug: 4,
  };
  private nextId = 1;

  readonly lines = signal<IdentifiedLine[]>([]);
  readonly showJs = signal(true);
  readonly showRust = signal(true);
  readonly showKotlin = signal(true);
  readonly minLevel = signal<LogLevel>('debug');
  readonly query = signal('');
  readonly caseSensitive = signal(false);
  readonly regexMode = signal(false);
  readonly selectedId = signal<number | null>(null);
  readonly sessionMinId = signal<number | null>(null);

  readonly searchMatcher = computed(() =>
    compileLogSearch(this.query(), this.regexMode(), this.caseSensitive()),
  );

  readonly filtered = computed(() => {
    const min = this.levelRank[this.minLevel()];
    const query = this.query();
    const matcher = this.searchMatcher();
    const sessionMinId = this.sessionMinId();
    const wantJs = this.showJs();
    const wantRust = this.showRust();
    const wantKotlin = this.showKotlin();
    return this.lines().filter((line) => {
      if (sessionMinId !== null && line.id < sessionMinId) return false;
      if (!wantJs && line.source === 'js') return false;
      if (!wantRust && line.source === 'rust') return false;
      if (!wantKotlin && line.source === 'kotlin') return false;
      if (this.levelRank[line.level] > min) return false;
      return !query || (!!matcher.regex && matcher.regex.test(line.raw));
    });
  });

  readonly selectedIndex = computed(() => {
    const selectedId = this.selectedId();
    if (selectedId === null) return -1;
    return this.filtered().findIndex((line) => line.id === selectedId);
  });

  reconcile(snapshot: readonly MergedLine[]): number {
    const result = reconcileSnapshot(
      this.lines(),
      snapshot,
      this.nextId,
      this.maxView,
    );
    this.nextId = result.nextId;
    this.lines.set(result.lines);
    return result.added;
  }

  startSession(): void {
    this.sessionMinId.set(this.nextId);
    this.selectedId.set(null);
  }

  restoreHistory(): void {
    this.sessionMinId.set(null);
  }
}
