import { BehaviorSubject, Subject, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  ProfileResolutionService,
  type ResolvedProfile,
} from './profile-resolution.service';
import type { UserService } from './user.service';
import type { WebsocketService } from './websocket.service';
import { SessionLifecycleService } from './session-lifecycle.service';

describe('ProfileResolutionService', () => {
  it('broadcasts message profiles and discards completions from an ended session', async () => {
    type ReadyResponse = {
      code: number;
      data: { status: 'READY'; profile: ResolvedProfile };
    };
    const first = new Subject<ReadyResponse>();
    const second = new Subject<ReadyResponse>();
    const startProfileResolution = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const realtime = {
      eventSubject: new Subject<unknown>(),
      helloReady$: new BehaviorSubject(true),
      helloGeneration$: new BehaviorSubject(1),
    } as unknown as WebsocketService;
    const lifecycle = new SessionLifecycleService();
    const service = new ProfileResolutionService(
      { startProfileResolution } as unknown as UserService,
      realtime,
      lifecycle,
    );
    const notice = vi.fn();
    service.resolved$.subscribe(notice);
    const selector = { threadId: 9, messageSeq: 2 };
    const old = firstValueFrom(service.resolve(selector)).catch(
      (error: Error) => error.message,
    );
    await vi.waitFor(() =>
      expect(startProfileResolution).toHaveBeenCalledTimes(1),
    );
    lifecycle.endSession();
    const current = firstValueFrom(service.resolve(selector));
    await vi.waitFor(() =>
      expect(startProfileResolution).toHaveBeenCalledTimes(2),
    );
    const profile = {
      account: 'peer',
      domain: 'bravo.test',
      rev: 3,
      name: 'Peer',
      bio: '',
      avatarBase64: null,
    };
    first.next({ code: 0, data: { status: 'READY', profile } });
    first.complete();
    expect(await old).toBe('resolution session ended');
    expect(notice).not.toHaveBeenCalled();
    second.next({ code: 0, data: { status: 'READY', profile } });
    second.complete();
    await current;
    expect(notice).toHaveBeenCalledExactlyOnceWith({ selector, profile });
  });

  it('normalizes and coalesces group-member selectors while preserving bio', async () => {
    const startProfileResolution = vi.fn().mockReturnValue(
      of({
        code: 0,
        message: 'ok',
        data: {
          status: 'READY',
          profile: {
            account: 'alice',
            domain: 'remote.test',
            rev: 3,
            name: 'Alice',
            bio: 'About Alice',
            avatarBase64: null,
          },
        },
      }),
    );
    const realtime = {
      eventSubject: new Subject<unknown>(),
      helloReady$: new BehaviorSubject(true),
      helloGeneration$: new BehaviorSubject(1),
    } as unknown as WebsocketService;
    const service = new ProfileResolutionService(
      { startProfileResolution } as unknown as UserService,
      realtime,
    );

    const selector = {
      threadId: 7,
      memberAccount: ' Alice ',
      memberDomain: ' REMOTE.TEST ',
    };
    const resolved = vi.fn();
    service.resolved$.subscribe(resolved);
    const [first, second] = await Promise.all([
      firstValueFrom(service.resolve(selector)),
      firstValueFrom(service.resolve(selector)),
    ]);

    expect(startProfileResolution).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledOnce();
    expect(startProfileResolution).toHaveBeenCalledWith({
      threadId: 7,
      memberAccount: 'alice',
      memberDomain: 'remote.test',
    });
    expect(first.bio).toBe('About Alice');
    expect(second).toEqual(first);
  });
});
