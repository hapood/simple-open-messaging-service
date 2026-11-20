import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeHeaderComponent } from './home-header.component';
import { RouteService, PopupType } from '../../services/route.service';
import { UserService } from '../../services/user.service';
import { ThemeService } from '../../services/theme.service';

describe('HomeHeaderComponent navigation', () => {
  const route = {
    openProfile: vi.fn(),
    openFriendRequests: vi.fn(),
    openSettings: vi.fn(),
    popupDlg: vi.fn(),
  };
  const badge = signal(false);
  beforeEach(() => {
    vi.clearAllMocks();
    badge.set(false);
    TestBed.configureTestingModule({
      providers: [
        { provide: RouteService, useValue: route },
        {
          provide: UserService,
          useValue: { friendReqBadge: badge, sessionProfile: signal(null) },
        },
        {
          provide: ThemeService,
          useValue: { mode: signal('system'), cycleMode: vi.fn() },
        },
      ],
    });
  });
  it('keeps navigation independent of transfer services', () => {
    const header = TestBed.runInInjectionContext(
      () => new HomeHeaderComponent(),
    );
    header.openProfile();
    expect(route.openProfile).toHaveBeenCalledOnce();
    header.openFriendRequests();
    expect(route.openFriendRequests).toHaveBeenCalledWith('add');
    badge.set(true);
    header.openFriendRequests();
    expect(route.openFriendRequests).toHaveBeenLastCalledWith('pending');
  });
  it('preserves overflow actions after removing aggregation', () => {
    const header = TestBed.runInInjectionContext(
      () => new HomeHeaderComponent(),
    );
    header.toggleMoreMenu();
    header.onSelect('settings');
    expect(header.moreMenuOpen()).toBe(false);
    expect(route.openSettings).toHaveBeenCalledOnce();
    header.onSelect('newGroup');
    expect(route.popupDlg).toHaveBeenCalledWith(
      PopupType.NEW_GROUP,
      undefined,
      expect.any(Function),
    );
  });
});
