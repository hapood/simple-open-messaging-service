import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { LayoutMode, LayoutService } from './layout.service';
import { NavStateMachineService } from './nav-state.service';
import { PopupType, RouteService } from './route.service';

describe('RouteService adaptive account surfaces', () => {
  let mode: jasmine.Spy<() => LayoutMode>;
  let nav: {
    dialogs: ReturnType<typeof signal<any[]>>;
    paneStack: ReturnType<typeof signal<any[]>>;
    pushPane: jasmine.Spy;
    openSettingsCategory: jasmine.Spy;
    clearSettingsCategories: jasmine.Spy;
  };
  let service: RouteService;

  beforeEach(() => {
    mode = jasmine.createSpy('mode').and.returnValue('compact');
    nav = {
      dialogs: signal([]),
      paneStack: signal([]),
      pushPane: jasmine.createSpy('pushPane').and.returnValue(42),
      openSettingsCategory: jasmine.createSpy('openSettingsCategory'),
      clearSettingsCategories: jasmine.createSpy('clearSettingsCategories'),
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
    const popupDlg = spyOn(service, 'popupDlg').and.returnValue({ id: 42 });
    service.openProfile();

    expect(popupDlg).toHaveBeenCalledOnceWith(PopupType.EDIT_PROFILE);
  });

  for (const layoutMode of ['medium', 'expanded'] as const) {
    it(`opens Profile in a dialog in ${layoutMode} mode`, () => {
      mode.and.returnValue(layoutMode);
      const popupDlg = spyOn(service, 'popupDlg').and.returnValue({ id: 42 });

      service.openProfile();

      expect(popupDlg).toHaveBeenCalledOnceWith(PopupType.EDIT_PROFILE);
    });
  }

  it('opens Settings as a drill-down page dialog and preserves a category deep-link in compact mode', () => {
    service.openSettings('devices');

    expect(nav.clearSettingsCategories).toHaveBeenCalledTimes(1);
    expect(nav.pushPane).toHaveBeenCalledOnceWith(
      jasmine.objectContaining({
        kind: 'dialog',
        component: jasmine.any(Function),
        presentation: 'page',
        desktopSize: 'standard',
        settingsDrilldown: true,
        onResult: jasmine.any(Function),
      }),
    );
    expect(nav.openSettingsCategory).toHaveBeenCalledOnceWith('devices');
  });

  for (const layoutMode of ['medium', 'expanded'] as const) {
    it(`opens Settings in a wide dialog in ${layoutMode} mode`, () => {
      mode.and.returnValue(layoutMode);

      service.openSettings('devices');

      expect(nav.pushPane).toHaveBeenCalledOnceWith({
        kind: 'dialog',
        component: jasmine.any(Function),
        presentation: 'page',
        desktopSize: 'wide',
        inputs: { initialCategoryId: 'devices' },
      });
    });
  }

  it('classifies workflow, confirmation, and viewer dialogs explicitly', () => {
    service.popupDlg(PopupType.FRIEND_REQUESTS, { initialTab: 'add' });
    expect(nav.pushPane).toHaveBeenCalledWith(
      jasmine.objectContaining({
        presentation: 'page',
        desktopSize: 'standard',
      }),
    );

    service.popupDlg(PopupType.CONFIRM, { messageKey: 'common.confirm' });
    expect(nav.pushPane).toHaveBeenCalledWith(
      jasmine.objectContaining({
        presentation: 'modal',
        desktopSize: 'standard',
      }),
    );

    service.popupDlg(PopupType.AVATAR_EDITOR, {
      file: new File([], 'avatar.png'),
    });
    expect(nav.pushPane).toHaveBeenCalledWith(
      jasmine.objectContaining({
        presentation: 'viewer',
        desktopSize: 'standard',
      }),
    );
  });

  it('opens upload details as a page dialog and preserves its thread scope', () => {
    service.popupDlg(PopupType.UPLOAD_DETAIL, { threadId: 17 });

    expect(nav.pushPane).toHaveBeenCalledOnceWith(
      jasmine.objectContaining({
        kind: 'dialog',
        presentation: 'page',
        desktopSize: 'standard',
        inputs: { threadId: 17 },
      }),
    );
  });
});
