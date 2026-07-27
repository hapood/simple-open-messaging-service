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
    setTopSection: jasmine.Spy;
    openSettingsCategory: jasmine.Spy;
  };
  let service: RouteService;

  beforeEach(() => {
    mode = jasmine.createSpy('mode').and.returnValue('compact');
    nav = {
      dialogs: signal([]),
      paneStack: signal([]),
      pushPane: jasmine.createSpy('pushPane').and.returnValue(42),
      setTopSection: jasmine.createSpy('setTopSection'),
      openSettingsCategory: jasmine.createSpy('openSettingsCategory'),
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

  it('opens Profile inline in compact mode', () => {
    service.openProfile();

    expect(nav.setTopSection).toHaveBeenCalledOnceWith('profile');
    expect(nav.pushPane).not.toHaveBeenCalled();
  });

  for (const layoutMode of ['medium', 'expanded'] as const) {
    it(`opens Profile in a dialog in ${layoutMode} mode`, () => {
      mode.and.returnValue(layoutMode);
      const popupDlg = spyOn(service, 'popupDlg').and.returnValue({ id: 42 });

      service.openProfile();

      expect(popupDlg).toHaveBeenCalledOnceWith(PopupType.EDIT_PROFILE);
      expect(nav.setTopSection).not.toHaveBeenCalled();
    });
  }

  it('opens Settings inline and preserves a category deep-link in compact mode', () => {
    service.openSettings('devices');

    expect(nav.setTopSection).toHaveBeenCalledOnceWith('settings');
    expect(nav.openSettingsCategory).toHaveBeenCalledOnceWith('devices');
    expect(nav.pushPane).not.toHaveBeenCalled();
  });

  for (const layoutMode of ['medium', 'expanded'] as const) {
    it(`opens Settings in a wide dialog in ${layoutMode} mode`, () => {
      mode.and.returnValue(layoutMode);

      service.openSettings('devices');

      expect(nav.pushPane).toHaveBeenCalledOnceWith({
        kind: 'dialog',
        component: jasmine.any(Function),
        wide: true,
        inputs: { initialCategoryId: 'devices' },
      });
      expect(nav.setTopSection).not.toHaveBeenCalled();
    });
  }
});
