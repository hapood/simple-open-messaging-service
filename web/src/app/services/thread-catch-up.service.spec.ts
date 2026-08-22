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

  it('posts integer feed cursors and returns one pinned page', async () => {
    const pending = service.catchUp(7, 12);
    const req = http.expectOne('/api/v1/thread-sync/catch-up');
    expect(req.request.body).toEqual({ after: 7, through: 12, take: 200 });
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
});
