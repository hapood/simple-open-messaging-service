import { StableReadTracker } from './stable-read-tracker';

describe('StableReadTracker', () => {
  beforeEach(() => jasmine.clock().install());
  afterEach(() => jasmine.clock().uninstall());

  it('commits the initial fully-visible HWM on start, then waits for 200ms of scroll quiet', () => {
    const commit = jasmine.createSpy('commit');
    const tracker = new StableReadTracker(commit);

    tracker.noteFullyVisible([10, 11]);
    jasmine.clock().tick(300);
    expect(commit).not.toHaveBeenCalled();
    tracker.start();
    expect(commit).toHaveBeenCalledOnceWith(11);

    tracker.noteFullyVisible([9, 12]);
    tracker.noteScroll();
    jasmine.clock().tick(199);
    expect(commit).toHaveBeenCalledTimes(1);
    jasmine.clock().tick(1);
    expect(commit).toHaveBeenCalledWith(12);
  });

  it('reset discards an unstable candidate', () => {
    const commit = jasmine.createSpy('commit');
    const tracker = new StableReadTracker(commit);
    tracker.noteFullyVisible([7]);
    tracker.start();
    commit.calls.reset();
    tracker.noteFullyVisible([8]);
    jasmine.clock().tick(100);
    tracker.reset();
    jasmine.clock().tick(200);
    expect(commit).not.toHaveBeenCalled();
  });

  it('flush commits the latest fully-visible HWM before teardown', () => {
    const commit = jasmine.createSpy('commit');
    const tracker = new StableReadTracker(commit);
    tracker.noteFullyVisible([4]);
    tracker.start();
    tracker.noteFullyVisible([6]);

    tracker.flush();

    expect(commit.calls.allArgs()).toEqual([[4], [6]]);
  });
});
