import { firstValueFrom, Subject } from 'rxjs';
import { MsgService } from './message.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import type { StandardResponse } from './model';
import type { ThreadAliasApplied } from '../../../../shared/thread-attention';

describe('alias write ordering', () => {
  it('serializes one thread while allowing other threads to proceed', async () => {
    const responses = Array.from(
      { length: 3 },
      () => new Subject<StandardResponse<ThreadAliasApplied>>(),
    );
    const post = vi
      .fn()
      .mockReturnValueOnce(responses[0])
      .mockReturnValueOnce(responses[1])
      .mockReturnValueOnce(responses[2]);
    const service = new MsgService(
      { post } as never,
      new SessionLifecycleService(),
    );
    const first = firstValueFrom(
      service.setAlias({ threadId: 1, alias: 'First' }),
    );
    const second = firstValueFrom(
      service.setAlias({ threadId: 1, alias: 'Second' }),
    );
    const independent = firstValueFrom(
      service.setAlias({ threadId: 2, alias: 'Other' }),
    );
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls.map((call) => call[1].alias)).toEqual([
      'First',
      'Other',
    ]);
    responses[0].next({
      code: 0,
      message: '',
      data: { threadId: 1, threadFeedId: 1, alias: 'First' },
    });
    await first;
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls[2][1].alias).toBe('Second');
    responses[1].next({ code: 0, message: '' });
    responses[2].next({ code: 0, message: '' });
    await Promise.all([second, independent]);
  });

  it('does not send a queued edit under a replacement account session', async () => {
    const response = new Subject<StandardResponse<ThreadAliasApplied>>();
    const post = vi.fn().mockReturnValue(response);
    const lifecycle = new SessionLifecycleService();
    const service = new MsgService({ post } as never, lifecycle);
    const first = firstValueFrom(
      service.setAlias({ threadId: 1, alias: 'First' }),
    );
    const second = firstValueFrom(
      service.setAlias({ threadId: 1, alias: 'Queued' }),
    );
    const rejected = expect(second).rejects.toThrow('expired session');
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    lifecycle.invalidateSession();
    response.next({ code: 0, message: '' });
    await first;
    await rejected;
    expect(post).toHaveBeenCalledTimes(1);
  });
});
