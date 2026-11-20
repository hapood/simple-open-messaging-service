import { NativeUploadService } from './native-upload.service';
import { NativeUploadTransport } from './native-upload-transport.service';
import { of, Subject } from 'rxjs';

const resource = { path: 'content://provider/document/1', name: 'one.jpg', mimeType: 'image/jpeg', size: 10 };
const identity = { clientMessageId: 'cid', partId: 'part', position: 0, intent: 'IMAGE' as const };

describe('native upload invocation ownership', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes the original resource and stable identity directly to the Channel transport', async () => {
    const upload = vi.spyOn(NativeUploadTransport.prototype, 'upload').mockReturnValue(of({ code: 0, message: 'success', data: {} }));
    const service = new NativeUploadService();
    const progress = vi.fn();
    await expect(service.upload(resource, identity, progress)).resolves.toMatchObject({ code: 0 });
    expect(upload).toHaveBeenCalledWith(resource, identity, progress);
  });

  it('rejects concurrent execution for the same part and cancels its subscription', async () => {
    const source = new Subject<any>();
    vi.spyOn(NativeUploadTransport.prototype, 'upload').mockReturnValue(source);
    const service = new NativeUploadService();
    const running = service.upload(resource, identity);
    const stopped = expect(running).rejects.toThrow();
    await expect(service.upload(resource, identity)).rejects.toThrow('already in progress');
    service.cancel(identity.clientMessageId, identity.partId);
    await stopped;
    expect(source.observed).toBe(false);
  });

  it('keeps equal part IDs in different tasks independent', async () => {
    const first = new Subject<any>();
    const second = new Subject<any>();
    vi.spyOn(NativeUploadTransport.prototype, 'upload').mockReturnValueOnce(first).mockReturnValueOnce(second);
    const service = new NativeUploadService();
    const one = service.upload(resource, identity);
    const rejected = expect(one).rejects.toThrow();
    const two = service.upload(resource, { ...identity, clientMessageId: 'other' });
    service.cancel(identity.clientMessageId, identity.partId);
    await rejected;
    expect(second.observed).toBe(true);
    second.next({ code: 0 });
    await expect(two).resolves.toEqual({ code: 0 });
  });
});
