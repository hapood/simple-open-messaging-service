import { StableReadTracker } from './stable-read-tracker';

describe('StableReadTracker', () => {
  beforeEach(() => jasmine.clock().install());
  afterEach(() => jasmine.clock().uninstall());

  it('waits for 500ms of scroll quiet and commits only the maximum fully-visible seq', () => {
    const commit = jasmine.createSpy('commit');
    const tracker = new StableReadTracker(commit);

    tracker.noteFullyVisible([10, 11]);
    jasmine.clock().tick(300);
    tracker.noteScroll();
    jasmine.clock().tick(499);
    expect(commit).not.toHaveBeenCalled();
    jasmine.clock().tick(1);
    expect(commit).toHaveBeenCalledOnceWith(11);

    tracker.noteFullyVisible([9, 12]);
    jasmine.clock().tick(500);
    expect(commit).toHaveBeenCalledWith(12);
  });

  it('reset discards an unstable candidate', () => {
    const commit = jasmine.createSpy('commit');
    const tracker = new StableReadTracker(commit);
    tracker.noteFullyVisible([7]);
    jasmine.clock().tick(250);
    tracker.reset();
    jasmine.clock().tick(500);
    expect(commit).not.toHaveBeenCalled();
  });
});
