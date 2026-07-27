import { Component, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { By } from '@angular/platform-browser';
import { KbdOffsetDirective } from './kbd-offset.directive';
import { KeyboardInsetService } from '../services/keyboard-inset.service';
import { LayoutService } from '../services/layout.service';
import { InputDeviceService } from '../services/input-device.service';

// Zoneless: no fakeAsync/tick. Signal writes schedule a tick; fixture.detectChanges() flushes the
// directive's effect + the host binding in one pass.

@Component({ template: `<div appKbdOffset></div>`, imports: [KbdOffsetDirective] })
class HostComp {}

describe('KbdOffsetDirective', () => {
  // Writable backing signals for the mocked services — each test drives these directly.
  let inset: ReturnType<typeof signal<number>>;
  let layoutOverride: ReturnType<typeof signal<number | null>>;
  let reflowFrozen: ReturnType<typeof signal<boolean>>;
  let hasPhysicalKeyboard: ReturnType<typeof signal<boolean>>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    inset = signal(0);
    layoutOverride = signal<number | null>(null);
    reflowFrozen = signal(false);
    hasPhysicalKeyboard = signal(false);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: KeyboardInsetService,
          useValue: {
            inset: inset.asReadonly(),
            layoutOverride: layoutOverride.asReadonly(),
            open: computed(() => inset() > 0),
            available: false,
          } as unknown as KeyboardInsetService,
        },
        {
          provide: LayoutService,
          useValue: { reflowFrozen: reflowFrozen.asReadonly() } as unknown as LayoutService,
        },
        {
          provide: InputDeviceService,
          useValue: { hasPhysicalKeyboard: hasPhysicalKeyboard.asReadonly() } as unknown as InputDeviceService,
        },
      ],
    });
  });

  /** Create the host, flush the initial effect, and surface the directive + its host element. */
  function setup(): { directive: KbdOffsetDirective; host: HTMLElement; detect: () => void } {
    const fixture = TestBed.createComponent(HostComp);
    fixture.detectChanges();
    const debugEl = fixture.debugElement.query(By.directive(KbdOffsetDirective));
    return {
      directive: debugEl.injector.get(KbdOffsetDirective),
      host: debugEl.nativeElement as HTMLElement,
      detect: () => fixture.detectChanges(),
    };
  }

  it('mirrors the keyboard inset and binds it as --kbd-lift on the host', () => {
    const { directive, host, detect } = setup();
    expect(directive.offset()).toBe(0);
    expect(host.style.getPropertyValue('--kbd-lift')).toBe('0px');

    inset.set(300);
    detect();
    expect(directive.offset()).toBe(300);
    expect(host.style.getPropertyValue('--kbd-lift')).toBe('300px');

    inset.set(0);
    detect();
    expect(directive.offset()).toBe(0);
    expect(host.style.getPropertyValue('--kbd-lift')).toBe('0px');
  });

  it('a physical keyboard forces offset to 0 even while the inset is non-zero', () => {
    const { directive, detect } = setup();
    inset.set(300);
    detect();
    expect(directive.offset()).toBe(300);

    hasPhysicalKeyboard.set(true);
    detect();
    expect(directive.offset()).toBe(0);

    hasPhysicalKeyboard.set(false);
    detect();
    expect(directive.offset()).toBe(300); // back to mirroring the (still-300) inset
  });

  it('uses the composer layout override instead of transient native IME frames', () => {
    const { directive, detect } = setup();
    inset.set(300);
    detect();
    expect(directive.offset()).toBe(300);

    layoutOverride.set(0);
    inset.set(180);
    detect();
    expect(directive.offset()).toBe(0);

    layoutOverride.set(null);
    detect();
    expect(directive.offset()).toBe(180);
  });

  it('immunity frame: holds the offset while frozen, recomputes on thaw', () => {
    const { directive, detect } = setup();
    inset.set(200);
    detect();
    expect(directive.offset()).toBe(200);

    reflowFrozen.set(true); // a route-transition slide starts → freeze
    inset.set(400);         // a native push mid-slide
    detect();
    expect(directive.offset()).toBe(200); // held — the mid-slide push did NOT lift

    reflowFrozen.set(false); // thaw
    detect();
    expect(directive.offset()).toBe(400); // recomputed from the latest inset
  });

  it('does not track the inset while frozen (a push mid-slide does not even re-run the effect)', () => {
    const { directive, detect } = setup();
    inset.set(100);
    detect();
    expect(directive.offset()).toBe(100);

    reflowFrozen.set(true);
    detect();
    // While frozen, `inset()` is not read, so changing it must not change the held offset:
    inset.set(999);
    detect();
    expect(directive.offset()).toBe(100);

    reflowFrozen.set(false);
    detect();
    expect(directive.offset()).toBe(999); // thaw reads the latest inset
  });
});
