import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ThreadRepository } from './thread-store.service';
import { WebdbService } from './webdb.service';
import { UserService } from './user.service';
import { WebsocketService } from './websocket.service';
import { MessageRepository } from './message-repository.service';
import { MemberProfileRepository } from './member-profile-store.service';
import { SessionLifecycleService } from './session-lifecycle.service';

/**
 * The open-thread UI state is persisted fire-and-forget, so the account cache
 * teardown rejection must never escape as an unhandled rejection; real storage
 * errors still propagate to the caller.
 */
describe('ThreadRepository.setOpenThread teardown tolerance', () => {
  let drainThreadMisc: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    drainThreadMisc = vi.fn().mockName('drainThreadMisc');
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ThreadRepository,
        {
          provide: WebdbService,
          useValue: {
            drainThreadMisc,
            profileWake$: new Subject(),
            workerFailed$: new Subject(),
            threadFeedCommitted$: new Subject(),
            threadAttentionProjectionCommitted$: new Subject(),
            groupMetaCommitted$: new Subject(),
            stateFeedCommitted$: new Subject(),
            resolveProfileDemand: vi
              .fn()
              .mockRejectedValue(new Error('no profile in this fixture')),
            getProfileAvatarBlob: vi.fn().mockResolvedValue(null),
          },
        },
        {
          provide: UserService,
          useValue: {
            sessionUserId: signal<number | null>(null),
            requestCacheRebuild: vi.fn(),
          },
        },
        {
          provide: WebsocketService,
          useValue: {
            eventSubject: new Subject(),
            connect: vi.fn(),
            disconnect: vi.fn(),
          },
        },
        { provide: MessageRepository, useValue: { slotsChanged$: new Subject() } },
        {
          provide: MemberProfileRepository,
          useValue: { notifyChanged: vi.fn() },
        },
        {
          provide: SessionLifecycleService,
          useValue: { ended$: new Subject(), invalidated$: new Subject() },
        },
      ],
    });
  });

  it('resolves when clearing the open thread during account cache teardown', async () => {
    drainThreadMisc.mockRejectedValue(
      new Error('account cache lifetime expired'),
    );
    const repo = TestBed.inject(ThreadRepository);
    await expect(repo.setOpenThread(undefined)).resolves.toBeUndefined();
    expect(drainThreadMisc).toHaveBeenCalledWith(null, null, null);
  });

  it('resolves when opening a thread during account cache teardown', async () => {
    drainThreadMisc.mockRejectedValue(
      new Error('account cache lifetime expired'),
    );
    const repo = TestBed.inject(ThreadRepository);
    await expect(repo.setOpenThread(7)).resolves.toBeUndefined();
    expect(drainThreadMisc).toHaveBeenCalledWith(7, '0', 0);
  });

  it('propagates storage failures that are not cache teardown', async () => {
    drainThreadMisc.mockRejectedValue(new Error('QuExceededError'));
    const repo = TestBed.inject(ThreadRepository);
    await expect(repo.setOpenThread(undefined)).rejects.toThrow(
      'QuExceededError',
    );
  });
});
