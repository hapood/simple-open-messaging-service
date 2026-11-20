import { firstValueFrom } from 'rxjs';
import { NativeUploadTransport } from './native-upload-transport.service';
import type { tauriInvoke } from './runtime';

const resource = { path: '/original/file', name: 'file.bin', mimeType: 'application/octet-stream', size: 100 };
const identity = { clientMessageId: 'cid', partId: 'part', position: 0, intent: 'FILE' as const };

describe('native upload invocation channels', () => {
  it('binds progress to the invocation and returns its response', async () => {
    let receive!: (event: { loaded: number; total: number }) => void;
    const channel = {};
    let finish!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const transport = new NativeUploadTransport({ invoke: invoke as typeof tauriInvoke, channel: handler => { receive = handler; return channel; } });
    const progress = vi.fn();
    const pending = firstValueFrom(transport.upload(resource, identity, progress));
    expect(invoke).toHaveBeenCalledWith('upload_stream_file', expect.objectContaining({ progress: channel, path: resource.path }));
    receive({ loaded: 20, total: 100 });
    expect(progress).toHaveBeenCalledWith(20, 100);
    finish({ code: 0 });
    await expect(pending).resolves.toEqual({ code: 0 });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('ignores late channel messages after cancellation', () => {
    let receive!: (event: { loaded: number; total: number }) => void;
    const invoke = vi.fn((command: string) => command === 'cancel_upload' ? Promise.resolve() : new Promise(() => {}));
    const transport = new NativeUploadTransport({ invoke: invoke as typeof tauriInvoke, channel: handler => { receive = handler; return {}; } });
    const progress = vi.fn();
    const subscription = transport.upload(resource, identity, progress).subscribe();
    subscription.unsubscribe();
    receive({ loaded: 50, total: 100 });
    expect(progress).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenLastCalledWith('cancel_upload', { clientMessageId: 'cid' });
  });

  it('reports missing Channel support without launching native work', async () => {
    const invoke = vi.fn();
    const transport = new NativeUploadTransport({ invoke: invoke as typeof tauriInvoke, channel: () => { throw new Error('Channel unavailable'); } });
    await expect(firstValueFrom(transport.upload(resource, identity))).rejects.toThrow('Channel unavailable');
    expect(invoke).not.toHaveBeenCalled();
  });
});
