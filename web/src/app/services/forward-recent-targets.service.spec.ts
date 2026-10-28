import { TestBed } from '@angular/core/testing';
import { ForwardRecentTargetsService } from './forward-recent-targets.service';
import { PreferenceStore } from './preference-store.service';

describe('ForwardRecentTargetsService', () => {
  let recent: ForwardRecentTargetsService;
  let preferences: PreferenceStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    recent = TestBed.inject(ForwardRecentTargetsService);
    preferences = TestBed.inject(PreferenceStore);
  });

  it('isolates targets by account and filters invalid stored IDs', async () => {
    await preferences.set('account:701', 'forward-recent-threads', [
      4,
      '5',
      4,
      -1,
      8,
    ]);

    expect(await recent.read(701)).toEqual([4, 8]);
    expect(await recent.read(702)).toEqual([]);
  });

  it('serializes confirmations and keeps the most recent twelve unique targets', async () => {
    await Promise.all([
      recent.remember(703, [1, 2]),
      recent.remember(703, [2, 3]),
    ]);
    expect(await recent.read(703)).toEqual([2, 3, 1]);

    await recent.remember(
      703,
      Array.from({ length: 14 }, (_, index) => index + 10),
    );
    expect(await recent.read(703)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 10),
    );
    expect(
      await preferences.get('account:703', 'forward-recent-threads'),
    ).toEqual(Array.from({ length: 12 }, (_, index) => index + 10));
  });
});
