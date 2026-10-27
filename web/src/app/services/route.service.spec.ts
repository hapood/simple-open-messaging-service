import type { Mock } from 'vitest';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { LayoutMode, LayoutService } from './layout.service';
import { NavStateMachineService } from './nav-state.service';
import { PopupType, RouteService } from './route.service';

describe('RouteService adaptive account surfaces', () => {
  let mode: Mock;
  let nav: {
    dialogs: ReturnType<typeof signal<any[]>>;
    paneStack: ReturnType<typeof signal<any[]>>;
    pushPane: Mock;
    openSettingsCategory: Mock;
    clearSettingsCategories: Mock;
  };
  let service: RouteService;

  beforeEach(() => {
    mode = vi.fn().mockName('mode').mockReturnValue('compact');
    nav = {
      dialogs: signal([]),
      paneStack: signal([]),
      pushPane: vi.fn().mockName('pushPane').mockReturnValue(42),
      openSettingsCategory: vi.fn().mockName('openSettingsCategory'),
      clearSettingsCategories: vi.fn().mockName('clearSettingsCategories'),
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        RouteService,
        { provide: Router, useValue: {} },
        { provide: LayoutService, useValue: { mode } },
        { provide: NavStateMachineService, useValue: nav },
      ],
    });
    service = TestBed.inject(RouteService);
  });

  it('opens Profile as a page dialog in compact mode', () => {
    const popupDlg = vi.spyOn(service, 'popupDlg').mockReturnValue({ id: 42 });
    service.openProfile();

    expect(popupDlg).toHaveBeenCalledTimes(1);

    expect(popupDlg).toHaveBeenCalledWith(PopupType.EDIT_PROFILE);
  });

  for (const layoutMode of ['medium', 'expanded'] as const) {
    it(`opens Profile in a dialog in ${layoutMode} mode`, () => {
      mode.mockReturnValue(layoutMode);
      const popupDlg = vi
        .spyOn(service, 'popupDlg')
        .mockReturnValue({ id: 42 });

      service.openProfile();

      expect(popupDlg).toHaveBeenCalledTimes(1);

      expect(popupDlg).toHaveBeenCalledWith(PopupType.EDIT_PROFILE);
    });
  }

  it('opens Settings as a drill-down page dialog and preserves a category deep-link in compact mode', () => {
    service.openSettings('devices');

    expect(nav.clearSettingsCategories).toHaveBeenCalledTimes(1);
    expect(nav.pushPane).toHaveBeenCalledTimes(1);
    expect(nav.pushPane).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'dialog',
        component: expect.any(Function),
        presentation: 'page',
        desktopSize: 'standard',
        settingsDrilldown: true,
        onResult: expect.any(Function),
      }),
    );
    expect(nav.openSettingsCategory).toHaveBeenCalledTimes(1);
    expect(nav.openSettingsCategory).toHaveBeenCalledWith('devices');
  });

  for (const layoutMode of ['medium', 'expanded'] as const) {
    it(`opens Settings in a wide dialog in ${layoutMode} mode`, () => {
      mode.mockReturnValue(layoutMode);

      service.openSettings('devices');

      expect(nav.pushPane).toHaveBeenCalledTimes(1);

      expect(nav.pushPane).toHaveBeenCalledWith({
        kind: 'dialog',
        component: expect.any(Function),
        presentation: 'page',
        desktopSize: 'wide',
        desktopHeight: 'workspace',
        inputs: { initialCategoryId: 'devices' },
      });
    });
  }

  it('classifies workflow, confirmation, and viewer dialogs explicitly', () => {
    service.popupDlg(PopupType.FRIEND_REQUESTS, { initialTab: 'add' });
    expect(nav.pushPane).toHaveBeenCalledWith(
      expect.objectContaining({
        presentation: 'page',
        desktopSize: 'standard',
        desktopHeight: 'workspace',
      }),
    );

    service.popupDlg(PopupType.CONFIRM, { messageKey: 'common.confirm' });
    expect(nav.pushPane).toHaveBeenCalledWith(
      expect.objectContaining({
        presentation: 'modal',
        desktopSize: 'standard',
        desktopHeight: 'content',
      }),
    );

    service.popupDlg(PopupType.AVATAR_EDITOR, {
      file: new File([], 'avatar.png'),
    });
    expect(nav.pushPane).toHaveBeenCalledWith(
      expect.objectContaining({
        presentation: 'viewer',
        desktopSize: 'standard',
      }),
    );
  });

  it('opens upload details as a page dialog and preserves its thread scope', () => {
    service.popupDlg(PopupType.UPLOAD_DETAIL, { threadId: 17 });

    expect(nav.pushPane).toHaveBeenCalledTimes(1);

    expect(nav.pushPane).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'dialog',
        presentation: 'page',
        desktopSize: 'standard',
        inputs: { threadId: 17 },
      }),
    );
  });

  it('opens contact identity inside the scoped chatbox', () => {
    service.popupDlg(
      PopupType.CONTACT_IDENTITY,
      {
        identity: {
          account: 'alice',
          domain: 'local',
          namespaceId: 0,
          name: 'Alice',
          bio: '',
          profile: {
            account: 'alice',
            publisherNamespaceId: 0,
            profileNamespaceId: 0,
            rev: 1,
            linked: true,
          },
        },
      },
      undefined,
      { scopeThreadId: 17 },
    );

    expect(nav.pushPane).toHaveBeenCalledWith(
      expect.objectContaining({
        presentation: 'chatbox',
        scopeThreadId: 17,
      }),
    );
  });

  it('opens group announcement with disableClose=true and chatbox presentation', () => {
    service.popupDlg(
      PopupType.GROUP_ANNOUNCEMENT,
      {
        threadId: 2,
        feedId: '1',
        text: 'Important announcement',
      },
      undefined,
      { scopeThreadId: 2 },
    );

    expect(nav.pushPane).toHaveBeenCalledWith(
      expect.objectContaining({
        presentation: 'chatbox',
        scopeThreadId: 2,
        disableClose: true,
      }),
    );
  });

  it('opens the shared forwarding workspace as a wide desktop dialog', () => {
    service.popupDlg(PopupType.FORWARD, {
      kind: 'NATIVE_SHARE',
      sharedText: 'https://example.com',
    });

    expect(nav.pushPane).toHaveBeenCalledTimes(1);

    expect(nav.pushPane).toHaveBeenCalledWith(
      expect.objectContaining({
        presentation: 'page',
        desktopSize: 'wide',
      }),
    );
    const pane = vi.mocked(nav.pushPane).mock.lastCall![0] as {
      component?: {
        ɵcmp?: {
          dependencies?: readonly unknown[] | (() => readonly unknown[]);
        };
      };
    };
    expect(pane.component?.ɵcmp).toBeDefined();
    const dependencies = pane.component?.ɵcmp?.dependencies;
    const resolvedDependencies =
      typeof dependencies === 'function' ? dependencies() : dependencies;
    expect(resolvedDependencies?.every(Boolean)).toBe(true);
  });
});
