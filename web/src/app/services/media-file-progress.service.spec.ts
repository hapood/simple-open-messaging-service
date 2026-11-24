import { MediaFileProgressService } from './media-file-progress.service';
import type { AlbumMedia } from '../components/message-cards/chat-item';

const media: AlbumMedia = {
  kind: 'image',
  w: 100,
  h: 100,
  src: '/uploads/msg-assets/aa/aa/' + 'a'.repeat(64) + '?threadId=7&seq=8',
  msgId: 8,
  size: 100,
  name: 'photo.jpg',
  mimeType: 'image/jpeg',
  senderName: null,
  sentAt: null,
};

describe('MediaFileProgressService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects missing authorization without fetching or claiming readiness', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const next = vi.fn();
    const error = vi.fn();
    new MediaFileProgressService()
      .observe({
        ...media,
        src: media.src.split('?')[0],
      })
      .subscribe({ next, error });
    expect(error).toHaveBeenCalledExactlyOnceWith(
      new Error('Managed media requires a canonical authorized URL'),
    );
    expect(next).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'downloading', loaded: 1, total: 10 },
    { status: 'ready', loaded: 10, total: 10 },
    { status: 'downloading', loaded: 1, total: 10, bytesPerSecond: null },
    { status: 'downloading', loaded: 1, total: 10, bytesPerSecond: -1 },
    { status: 'downloading', loaded: 1, total: 10, bytesPerSecond: '12' },
    { status: 'pending', loaded: 0, total: null, bytesPerSecond: 0 },
    { status: 'ready', loaded: 10, total: 10, bytesPerSecond: 12 },
  ])('rejects an invalid speed contract: %j', async (progress) => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: MEDIA_FILE_DOWNLOAD_PROGRESS\ndata: ${JSON.stringify(progress)}\n\n`,
                  ),
                );
              },
              cancel,
            }),
          ),
      ),
    );
    const next = vi.fn();
    const error = await new Promise<unknown>((resolve) => {
      new MediaFileProgressService()
        .observe(media)
        .subscribe({ next, error: resolve });
    });
    expect(error).toEqual(new Error('Invalid media progress'));
    expect(next).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('observes the digest stream independently and closes on readiness without a completion query', async () => {
    const sources: ReadableStreamDefaultController<Uint8Array>[] = [];
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const fetch = vi.fn((_url: string, _init?: RequestInit) => {
      const cancel = vi.fn();
      cancels.push(cancel);
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              sources.push(controller);
            },
            cancel,
          }),
        ),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const service = new MediaFileProgressService();
    const next = vi.fn();
    const first = service.observe(media).subscribe();
    const second = service.observe(media).subscribe(next);
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancels[0]).toHaveBeenCalledOnce();
    expect(cancels[1]).not.toHaveBeenCalled();
    sources[1].enqueue(
      new TextEncoder().encode(
        'event: MEDIA_FILE_DOWNLOAD_PROGRESS\ndata: {"status":"ready","loaded":100,"total":100,"bytesPerSecond":null}\n\n',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(next).toHaveBeenCalledExactlyOnceWith({
      status: 'ready',
      loaded: 100,
      total: 100,
      bytesPerSecond: null,
    });
    expect(second.closed).toBe(true);
    expect(cancels[1]).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe(
      '/api/v1/message/media-file-progress?threadId=7&seq=8&digest=' +
        'a'.repeat(64),
    );
  });
});
