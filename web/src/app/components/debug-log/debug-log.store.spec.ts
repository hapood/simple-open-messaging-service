import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { fromJsEntry } from './debug-log-merge';
import { DebugLogStore } from './debug-log.store';

describe('DebugLogStore', () => {
  let store: DebugLogStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), DebugLogStore],
    });
    store = TestBed.inject(DebugLogStore);
  });

  it('applies source, level, and search filters together', () => {
    store.reconcile([
      fromJsEntry({
        ts: '2026-07-21T06:00:00.000Z',
        level: 'info',
        text: 'connected',
      }),
      fromJsEntry({
        ts: '2026-07-21T06:00:01.000Z',
        level: 'error',
        text: 'TIMEOUT',
      }),
    ]);
    store.minLevel.set('error');
    store.query.set('timeout');

    expect(store.filtered().map((line) => line.text)).toEqual(['TIMEOUT']);
  });

  it('starts a non-destructive session and restores retained history', () => {
    store.reconcile([
      fromJsEntry({
        ts: '2026-07-21T06:00:00.000Z',
        level: 'info',
        text: 'old',
      }),
    ]);
    store.startSession();
    expect(store.filtered()).toEqual([]);

    store.reconcile([
      fromJsEntry({
        ts: '2026-07-21T06:00:00.000Z',
        level: 'info',
        text: 'old',
      }),
      fromJsEntry({
        ts: '2026-07-21T06:00:01.000Z',
        level: 'info',
        text: 'new',
      }),
    ]);
    expect(store.filtered().map((line) => line.text)).toEqual(['new']);

    store.restoreHistory();
    expect(store.filtered().map((line) => line.text)).toEqual(['old', 'new']);
  });
});
