import { SessionLifecycleService } from './session-lifecycle.service';
import { parseLoginSessionId } from './session/session-identity';
import type { ThreadSendOutbox } from './thread-send-outbox.service';
import { RecordingAdmission, type NativeVoiceReady } from './native-recording-admission.service';

const sessionId = '11111111-1111-4111-8111-111111111111';
let lifecycle: SessionLifecycleService;
const event: NativeVoiceReady = { sessionId, contextId: 1, threadId: 2, clientMessageId: 'cid', partId: 'part', path: '/original/voice.m4a', name: 'voice.m4a', mimeType: 'audio/mp4', size: 100, durationMs: 500 };

describe('native recording admission', () => {
  beforeEach(() => {
    lifecycle = new SessionLifecycleService();
    lifecycle.bindSession(parseLoginSessionId(sessionId));
  });

  it('ignores recordings from a previous login', async () => {
    const enqueue = vi.fn();
    const executeNative = vi.fn();
    const admission = new RecordingAdmission({ executeNative } as never, { enqueue } as never, lifecycle);
    await admission.handle({ ...event, sessionId: 'previous-login' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(executeNative).not.toHaveBeenCalled();
  });

  it('does not start transfer if the session ends while persisting', async () => {
    const executeNative = vi.fn();
    const enqueue = vi.fn(async () => lifecycle.invalidateSession());
    const admission = new RecordingAdmission({ executeNative } as never, { enqueue, get: () => undefined } as never, lifecycle);
    await expect(admission.handle(event)).rejects.toThrow();
    expect(executeNative).not.toHaveBeenCalled();
  });
  it('persists original metadata before starting the unified executor', async () => {
    const order: string[] = [];
    const enqueue = vi.fn(async (_task: Parameters<ThreadSendOutbox['enqueue']>[0]) => { order.push('persist'); });
    const executeNative = vi.fn(async () => { order.push('execute'); });
    const controller = new RecordingAdmission({ executeNative } as never, { enqueue, get: () => undefined } as never, lifecycle);
    await controller.handle(event);
    expect(order).toEqual(['persist', 'execute']);
    expect(enqueue).toHaveBeenCalledWith({ clientMessageId: 'cid', threadId: 2, item: { type: 'AUDIO', file: { path: event.path, partId: 'part', name: event.name, mimeType: event.mimeType, size: 100 } } });
    expect(executeNative).toHaveBeenCalledWith(enqueue.mock.calls[0][0]);
  });

  it('does not upload when durable admission fails', async () => {
    const executeNative = vi.fn();
    const controller = new RecordingAdmission({ executeNative } as never, { get: () => undefined, enqueue: async () => { throw new Error('database unavailable'); } } as never, lifecycle);
    await expect(controller.handle(event)).rejects.toThrow('database unavailable');
    expect(executeNative).not.toHaveBeenCalled();
  });

  it('deduplicates repeated ready notifications without creating another task', async () => {
    let finish!: () => void;
    const enqueue = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const executeNative = vi.fn(async () => undefined);
    const controller = new RecordingAdmission({ executeNative } as never, { enqueue, get: () => undefined } as never, lifecycle);
    const first = controller.handle(event);
    expect(controller.handle(event)).toBe(first);
    finish(); await first;
    expect(enqueue).toHaveBeenCalledOnce();
    expect(executeNative).toHaveBeenCalledOnce();
  });
});
