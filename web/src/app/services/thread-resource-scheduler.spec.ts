import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreadResourceScheduler, type MetaRoundOutcome } from './thread-resource-scheduler';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup() {
  const deps = {
    runTombPage: vi.fn(async () => ({ status: 'DONE' as const })),
    runMetaPage: vi.fn<() => Promise<MetaRoundOutcome>>(async () => ({ status: 'DONE' })),
    readTombProgress: vi.fn(async () => ({ target: 10, hwm: 0, cutoff: 5 })),
  };
  return { deps, scheduler: new ThreadResourceScheduler(deps) };
}
afterEach(() => vi.useRealTimers());
describe('single-login resource tasks', () => {
  it('retains one successor arriving during a run without concurrent execution', async () => {
    const { deps, scheduler } = setup();
    let finish!: (value: MetaRoundOutcome) => void;
    deps.runMetaPage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    scheduler.wakeMeta(42);
    scheduler.wakeMeta(42);
    scheduler.wakeMeta(42);
    expect(deps.runMetaPage).toHaveBeenCalledTimes(1);
    finish({ status: 'DONE' });
    await settle();
    expect(deps.runMetaPage).toHaveBeenCalledTimes(2);
  });

  it('limits meta admission to two independent tasks', async () => {
    const { deps, scheduler } = setup();
    const finishes: Array<(value: MetaRoundOutcome) => void> = [];
    deps.runMetaPage.mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    for (let id = 1; id <= 6; id++) scheduler.wakeMeta(id);
    expect(deps.runMetaPage).toHaveBeenCalledTimes(2);
    finishes[0]({ status: 'DONE' });
    await settle();
    expect(deps.runMetaPage).toHaveBeenCalledTimes(3);
  });

  it('does not repeat a stalled network page until persisted progress changes', async () => {
    const readTombProgress = vi.fn(async () => ({ target: 10, hwm: 0, cutoff: 5 }));
    const runTombPage = vi.fn(async () => ({ status: 'CUTOFF_STALLED' as const, target: 10, cutoff: 5 }));
    const scheduler = new ThreadResourceScheduler({ readTombProgress, runTombPage,
      runMetaPage: async () => ({ status: 'DONE' }) });
    scheduler.wakeTomb(42);
    await settle();
    scheduler.wakeTomb(42);
    await settle();
    expect(runTombPage).toHaveBeenCalledTimes(1);
    readTombProgress.mockResolvedValue({ target: 10, hwm: 0, cutoff: 6 });
    scheduler.wakeTomb(42);
    await settle();
    expect(runTombPage).toHaveBeenCalledTimes(2);
  });

  it('keeps incoming tasks under retry backoff rather than bypassing it', async () => {
    vi.useFakeTimers();
    const { deps, scheduler } = setup();
    deps.runMetaPage.mockRejectedValueOnce(new Error('offline'));
    scheduler.wakeMeta(42);
    await settle();
    scheduler.wakeMeta(42);
    expect(deps.runMetaPage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(deps.runMetaPage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.runMetaPage).toHaveBeenCalledTimes(2);
  });
});
