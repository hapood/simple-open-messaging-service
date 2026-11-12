import { ApplicationRef, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { KeyboardInsetService } from './keyboard-inset.service';
import { NativeComposerService } from './native-composer.service';
import { SnackbarGeometryService } from './snackbar-geometry.service';

describe('SnackbarGeometryService', () => {
  const inset = signal(0);
  const viewportReduction = signal(0);
  const active = signal(false);
  const composerHeight = signal(64);
  const keyboardHeight = signal(0);
  const property = '--soms-snackbar-bottom-offset';
  const css = () => document.documentElement.style.getPropertyValue(property);
  const flush = () => TestBed.inject(ApplicationRef).tick();

  function setup(available = true) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: KeyboardInsetService, useValue: { available, inset, viewportReduction } },
        { provide: NativeComposerService, useValue: { active, composerHeight, keyboardHeight } },
      ],
    });
    TestBed.inject(SnackbarGeometryService);
    flush();
  }

  beforeEach(() => {
    inset.set(0);
    viewportReduction.set(0);
    active.set(false);
    composerHeight.set(64);
    keyboardHeight.set(0);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    document.documentElement.style.removeProperty(property);
  });

  it('tracks the global keyboard outside native chat and clears it when closed', () => {
    setup();
    expect(css()).toBe('calc(0px + var(--soms-safe-bottom, 0px))');
    inset.set(320);
    flush();
    expect(css()).toBe('calc(320px + var(--soms-safe-bottom, 0px))');
    inset.set(0);
    flush();
    expect(css()).toBe('calc(0px + var(--soms-safe-bottom, 0px))');
  });

  it('uses composer keyboard geometry, including emoji, without adding the IME again', () => {
    setup();
    active.set(true);
    keyboardHeight.set(288);
    inset.set(320);
    flush();
    expect(css()).toBe('calc(352px + var(--soms-safe-bottom, 0px))');
    inset.set(0);
    flush();
    expect(css()).toBe('calc(352px + var(--soms-safe-bottom, 0px))');
  });

  it('ignores cached native geometry after leaving chat and restores it on return', () => {
    setup();
    active.set(true);
    keyboardHeight.set(288);
    flush();
    active.set(false);
    inset.set(200);
    flush();
    expect(css()).toBe('calc(200px + var(--soms-safe-bottom, 0px))');
    inset.set(0);
    flush();
    expect(css()).toBe('calc(0px + var(--soms-safe-bottom, 0px))');
    active.set(true);
    flush();
    expect(css()).toBe('calc(352px + var(--soms-safe-bottom, 0px))');
  });

  it('subtracts viewport resizing once without subtracting composer height', () => {
    setup();
    inset.set(320);
    viewportReduction.set(100);
    flush();
    expect(css()).toBe('calc(220px + var(--soms-safe-bottom, 0px))');
    active.set(true);
    keyboardHeight.set(288);
    flush();
    expect(css()).toBe('calc(252px + var(--soms-safe-bottom, 0px))');
    viewportReduction.set(400);
    flush();
    expect(css()).toBe('calc(64px + var(--soms-safe-bottom, 0px))');
  });

  it('leaves browser positioning to CSS and the visible viewport', () => {
    setup(false);
    inset.set(320);
    flush();
    expect(css()).toBe('');
  });

  it('removes the global override on destruction', () => {
    setup();
    TestBed.resetTestingModule();
    expect(css()).toBe('');
  });
});
