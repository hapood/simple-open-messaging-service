import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
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
});
