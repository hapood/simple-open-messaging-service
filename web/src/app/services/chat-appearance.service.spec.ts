import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatAppearanceService } from './chat-appearance.service';

describe('ChatAppearanceService', () => {
  beforeEach(() => {
    localStorage.removeItem('soms.chat.showSelfAvatar');
    document.documentElement.removeAttribute('data-show-self-avatar');
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('defaults off, persists changes, and exposes them to mounted message rows', () => {
    const service = TestBed.inject(ChatAppearanceService);

    expect(service.showSelfAvatar()).toBeFalse();
    expect(document.documentElement.getAttribute('data-show-self-avatar')).toBe('false');

    service.setShowSelfAvatar(true);
    TestBed.flushEffects();

    expect(service.showSelfAvatar()).toBeTrue();
    expect(localStorage.getItem('soms.chat.showSelfAvatar')).toBe('true');
    expect(document.documentElement.getAttribute('data-show-self-avatar')).toBe('true');
  });
});
