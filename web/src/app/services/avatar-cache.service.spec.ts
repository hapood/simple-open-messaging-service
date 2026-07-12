import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { signal, provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { UserService } from './user.service';
import { WebdbService } from './webdb.service';
import { AvatarRepository } from './avatar-cache.service';

/** Flush microtasks + the macrotask queue so an async getBlob reaches its HttpClient call. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('AvatarRepository', () => {
  let repo: AvatarRepository;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    const sessionProfile = signal<unknown>({ id: 1 });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        AvatarRepository,
        { provide: UserService, useValue: { sessionProfile } },
      ],
    });
    repo = TestBed.inject(AvatarRepository);
    httpMock = TestBed.inject(HttpTestingController);
    // The DB must be open before reads; the session effect may not have ticked yet in-zoneless, so open
    // it imperatively (matches what the effect would do for user 1).
    await TestBed.inject(WebdbService).openForUser('1');
  });

  afterEach(async () => {
    httpMock.verify();
    try {
      await TestBed.inject(WebdbService).closeAndDelete('1');
    } catch {
      /* already closed */
    }
  });

  it('fetches + caches on a miss, then serves from IDB on the next read (no second HTTP)', async () => {
    const path = '/uploads/avatars/x-512.webp';

    const p1 = repo.getBlob('u9', path);
    await flush();
    const req = httpMock.expectOne(path);
    expect(req.request.method).toBe('GET');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['png-bytes'], { type: 'image/webp' }));
    const b1 = await p1;
    expect(await b1!.text()).toBe('png-bytes');

    // Second read: cache hit → served from IDB, NO HTTP request.
    const b2 = await repo.getBlob('u9', path);
    expect(await b2!.text()).toBe('png-bytes');
    httpMock.verify(); // none outstanding (and none was issued)
  });

  it('refresh re-fetches and overwrites the cached blob under the same identity', async () => {
    const p1 = repo.getBlob('g5', '/uploads/avatars/old-512.webp');
    await flush();
    httpMock.expectOne('/uploads/avatars/old-512.webp').flush(new Blob(['old']));
    await p1;

    const tickBefore = repo.refreshTick('g5');
    const p2 = repo.refresh('g5', '/uploads/avatars/new-512.webp');
    await flush();
    httpMock.expectOne('/uploads/avatars/new-512.webp').flush(new Blob(['new']));
    await p2;

    const b = await repo.getBlob('g5', '/uploads/avatars/new-512.webp');
    expect(await b!.text()).toBe('new');
    // refresh bumps the per-identity tick (so mounted components re-resolve) — only for g5.
    expect(repo.refreshTick('g5')).toBe(tickBefore + 1);
    expect(repo.refreshTick('u9')).toBe(0);
  });

  it('returns undefined on a cache miss + fetch failure (graceful — never throws)', async () => {
    const p = repo.getBlob('u9', '/uploads/avatars/missing-512.webp');
    await flush();
    httpMock
      .expectOne('/uploads/avatars/missing-512.webp')
      .flush(new Blob(['not found']), { status: 404, statusText: 'Not Found' });
    await expectAsync(p).toBeResolvedTo(undefined);
  });
});
