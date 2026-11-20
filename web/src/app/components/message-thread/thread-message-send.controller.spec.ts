import { ThreadMessageSendController } from './thread-message-send.controller';
import type { MessageThreadAdapter } from './message-thread-adapter';
import type { ThreadSendOutbox } from '../../services/thread-send-outbox.service';

describe('durable non-media sending', () => {
  function setup() {
    const outbox = { enqueue: vi.fn().mockResolvedValue(undefined), retry: vi.fn(), setPhase: vi.fn(), confirm: vi.fn() };
    const adapter = { sendIntent: vi.fn().mockResolvedValue({ code: 0 }) };
    const host = { threadId: () => 7, consumeQuote: () => null, newClientMessageId: () => 'cid', surfaceFailure: vi.fn() };
    const controller = new ThreadMessageSendController(adapter as unknown as MessageThreadAdapter, host, outbox as unknown as ThreadSendOutbox);
    return { outbox, adapter, host, controller };
  }

  it('waits for persistence before starting network work', async () => {
    const { outbox, adapter, controller } = setup();
    let commit!: () => void;
    outbox.enqueue.mockReturnValue(new Promise<void>(resolve => { commit = resolve; }));
    const sending = controller.text('hello');
    expect(adapter.sendIntent).not.toHaveBeenCalled();
    commit();
    await sending;
    expect(adapter.sendIntent).toHaveBeenCalledWith(outbox.enqueue.mock.calls[0][0]);
    expect(outbox.setPhase).not.toHaveBeenCalledWith('cid', 'accepted');
    expect(outbox.confirm).toHaveBeenCalledWith(7, ['cid']);
  });

  it('does not send when admission fails', async () => {
    const { outbox, adapter, controller } = setup();
    outbox.enqueue.mockRejectedValue(new Error('quota'));
    await expect(controller.text('hello')).rejects.toThrow('quota');
    expect(adapter.sendIntent).not.toHaveBeenCalled();
  });

  it('executes a stored link request without reading it again or creating another record', async () => {
    const { outbox, adapter, controller } = setup();
    const task = { clientMessageId: 'original', threadId: 7, item: { type: 'LINK', generationId: 'generation' } };
    await controller.execute({ ...task, item: { type: 'LINK', generationId: 'generation' } });
    expect(outbox.retry).not.toHaveBeenCalled();
    expect(adapter.sendIntent).toHaveBeenCalledWith(task);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('keeps a network failure retryable', async () => {
    const { outbox, adapter, controller } = setup();
    adapter.sendIntent.mockRejectedValue(new Error('offline'));
    await controller.text('hello');
    expect(outbox.setPhase).toHaveBeenCalledWith('cid', 'failed');
  });
});
