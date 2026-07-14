// Unit tests for MediaProbeScheduler — the scroll-driven SSE backstop. Plain class, so it is tested with
// `new` + two mocked deps + jasmine.clock (no TestBed, no kernel, no DOM).
import { of } from 'rxjs';
import { MediaProbeScheduler } from './media-probe-scheduler';
import type { MsgService } from '../../services/message.service';
import type { MessageRepository } from '../../services/message-repository.service';

describe('MediaProbeScheduler', () => {
  let queryMediaStatus: jasmine.Spy;
  let markBatch: jasmine.Spy;
  let sched: MediaProbeScheduler;

  beforeEach(() => {
    jasmine.clock().install();
    queryMediaStatus = jasmine.createSpy('queryMediaStatus');
    markBatch = jasmine.createSpy('markMediaStatusBatch').and.resolveTo(undefined);
    sched = new MediaProbeScheduler(
      { queryMediaStatus } as unknown as MsgService,
      { markMediaStatusBatch: markBatch } as unknown as MessageRepository,
    );
  });
  afterEach(() => jasmine.clock().uninstall());

  it('schedule is a no-op when nothing is tracked', () => {
    sched.schedule(1);
    jasmine.clock().tick(6000);
    expect(queryMediaStatus).not.toHaveBeenCalled();
  });

  it('schedule debounces 300ms on the first run (never-run ⇒ ≥5s ⇒ 300 debounce)', () => {
    sched.track(5, true);
    sched.schedule(1);
    expect(queryMediaStatus).not.toHaveBeenCalled();
    jasmine.clock().tick(299);
    expect(queryMediaStatus).not.toHaveBeenCalled();
    jasmine.clock().tick(1); // 300
    expect(queryMediaStatus).toHaveBeenCalledWith(1, [5]);
  });

  it('track add/remove drives which seqs get probed', () => {
    sched.track(5, true);
    sched.track(6, true);
    sched.track(5, false); // 5 reached a terminal → drop it
    sched.schedule(1);
    jasmine.clock().tick(300);
    expect(queryMediaStatus).toHaveBeenCalledWith(1, [6]);
  });

  it('run probes the backend + applies terminals via markMediaStatusBatch', async () => {
    queryMediaStatus.and.returnValue(of({ code: 0, data: { statuses: [{ seq: 5, status: 'ready', sv: 7 }] } }));
    sched.track(5, true);
    await sched.run(1);
    expect(queryMediaStatus).toHaveBeenCalledWith(1, [5]);
    expect(markBatch).toHaveBeenCalledWith(1, [{ seq: 5, status: 'ready', sv: 7 }]);
  });

  it('run is a no-op on threadId 0', async () => {
    sched.track(5, true);
    await sched.run(0);
    expect(queryMediaStatus).not.toHaveBeenCalled();
  });

  it('run skips markBatch when res.code !== 0', async () => {
    queryMediaStatus.and.returnValue(of({ code: 1, data: undefined }));
    sched.track(5, true);
    await sched.run(1);
    expect(markBatch).not.toHaveBeenCalled();
  });

  it('run swallows a network throw (no crash, no markBatch)', async () => {
    queryMediaStatus.and.throwError('network');
    sched.track(5, true);
    await expectAsync(sched.run(1)).toBeResolved();
    expect(markBatch).not.toHaveBeenCalled();
  });

  it('destroy cancels a pending probe', () => {
    sched.track(5, true);
    sched.schedule(1);
    sched.destroy();
    jasmine.clock().tick(6000);
    expect(queryMediaStatus).not.toHaveBeenCalled();
  });
});
