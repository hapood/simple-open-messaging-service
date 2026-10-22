import type { Mock } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LocalDataManagementService } from './local-data-management.service';
import { NativeMediaCacheService } from './native-media-cache.service';
import { NavStateMachineService } from './nav-state.service';
import { WebdbService } from './webdb.service';

describe('LocalDataManagementService', () => {
  let service: LocalDataManagementService;
  let nav: { returnToThreadList: Mock };
  let webdb: { countCachedMessages: Mock; recreateMessageCache: Mock };
  let media: {
    refresh: Mock;
    clear: Mock;
    available: boolean;
    info: () => {
      limitMb: number;
      usedBytes: number;
    };
  };

  beforeEach(() => {
    nav = {
      returnToThreadList: vi.fn().mockName('NavState.returnToThreadList'),
    };
    webdb = {
      countCachedMessages: vi.fn().mockName('WebdbService.countCachedMessages'),
      recreateMessageCache: vi
        .fn()
        .mockName('WebdbService.recreateMessageCache'),
    };
    media = Object.assign(
      {
        refresh: vi.fn().mockName('NativeMediaCache.refresh'),
        clear: vi.fn().mockName('NativeMediaCache.clear'),
      },
      {
        available: true,
        info: () => ({ limitMb: 512, usedBytes: 4096 }),
      },
    );
    webdb.countCachedMessages.mockResolvedValue(37);
    webdb.recreateMessageCache.mockResolvedValue(undefined);
    media.refresh.mockResolvedValue(undefined);
    media.clear.mockResolvedValue(undefined);
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
    await expect(service.stats()).resolves.toEqual({
      messageCount: 37,
      mediaBytes: 4096,
    });
    expect(media.refresh).toHaveBeenCalled();
  });

  it('returns to the thread list before replacing messages, then clears media', async () => {
    const order: string[] = [];
    nav.returnToThreadList.mockImplementation(() => order.push('route'));
    webdb.recreateMessageCache.mockImplementation(async () => {
      order.push('messages');
    });
    media.clear.mockImplementation(async () => {
      order.push('media');
    });

    await service.clearChatCache();

    expect(order).toEqual(['route', 'messages', 'media']);
  });

  it('does not clear media when message database recreation fails', async () => {
    webdb.recreateMessageCache.mockRejectedValue(new Error('busy'));

    await expect(service.clearChatCache()).rejects.toThrowError('busy');

    expect(nav.returnToThreadList).toHaveBeenCalled();
    expect(media.clear).not.toHaveBeenCalled();
  });
});
