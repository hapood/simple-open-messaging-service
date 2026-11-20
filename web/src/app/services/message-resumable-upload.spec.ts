import { HttpResponse, HttpEventType, HttpHeaders } from '@angular/common/http';
import { firstValueFrom, of } from 'rxjs';
import { WebUploadTransport } from './web-upload-transport';

const identity = {
  clientMessageId: 'message',
  partId: 'part',
  position: 0,
  intent: 'FILE' as const,
};
const state = (
  status = 'PENDING',
  offset: unknown = 0,
  phase: string | null | undefined = status === 'PENDING'
    ? 'UPLOADING'
    : undefined,
) => ({
  id: '1',
  totalBytes: 4,
  status,
  ...(phase === undefined ? {} : { phase }),
  offset,
  chunkSize: 4,
});
const envelope = (data: unknown) => of({ code: 0, message: 'success', data });

function harness(
  initial: unknown = state(),
  authoritative: unknown = initial,
  retry: unknown = state(),
) {
  const post = vi.fn((url: string) => {
    if (url.endsWith('/init')) return envelope(initial);
    if (url.endsWith('/retry')) return envelope(retry);
    return envelope({ ...state('COMPLETED', 4), result: { digest: 'done' } });
  });
  const get = vi.fn(() => envelope(authoritative));
  const put = vi.fn((_url: string, _body: Blob, _options: unknown) =>
    of(new HttpResponse({ body: { code: 0, message: 'success', data: state('PENDING', 4) } })),
  );
  const service = new WebUploadTransport({ post, get, put } as never);
  const file = new File(['test'], 'test.txt');
  return {
    post,
    get,
    put,
    run: (progress?: (loaded: number, total: number) => void) => firstValueFrom(service.upload(file, identity, progress)),
  };
}

describe('resumable upload contract', () => {
  it('continues a pending upload at the authoritative offset without retry', async () => {
    const h = harness(state(), state('PENDING', 2));
    await expect(h.run()).resolves.toMatchObject({ data: { digest: 'done' } });
    expect(h.post.mock.calls.map(([url]) => url.split('/').pop())).toEqual(['init', 'complete']);
    expect(h.put.mock.calls[0][1].size).toBe(2);
    const options = h.put.mock.calls[0][2] as { headers: HttpHeaders };
    expect(options.headers.get('Content-Range')).toBe('bytes 2-3/4');
  });

  it.each(['0', '01', '-1', '1e3', '9223372036854775808', 'task'])('rejects invalid task id %s before sending chunks', async (id) => {
    const h = harness({ ...state(), id });
    await expect(h.run()).rejects.toThrow('invalid task id');
    expect(h.get).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
  });

  it('reports current-chunk transmission before the response confirms its offset', async () => {
    const h = harness();
    const progress = vi.fn();
    h.put.mockReturnValue(of(
      { type: HttpEventType.UploadProgress, loaded: 2, total: 4 },
      new HttpResponse({ body: { code: 0, message: 'success', data: state('PENDING', 4) } }),
    ) as never);
    await h.run(progress);
    expect(progress).toHaveBeenCalledWith(0, 4);
    expect(progress).toHaveBeenCalledWith(2, 4);
    expect(h.put.mock.calls[0][2]).toMatchObject({ observe: 'events', reportProgress: true });
  });

  it.each([null, undefined, -1, 1.5, 5, '0', NaN])(
    'rejects unknown/invalid writable offset %s',
    async (offset) => {
      const data = state();
      data.offset = offset;
      const h = harness(state(), data);
      await expect(h.run()).rejects.toThrow();
      expect(h.put).not.toHaveBeenCalled();
      expect(h.post).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['FAILED'])(
    'explicitly retries the same %s task once',
    async (status) => {
      const h = harness(
        state(status, null),
        state(status, null),
        state('PENDING', 2),
      );
      await expect(h.run()).resolves.toMatchObject({
        data: { digest: 'done' },
      });
      expect(h.post.mock.calls.map(([url]) => url.split('/').pop())).toEqual([
        'init',
        'retry',
        'complete',
      ]);
      expect(h.post.mock.calls[1][0]).toContain('/1/retry');
      expect(h.put.mock.calls[0][0]).toContain('/1');
      const options = (
        h.put.mock.calls as unknown as [
          string,
          Blob,
          { headers: { get: (key: string) => string } },
        ][]
      )[0][2];
      expect(options.headers.get('Content-Range')).toBe('bytes 2-3/4');
    },
  );

  it.each(['STOPPED', 'UPLOADING', 'COMPLETING'])(
    'rejects the removed %s protocol status',
    async (status) => {
      const h = harness(state(status, null));
      await expect(h.run()).rejects.toThrow();
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.put).not.toHaveBeenCalled();
    },
  );

  it.each([
    state('PENDING', 0, null),
    state('PENDING', 0, 'UNKNOWN'),
    { ...state(), phase: undefined },
    state('FAILED', null, 'UPLOADING'),
    state('FAILED', null, null),
    { ...state('COMPLETED', 4, null), result: { digest: 'done' } },
    { ...state('COMPLETED', 4, 'COMPLETING'), result: { digest: 'done' } },
  ])('rejects missing or inconsistent phase %#', async (data) => {
    const h = harness(data);
    await expect(h.run()).rejects.toThrow('invalid upload state');
    expect(h.put).not.toHaveBeenCalled();
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('does not loop if retry remains failed', async () => {
    const h = harness(
      state('FAILED', null),
      state('FAILED', null),
      state('FAILED', null),
    );
    await expect(h.run()).rejects.toThrow('FAILED');
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.put).not.toHaveBeenCalled();
  });

  it('short circuits completed init and retry results', async () => {
    const completed = {
      ...state('COMPLETED', null),
      result: { digest: 'done' },
    };
    const h = harness(completed);
    await expect(h.run()).resolves.toMatchObject({ data: completed.result });
    expect(h.get).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
    const retry = harness(
      state('FAILED', null),
      state('FAILED', null),
      completed,
    );
    await expect(retry.run()).resolves.toMatchObject({
      data: completed.result,
    });
    expect(retry.post).toHaveBeenCalledTimes(2);
    expect(retry.put).not.toHaveBeenCalled();
  });

  it('completes COMPLETING without requiring an offset or writing', async () => {
    const h = harness(state('PENDING', null, 'COMPLETING'));
    await expect(h.run()).resolves.toMatchObject({ data: { digest: 'done' } });
    expect(h.put).not.toHaveBeenCalled();
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown statuses and missing completed results', async () => {
    for (const status of ['UNKNOWN', 'COMPLETED']) {
      const h = harness(state(status, null));
      await expect(h.run()).rejects.toThrow();
      expect(h.put).not.toHaveBeenCalled();
    }
  });

  it('does not fabricate a chunk acknowledgement offset', async () => {
    const h = harness();
    h.put.mockReturnValue(of(new HttpResponse({ body: { code: 0, message: 'success', data: state('PENDING', null) } })));
    await expect(h.run()).rejects.toThrow();
    expect(h.put).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledTimes(1);
  });
});
