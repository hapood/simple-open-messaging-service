import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { UnreadPresentation } from './unread-presentation.service';
import { ForegroundPresentation } from './foreground-presentation.service';

describe('UnreadPresentation', () => {
  it('requires focused foreground and a pinned active surface, independently of durable unread', () => {
    const focused = signal(true);
    TestBed.configureTestingModule({
      providers: [{ provide: ForegroundPresentation, useValue: { focused } }],
    });
    const presentation = TestBed.inject(UnreadPresentation);
    const surface = {};
    presentation.report(surface, 1, true, true);
    expect(presentation.suppresses(1)).toBe(true);
    expect(presentation.suppresses(2)).toBe(false);
    focused.set(false);
    expect(presentation.suppresses(1)).toBe(false);
    focused.set(true);
    presentation.report(surface, 1, true, false);
    expect(presentation.suppresses(1)).toBe(false);
    presentation.report(surface, 1, false, true);
    expect(presentation.suppresses(1)).toBe(false);
    presentation.report(surface, 2, true, true);
    expect(presentation.suppresses(1)).toBe(false);
    expect(presentation.suppresses(2)).toBe(true);
    presentation.clear(surface);
    expect(presentation.suppresses(2)).toBe(false);
  });

  it('keeps teardown scoped to its surface', () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ForegroundPresentation,
          useValue: { focused: signal(true) },
        },
      ],
    });
    const presentation = TestBed.inject(UnreadPresentation);
    const first = {};
    const second = {};
    presentation.report(first, 1, true, true);
    presentation.report(second, 2, true, true);
    presentation.clear(first);
    expect(presentation.suppresses(2)).toBe(true);
  });
});
