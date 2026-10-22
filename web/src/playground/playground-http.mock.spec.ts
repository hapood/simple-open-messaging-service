import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { playgroundHttp } from './playground-http.mock';

describe('playground HTTP boundary', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([playgroundHttp])),
        provideHttpClientTesting(),
      ],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('answers mounted media probes locally', async () => {
    const result = await firstValueFrom(
      TestBed.inject(HttpClient).post('/api/v1/media-status', {
        threadId: 2,
        seqs: [1, 8],
      }),
    );
    expect(result).toEqual({
      code: 0,
      message: 'ok',
      data: {
        statuses: [
          { seq: 1, status: 'ready' },
          { seq: 8, status: 'ready' },
        ],
      },
    });
    TestBed.inject(HttpTestingController).expectNone('/api/v1/media-status');
  });

  it('returns inline avatar bytes without uploading to a backend', async () => {
    const data = new FormData();
    data.append('file', new Blob(['avatar'], { type: 'image/png' }));
    const result = await firstValueFrom(
      TestBed.inject(HttpClient).post<{ data: { avatar: string } }>(
        '/api/v1/upload/avatar',
        data,
      ),
    );
    expect(result.data.avatar).toBe('data:image/png;base64,YXZhdGFy');
    TestBed.inject(HttpTestingController).expectNone('/api/v1/upload/avatar');
  });

  it('fails unknown API calls locally instead of silently reaching the lab', async () => {
    await expect(
      firstValueFrom(TestBed.inject(HttpClient).post('/api/v1/unmocked', {})),
    ).rejects.toMatchObject({ status: 501 });
    TestBed.inject(HttpTestingController).expectNone('/api/v1/unmocked');
  });
});
