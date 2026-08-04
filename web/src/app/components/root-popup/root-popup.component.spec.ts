import {
  ApplicationRef,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LayoutService } from '../../services/layout.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { type DlgInfo, RouteService } from '../../services/route.service';
import { RootPopupComponent } from './root-popup.component';

describe('RootPopupComponent presentation policy', () => {
  const dialogs = signal<DlgInfo[]>([]);
  const isAtLeastMedium = signal(false);
  const nav = {
    paneStack: signal<readonly { kind: string }[]>([]),
    back: jasmine.createSpy('back'),
  };
  let component: RootPopupComponent;

  beforeEach(() => {
    dialogs.set([]);
    isAtLeastMedium.set(false);
    nav.paneStack.set([]);
    nav.back.calls.reset();

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: LayoutService, useValue: { isAtLeastMedium } },
        { provide: NavStateMachineService, useValue: nav },
      ],
    });

    component = TestBed.runInInjectionContext(
      () =>
        new RootPopupComponent({ dlgList: dialogs } as unknown as RouteService),
    );
  });

  function info(presentation: DlgInfo['presentation']): DlgInfo {
    return {
      id: 1,
      component: RootPopupComponent,
      presentation,
      desktopSize: 'standard',
    };
  }

  it('maps compact surfaces to their declared policy and every medium surface to a desktop card', () => {
    expect((component as any).dialogState(info('page'))).toBe('page');
    expect((component as any).dialogState(info('modal'))).toBe('modal');
    expect((component as any).dialogState(info('viewer'))).toBe('viewer');
    expect((component as any).dialogState(info('chatbox'))).toBe('modal');

    isAtLeastMedium.set(true);

    expect((component as any).dialogState(info('page'))).toBe('desktop');
    expect((component as any).dialogState(info('modal'))).toBe('desktop');
    expect((component as any).dialogState(info('viewer'))).toBe('desktop');
    expect((component as any).dialogState(info('chatbox'))).toBe('modal');
  });

  it('leaves chatbox dialogs to the conversation-local host', () => {
    dialogs.set([info('modal'), { ...info('chatbox'), id: 2 }]);
    TestBed.inject(ApplicationRef).tick();

    expect(
      (component as any).rootDialogs().map((dialog: DlgInfo) => dialog.id),
    ).toEqual([1]);
  });

  it('retains instant backdrop close only for a compact page after its entry is removed', () => {
    dialogs.set([info('page')]);
    TestBed.inject(ApplicationRef).tick();
    expect((component as any).instantBackdropHide()).toBeTrue();

    dialogs.set([]);
    TestBed.inject(ApplicationRef).tick();
    expect((component as any).instantBackdropHide()).toBeTrue();

    dialogs.set([info('modal')]);
    TestBed.inject(ApplicationRef).tick();
    expect((component as any).instantBackdropHide()).toBeFalse();
  });

  it('clears browser text selection when the top dialog changes', () => {
    const removeAllRanges = jasmine.createSpy('removeAllRanges');
    spyOn(document, 'getSelection').and.returnValue({
      removeAllRanges,
    } as unknown as Selection);

    dialogs.set([info('page')]);
    TestBed.inject(ApplicationRef).tick();
    expect(removeAllRanges).not.toHaveBeenCalled();

    dialogs.set([{ ...info('page'), id: 2 }]);
    TestBed.inject(ApplicationRef).tick();
    expect(removeAllRanges).toHaveBeenCalledTimes(1);

    dialogs.set([]);
    TestBed.inject(ApplicationRef).tick();
    expect(removeAllRanges).toHaveBeenCalledTimes(2);
  });

  it('routes Escape through the nav stack only when a dialog is topmost', () => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
    });
    nav.paneStack.set([{ kind: 'dialog' }]);

    component.onEscape(event);

    expect(event.defaultPrevented).toBeTrue();
    expect(nav.back).toHaveBeenCalled();
  });
});
