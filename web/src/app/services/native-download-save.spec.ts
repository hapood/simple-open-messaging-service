import { TestBed } from '@angular/core/testing';
import { DownloadService, type DownloadTaskEvent } from './download.service';
import { MediaSaveService, MediaSaveCancelledError } from './media-save.service';

describe('native download and save integration', () => {
  afterEach(() => { delete window.__TAURI_INTERNALS__; });

  function setup() {
    window.__TAURI_INTERNALS__ = {};
    const save = vi.fn(async (): Promise<void> => undefined);
    TestBed.configureTestingModule({ providers: [
      { provide: MediaSaveService, useValue: { save } },
    ] });
    const service = TestBed.inject(DownloadService);
    const updates: DownloadTaskEvent[] = [];
    const subscription = service.watchAll().subscribe(event => updates.push(event));
    const request = { threadId: 1, path: '/uploads/file', filename: 'file.webp', mimeType: 'application/octet-stream' };
    return { service, save, updates, subscription, request };
  }

  it('streams the remote media into the platform destination without a cache artifact', async () => {
    const h = setup();
    await h.service.download(h.request);
    expect(h.save).toHaveBeenCalledWith(h.request, expect.any(String));
    expect(h.updates.at(-1)).toMatchObject({ type: 'upsert', task: { phase: 'completed', loaded: 0, total: null } });
    h.subscription.unsubscribe();
  });

  it('removes a cancelled picker task instead of showing failure or completion', async () => {
    const h = setup();
    h.save.mockRejectedValue(new MediaSaveCancelledError());
    await h.service.download(h.request);
    expect(h.updates.at(-1)?.type).toBe('remove');
    expect(h.updates.some(event => event.type === 'upsert' && ['failed', 'completed'].includes(event.task.phase))).toBe(false);
    h.subscription.unsubscribe();
  });

  it('retains save failures without claiming a cache copy completed', async () => {
    const h = setup();
    h.save.mockRejectedValue(new Error('permission denied'));
    await expect(h.service.download(h.request)).rejects.toThrow('permission denied');
    expect(h.updates.at(-1)).toMatchObject({ type: 'upsert', task: { phase: 'failed', error: 'permission denied' } });
    h.subscription.unsubscribe();
  });
});
