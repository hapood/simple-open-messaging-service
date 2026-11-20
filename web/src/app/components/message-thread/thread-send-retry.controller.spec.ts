import { ThreadSendRetryController } from './thread-send-retry.controller';
import type { ThreadSendOutbox } from '../../services/thread-send-outbox.service';

describe('durable request retry routing', () => {
  function setup(item: unknown) {
    const task = { clientMessageId: 'original', threadId: 7, item };
    const outbox = { retry: vi.fn().mockResolvedValue(task), setPhase: vi.fn() };
    const handlers = { message: vi.fn().mockResolvedValue(undefined), webAttachment: vi.fn().mockResolvedValue(undefined), nativeAttachment: vi.fn().mockResolvedValue(undefined) };
    return { task, outbox, handlers, controller: new ThreadSendRetryController(outbox as unknown as ThreadSendOutbox, handlers) };
  }

  it('routes contacts as contacts rather than text', async () => {
    const { controller, handlers, task } = setup({ type: 'CONTACT_CARD', target: { account: 'peer', namespaceId: 2, profileRev: 3 } });
    await controller.retry('original');
    expect(handlers.message).toHaveBeenCalledExactlyOnceWith(task);
    expect(handlers.webAttachment).not.toHaveBeenCalled();
  });

  it('preserves ordered gallery resources and original MIME', async () => {
    const files = [1, 2].map(n => ({ partId: `part-${n}`, path: `runtime-${n}`, size: n, name: `${n}.bin`, mimeType: 'application/x-custom', intent: 'FILE' }));
    const { controller, handlers, task } = setup({ type: 'GALLERY', files });
    await controller.retry('original');
    expect(handlers.webAttachment).toHaveBeenCalledExactlyOnceWith(task);

  });

  it('does not infer the native platform from the path shape', async () => {
    const { controller, handlers, task } = setup({ type: 'AUDIO', file: { partId: 'part', path: 'voice.m4a', name: 'voice.m4a', mimeType: 'audio/mp4' } });
    await controller.retry('original');
    expect(handlers.webAttachment).toHaveBeenCalledExactlyOnceWith(task);
    expect(handlers.nativeAttachment).not.toHaveBeenCalled();
  });

  it('keeps a failed execution retryable', async () => {
    const { controller, handlers, outbox } = setup({ type: 'LINK', generationId: 'generation' });
    handlers.message.mockRejectedValue(new Error('offline'));
    await expect(controller.retry('original')).rejects.toThrow('offline');
    expect(outbox.setPhase).toHaveBeenCalledWith('original', 'failed');
  });
});
