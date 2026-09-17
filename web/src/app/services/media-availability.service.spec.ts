import { Subject, of } from 'rxjs';
import { MediaAvailabilityService } from './media-availability.service';

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('MediaAvailabilityService', () => {
  let events: Subject<unknown>;
  let reconnect: Subject<void>;
  let deleted: Subject<{
    threadId: number;
    deletions: Array<{
      seq: number;
      type: 'USER_RETRACTION' | 'MODERATION_REMOVAL';
    }>;
  }>;
  let snapshots: Subject<{
    code: number;
    data?: {
      statuses: Array<{
        seq: number;
        status: 'pending' | 'downloading' | 'ready' | 'failed';
      }>;
    };
  }>;
  let query: ReturnType<typeof vi.fn>;
  let persist: ReturnType<typeof vi.fn>;
  let service: MediaAvailabilityService;

  beforeEach(() => {
    events = new Subject();
    reconnect = new Subject();
    deleted = new Subject();
    snapshots = new Subject();
    query = vi.fn().mockReturnValue(snapshots);
    persist = vi.fn().mockResolvedValue(true);
    service = new MediaAvailabilityService(
      {
        queryMediaStatus: query,
        relocalizeMedia: vi
          .fn()
          .mockReturnValue(of({ code: 0, data: { status: 'pending' } })),
      } as never,
      { setMediaStatus: persist, deletedLive$: deleted } as never,
      { eventSubject: events, reconnect$: reconnect } as never,
    );
  });

  it('coalesces mounted messages by thread and does not poll', async () => {
    vi.useFakeTimers();
    try {
      query.mockReturnValue(of({ code: 0, data: { statuses: [] } }));
      service.register(7, 2, 'pending');
      service.register(7, 3, 'pending');
      await vi.advanceTimersByTimeAsync(0);

      expect(query).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledWith(7, [2, 3]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(query).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a newer SSE transition win over an older in-flight snapshot', async () => {
    const registration = service.register(7, 2, 'pending');
    await settle();
    events.next({
      event: 'MEDIA_STATUS',
      status: 0,
      data: { threadId: 7, seq: 2, status: 'ready' },
    });
    snapshots.next({
      code: 0,
      data: { statuses: [{ seq: 2, status: 'downloading' }] },
    });
    snapshots.complete();
    await settle();

    expect(registration.status()).toBe('ready');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(7, 2, 'ready');
  });

  it('invalidates a withdrawn registration and ignores late media events', async () => {
    const registration = service.register(7, 2, 'downloading');
    const withdrawn = vi.fn();
    registration.onWithdrawn(withdrawn);
    await settle();

    deleted.next({
      threadId: 7,
      deletions: [{ seq: 2, type: 'USER_RETRACTION' }],
    });
    events.next({
      event: 'MEDIA_STATUS',
      status: 0,
      data: { threadId: 7, seq: 2, status: 'ready' },
    });
    snapshots.next({
      code: 0,
      data: { statuses: [{ seq: 2, status: 'ready' }] },
    });
    snapshots.complete();
    await settle();

    expect(withdrawn).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
  });

  it('queries mounted messages once after reconnect and stops after unmount', async () => {
    snapshots.complete();
    const registration = service.register(7, 2, 'pending');
    await settle();
    expect(query).toHaveBeenCalledTimes(1);

    query.mockReturnValue(of({ code: 0, data: { statuses: [] } }));
    reconnect.next();
    await settle();
    expect(query).toHaveBeenCalledTimes(2);

    registration.unregister();
    reconnect.next();
    await settle();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
