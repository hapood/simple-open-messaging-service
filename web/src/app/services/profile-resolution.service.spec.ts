import { BehaviorSubject, Subject, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ProfileResolutionService } from './profile-resolution.service';
import type { UserService } from './user.service';
import type { WebsocketService } from './websocket.service';

describe('ProfileResolutionService', () => {
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
    const [first, second] = await Promise.all([
      firstValueFrom(service.resolve(selector)),
      firstValueFrom(service.resolve(selector)),
    ]);

    expect(startProfileResolution).toHaveBeenCalledTimes(1);
    expect(startProfileResolution).toHaveBeenCalledWith({
      threadId: 7,
      memberAccount: 'alice',
      memberDomain: 'remote.test',
    });
    expect(first.bio).toBe('About Alice');
    expect(second).toEqual(first);
  });
});
