import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { vi } from 'vitest';
import { ThreadCatchUpService } from './thread-catch-up.service';

describe('ThreadCatchUpService', () => {
  let service: ThreadCatchUpService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ThreadCatchUpService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(ThreadCatchUpService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('gets integer feed cursors and returns one pinned page', async () => {
    const pending = service.catchUp(7, 12);
    const req = http.expectOne(
      '/api/v1/thread-sync/catch-up?after=7&take=200&through=12',
    );
    expect(req.request.method).toBe('GET');
    req.flush({
      code: 0,
      message: 'ok',
      data: {
        items: [],
        scannedThrough: 12,
        messageFeedEndId: 15,
        hasMore: false,
      },
    });
    await expect(pending).resolves.toEqual({
      items: [],
      scannedThrough: 12,
      messageFeedEndId: 15,
      hasMore: false,
    });
  });

  it('gets tombstones with the same feed query contract', async () => {
    const pending = service.catchUpTombstones(4, 9);
    const req = http.expectOne(
      '/api/v1/thread-sync/tombstones?after=4&take=200&through=9',
    );
    expect(req.request.method).toBe('GET');
    req.flush({
      code: 0,
      message: 'ok',
      data: {
        items: [],
        scannedThrough: 9,
        tombstoneFeedEndId: 9,
        hasMore: false,
      },
    });
    await expect(pending).resolves.toMatchObject({ scannedThrough: 9 });
  });

  it('warns and returns a resumable message window for code 30006', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = service.catchUp(2);
    http.expectOne('/api/v1/thread-sync/catch-up?after=2&take=200').flush({
      code: 30006,
      message: 'cursor unavailable',
      data: { resumeAfter: 5, resumeBefore: 10 },
    });

    await expect(pending).resolves.toEqual({
      kind: 'cursor-reset',
      resumeAfter: 5,
      resumeBefore: 10,
    });
    expect(warn).toHaveBeenCalledWith(
      '[message-feed] cursor unavailable; resuming from 5 through 9',
    );
  });

  it('warns and returns a resumable tombstone window for code 30006', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = service.catchUpTombstones(4);
    http.expectOne('/api/v1/thread-sync/tombstones?after=4&take=200').flush({
      code: 30006,
      message: 'cursor unavailable',
      data: { resumeAfter: 6, resumeBefore: 8 },
    });

    await expect(pending).resolves.toEqual({
      kind: 'cursor-reset',
      resumeAfter: 6,
      resumeBefore: 8,
    });
    expect(warn).toHaveBeenCalledWith(
      '[tombstone-feed] cursor unavailable; resuming from 6 through 7',
    );
  });
});
