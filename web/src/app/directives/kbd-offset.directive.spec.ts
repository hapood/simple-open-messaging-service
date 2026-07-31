import { Component, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { By } from '@angular/platform-browser';
import {
  KbdOffsetDirective,
  shouldResizeChatHost,
} from './kbd-offset.directive';
import {
  KeyboardInsetAnimation,
  KeyboardInsetService,
} from '../services/keyboard-inset.service';
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
  let animation: ReturnType<typeof signal<KeyboardInsetAnimation | null>>;
  let viewportReduction: ReturnType<typeof signal<number>>;
  let reflowFrozen: ReturnType<typeof signal<boolean>>;
  let hasPhysicalKeyboard: ReturnType<typeof signal<boolean>>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    inset = signal(0);
    layoutOverride = signal<number | null>(null);
    animation = signal<KeyboardInsetAnimation | null>(null);
    viewportReduction = signal(0);
    reflowFrozen = signal(false);
    hasPhysicalKeyboard = signal(false);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: KeyboardInsetService,
          useValue: {
            inset: inset.asReadonly(),
            animation: animation.asReadonly(),
            viewportReduction: viewportReduction.asReadonly(),
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

  it('enables host resizing only for a soft-keyboard browser', () => {
    expect(shouldResizeChatHost(false, false)).toBe(true);
    expect(shouldResizeChatHost(false, true)).toBe(false);
    expect(shouldResizeChatHost(true, false)).toBe(false);

    const { host, detect } = setup();
    expect(host.classList.contains('kbd-offset--resize-host')).toBe(true);
    hasPhysicalKeyboard.set(true);
    detect();
    expect(host.classList.contains('kbd-offset--resize-host')).toBe(false);
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

  it('subtracts viewport shrink already applied by the WebView', () => {
    const { directive, detect } = setup();
    inset.set(320);
    viewportReduction.set(280);
    detect();
    expect(directive.offset()).toBe(40);

    viewportReduction.set(400);
    detect();
    expect(directive.offset()).toBe(0);
  });

  it('moves directly to the announced native endpoint for the native animation duration', () => {
    const { directive, host, detect } = setup();
    inset.set(12);
    animation.set({ target: 320, durationMs: 250 });
    detect();

    expect(directive.offset()).toBe(320);
    expect(directive.duration()).toBe(250);
    expect(host.style.getPropertyValue('--kbd-lift')).toBe('320px');
    expect(host.style.getPropertyValue('--kbd-duration')).toBe('250ms');

    // Progress frames no longer move the target.
    inset.set(180);
    detect();
    expect(directive.offset()).toBe(320);

    inset.set(320);
    animation.set(null);
    detect();
    expect(directive.offset()).toBe(320);
    expect(directive.duration()).toBe(60);
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
