import { StableReadTracker } from './stable-read-tracker';

describe('StableReadTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('commits the initial fully-visible HWM on start, then waits for 200ms of scroll quiet', () => {
    const commit = vi.fn().mockName('commit');
    const tracker = new StableReadTracker(commit);

    tracker.noteFullyVisible([10, 11]);
    vi.advanceTimersByTime(300);
    expect(commit).not.toHaveBeenCalled();
    tracker.start();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(11);

    tracker.noteFullyVisible([9, 12]);
    tracker.noteScroll();
    vi.advanceTimersByTime(199);
    expect(commit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledWith(12);
  });

  it('reset discards an unstable candidate', () => {
    const commit = vi.fn().mockName('commit');
    const tracker = new StableReadTracker(commit);
    tracker.noteFullyVisible([7]);
    tracker.start();
    commit.mockClear();
    tracker.noteFullyVisible([8]);
    vi.advanceTimersByTime(100);
    tracker.reset();
    vi.advanceTimersByTime(200);
    expect(commit).not.toHaveBeenCalled();
  });

  it('flush commits the latest fully-visible HWM before teardown', () => {
    const commit = vi.fn().mockName('commit');
    const tracker = new StableReadTracker(commit);
    tracker.noteFullyVisible([4]);
    tracker.start();
    tracker.noteFullyVisible([6]);

    tracker.flush();

    expect(vi.mocked(commit).mock.calls).toEqual([[4], [6]]);
  });
});
