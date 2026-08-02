import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LocalDataManagementService } from './local-data-management.service';
import { NativeMediaCacheService } from './native-media-cache.service';
import { NavStateMachineService } from './nav-state.service';
import { WebdbService } from './webdb.service';

describe('LocalDataManagementService', () => {
  let service: LocalDataManagementService;
  let nav: jasmine.SpyObj<NavStateMachineService>;
  let webdb: jasmine.SpyObj<WebdbService>;
  let media: jasmine.SpyObj<NativeMediaCacheService> & {
    available: boolean;
    info: () => { limitMb: number; usedBytes: number };
  };

  beforeEach(() => {
    nav = jasmine.createSpyObj<NavStateMachineService>('NavState', [
      'returnToThreadList',
    ]);
    webdb = jasmine.createSpyObj<WebdbService>('WebdbService', [
      'countCachedMessages',
      'recreateMessageCache',
    ]);
    media = Object.assign(
      jasmine.createSpyObj<NativeMediaCacheService>('NativeMediaCache', [
        'refresh',
        'clear',
      ]),
      {
        available: true,
        info: () => ({ limitMb: 512, usedBytes: 4096 }),
      },
    );
    webdb.countCachedMessages.and.resolveTo(37);
    webdb.recreateMessageCache.and.resolveTo();
    media.refresh.and.resolveTo();
    media.clear.and.resolveTo();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        LocalDataManagementService,
        { provide: NavStateMachineService, useValue: nav },
        { provide: WebdbService, useValue: webdb },
        { provide: NativeMediaCacheService, useValue: media },
      ],
    });
    service = TestBed.inject(LocalDataManagementService);
  });

  it('reports message rows and native media bytes', async () => {
    await expectAsync(service.stats()).toBeResolvedTo({
      messageCount: 37,
      mediaBytes: 4096,
    });
    expect(media.refresh).toHaveBeenCalled();
  });

  it('returns to the thread list before replacing messages, then clears media', async () => {
    const order: string[] = [];
    nav.returnToThreadList.and.callFake(() => order.push('route'));
    webdb.recreateMessageCache.and.callFake(async () => {
      order.push('messages');
    });
    media.clear.and.callFake(async () => {
      order.push('media');
    });

    await service.clearChatCache();

    expect(order).toEqual(['route', 'messages', 'media']);
  });

  it('does not clear media when message database recreation fails', async () => {
    webdb.recreateMessageCache.and.rejectWith(new Error('busy'));

    await expectAsync(service.clearChatCache()).toBeRejectedWithError('busy');

    expect(nav.returnToThreadList).toHaveBeenCalled();
    expect(media.clear).not.toHaveBeenCalled();
  });
});
