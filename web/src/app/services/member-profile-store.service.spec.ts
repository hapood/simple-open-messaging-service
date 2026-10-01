import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { MemberProfileRepository } from './member-profile-store.service';
import { WebdbService, type ProfileWake } from './webdb.service';
import { WebdbStorage } from './webdb-storage';
import { SessionLifecycleService } from './session-lifecycle.service';

describe('MemberProfileRepository invalidation', () => {
  it('refreshes queried rosters after resolution, including empty name searches', async () => {
    const wakes = new Subject<ProfileWake>();
    const ended = new Subject<void>();
    const query = vi.fn().mockResolvedValue([]);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WebdbService,
          useValue: { profileWake$: wakes, queryGroupMembers: query },
        },
        { provide: SessionLifecycleService, useValue: { ended$: ended } },
      ],
    });
    const repo = TestBed.inject(MemberProfileRepository);
    const changed = vi.fn();
    repo.changed$.subscribe(changed);
    await repo.queryPage(42, { take: 50, search: 'Alice New' });
    await repo.queryPage(43, { take: 50 });
    const key = { account: 'alice', domain: 'local', namespaceId: 0, rev: 4 };
    wakes.next({ event: 'PROFILE_UNAVAILABLE', key, reason: 'PENDING' });
    expect(changed).not.toHaveBeenCalled();
    wakes.next({ event: 'PROFILE_AVAILABLE', key });
    expect(changed).not.toHaveBeenCalled();
    wakes.next({ event: 'PROFILE_AVAILABLE', key, evidence: {
      type: 'GROUP_META', threadId: 42, profileRev: 4,
      subject: { type: 'MEMBER', account: 'alice', domain: 'local' },
    } });
    expect(changed).toHaveBeenCalledWith([42]);
    wakes.next({ event: 'PROFILE_AVAILABLE', key, evidence: {
      type: 'MESSAGE_AUTHOR', threadId: 43, messageSeq: 12, rev: 4,
    } });
    expect(changed).toHaveBeenCalledWith([43]);
    ended.next();
    changed.mockClear();
    wakes.next({ event: 'PROFILE_AVAILABLE', key, evidence: {
      type: 'MESSAGE_AUTHOR', threadId: 42, messageSeq: 12, rev: 4,
    } });
    expect(changed).not.toHaveBeenCalled();
  });

  it('forwards the worker commit event without notifying again for READY or cache hits', async () => {
    const profile = {
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      profileRev: 4,
      name: 'Alice New',
      bio: '',
      avatar: '',
    };
    let first = true;
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage(request: { id: number }) {
        queueMicrotask(() => {
          if (first) {
            first = false;
            worker.onmessage?.({
              data: {
                type: 'profile-wake',
                wake: {
                  event: 'PROFILE_AVAILABLE',
                  key: {
                    account: 'alice',
                    domain: 'local',
                    namespaceId: 0,
                    rev: 4,
                  },
                },
              },
            } as MessageEvent);
          }
          worker.onmessage?.({
            data: {
              id: request.id,
              ok: true,
              result: { status: 'READY', profile },
            },
          } as MessageEvent);
        });
      },
      terminate() {},
    };
    const db = new WebdbStorage(() => worker as unknown as Worker);
    await db.openForUser('994202');
    const notified = vi.fn();
    db.profileWake$.subscribe(notified);
    try {
      const selector = {
        type: 'EXACT' as const,
        account: 'alice',
        domain: 'local',
        rev: 4,
      };
      await db.resolveProfileEvidence(selector);
      expect(notified).toHaveBeenCalledTimes(1);
      await db.resolveProfileEvidence(selector);
      await db.applyProfileEvent('PROFILE_AVAILABLE', {
        account: 'alice',
        domain: 'local',
        namespaceId: 0,
        rev: 4,
      });
      expect(notified).toHaveBeenCalledTimes(1);
    } finally {
      await db.closeAndDelete('994202');
    }
  });

  it('announces a committed snapshot only after readers can see it', async () => {
    const db = new WebdbStorage(() => null);
    await db.openForUser('994201');
    const reads: Promise<unknown>[] = [];
    db.profileWake$.subscribe((wake) => {
      if (wake.event === 'PROFILE_AVAILABLE')
        reads.push(
          db.getProfile({
            account: wake.key.account,
            domain: wake.key.domain,
            namespaceId: wake.key.namespaceId,
            profileRev: wake.key.rev,
          }),
        );
    });
    try {
      await db.commitResolvedProfile({
        account: 'alice',
        domain: 'local',
        namespaceId: 0,
        rev: 4,
        name: 'Alice New',
        bio: '',
        avatarBase64: null,
      });
      expect(reads).toHaveLength(1);
      expect(await reads[0]).toMatchObject({
        name: 'Alice New',
        profileRev: 4,
      });
      await db.commitResolvedProfile({
        account: 'alice',
        domain: 'local',
        namespaceId: 0,
        rev: 4,
        name: 'Alice New',
        bio: '',
        avatarBase64: null,
      });
      expect(reads).toHaveLength(1);
      await expect(
        db.commitResolvedProfile({
          account: 'alice',
          domain: 'local',
          namespaceId: 0,
          rev: 4,
          name: 'Conflicting',
          bio: '',
          avatarBase64: null,
        }),
      ).rejects.toThrow('conflicting cached profile revision');
      expect(reads).toHaveLength(1);
    } finally {
      await db.closeAndDelete('994201');
    }
  });
});
