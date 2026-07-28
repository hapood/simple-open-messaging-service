import { ApplicationRef, Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { FocusTrapFactory } from '@angular/cdk/a11y';
import { Overlay } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { NavStateMachineService, type PaneEntry } from './nav-state.service';
import { TransientOverlayService } from './transient-overlay.service';

@Component({ template: '<button type="button">Close</button>' })
class TestOverlayComponent {}

class TestOverlayService extends TransientOverlayService<Record<string, never>> {
  protected readonly kind = 'gallery' as const;
  protected readonly component = TestOverlayComponent;

  constructor() {
    super();
  }

  open(): void {
    this.pushEntry({});
  }
}

describe('TransientOverlayService accessibility lifecycle', () => {
  const paneStack = signal<readonly PaneEntry[]>([]);
  const keydowns = new Subject<KeyboardEvent>();
  const detachments = new Subject<void>();
  const overlayElement = document.createElement('div');
  const focusInitialElementWhenReady = jasmine.createSpy().and.resolveTo(true);
  const destroyFocusTrap = jasmine.createSpy();
  const disposeOverlay = jasmine.createSpy();
  let nextId = 1;

  const nav = {
    paneStack,
    pushPane: (entry: Omit<PaneEntry, 'id'>) => {
      const id = nextId++;
      paneStack.update((stack) => [...stack, { ...entry, id }]);
      return id;
    },
    closePane: (id: number) => paneStack.update((stack) => stack.filter((entry) => entry.id !== id)),
  };

  const position = {
    global: () => position,
    top: () => position,
    left: () => position,
  };

  const overlayRef = {
    overlayElement,
    attach: () => ({
      instance: {},
      setInput: () => {},
      changeDetectorRef: { detectChanges: () => {} },
    }),
    detachments: () => detachments,
    keydownEvents: () => keydowns,
    dispose: disposeOverlay,
  };

  beforeEach(() => {
    paneStack.set([]);
    nextId = 1;
    focusInitialElementWhenReady.calls.reset();
    destroyFocusTrap.calls.reset();
    disposeOverlay.calls.reset();

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: NavStateMachineService, useValue: nav },
        {
          provide: FocusTrapFactory,
          useValue: {
            create: () => ({
              focusInitialElementWhenReady,
              destroy: destroyFocusTrap,
            }),
          },
        },
        {
          provide: Overlay,
          useValue: {
            position: () => position,
            scrollStrategies: { block: () => ({}) },
            create: () => overlayRef,
          },
        },
      ],
    });
  });

  it('captures focus, closes on Escape, and restores focus to the trigger', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const service = TestBed.runInInjectionContext(() => new TestOverlayService());

    service.open();
    TestBed.inject(ApplicationRef).tick();
    expect(focusInitialElementWhenReady).toHaveBeenCalled();

    keydowns.next(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    TestBed.inject(ApplicationRef).tick();

    expect(paneStack()).toEqual([]);
    expect(destroyFocusTrap).toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
