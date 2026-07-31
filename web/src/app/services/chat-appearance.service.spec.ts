import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatAppearanceService } from './chat-appearance.service';

describe('ChatAppearanceService', () => {
  beforeEach(() => {
    localStorage.removeItem('soms.chat.showSelfAvatar');
    localStorage.removeItem('soms.chat.openPosition');
    document.documentElement.removeAttribute('data-show-self-avatar');
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('defaults on, persists changes, and exposes them to mounted message rows', () => {
    const service = TestBed.inject(ChatAppearanceService);

    expect(service.showSelfAvatar()).toBeTrue();
    expect(document.documentElement.getAttribute('data-show-self-avatar')).toBe('true');

    service.setShowSelfAvatar(false);
    TestBed.flushEffects();

    expect(service.showSelfAvatar()).toBeFalse();
    expect(localStorage.getItem('soms.chat.showSelfAvatar')).toBe('false');
    expect(document.documentElement.getAttribute('data-show-self-avatar')).toBe('false');
  });

  it('defaults to latest and persists the conversation open position', () => {
    const service = TestBed.inject(ChatAppearanceService);

    expect(service.openPosition()).toBe('latest');
    service.setOpenPosition('last-read');

    expect(service.openPosition()).toBe('last-read');
    expect(localStorage.getItem('soms.chat.openPosition')).toBe('last-read');
  });
});
