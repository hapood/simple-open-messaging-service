import { of, firstValueFrom } from 'rxjs';
import { MsgService } from './message.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import type { StoredNonMediaSendContent } from './send-outbox-storage';

describe('non-media sending intent execution', () => {
  it.each([
    { item: { type: 'PURE_TEXT', content: '{"text":"hello","quote":{"seq":9}}' }, endpoint: 'send-message', payload: { contentType: 'PURE_TEXT', content: '{"text":"hello","quote":{"seq":9}}' } },
    { item: { type: 'LINK', generationId: 'generation' }, endpoint: 'send-message', payload: { contentType: 'LINK', content: 'generation' } },
    { item: { type: 'CONTACT_CARD', target: { account: 'peer', namespaceId: 2, profileRev: 3 } }, endpoint: 'send-contact-card', payload: { target: { account: 'peer', namespaceId: 2, profileRev: 3 } } },
    { item: { type: 'FORWARD', sourceMessages: [{ threadId: 8, seq: 9 }], mode: 'HISTORY' }, endpoint: 'send-forward', payload: { sourceMessages: [{ threadId: 8, seq: 9 }], mode: 'HISTORY' } },
  ])('preserves the original $item.type request and idempotency identity', async ({ item, endpoint, payload }) => {
    const post = vi.fn(() => of({ code: 0 }));
    const service = new MsgService({ post } as never, new SessionLifecycleService());
    await firstValueFrom(service.sendIntent({ clientMessageId: 'original-cid', threadId: 7, item: item as StoredNonMediaSendContent }));
    expect(post).toHaveBeenCalledWith(expect.stringContaining(`/${endpoint}`), {
      clientMessageId: 'original-cid', threadId: 7, ...payload,
    }, expect.anything());
  });
});
