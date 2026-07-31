import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatAppearanceService } from './chat-appearance.service';
import { PreferenceStore } from './preference-store.service';

describe('ChatAppearanceService', () => {
  beforeEach(async () => {
    document.documentElement.removeAttribute('data-show-self-avatar');
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    const preferences = TestBed.inject(PreferenceStore);
    await preferences.remove('device', 'soms.chat.showSelfAvatar');
    await preferences.remove('device', 'soms.chat.openPosition');
  });

  it('defaults on, persists changes, and exposes them to mounted message rows', async () => {
    const service = TestBed.inject(ChatAppearanceService);
    const preferences = TestBed.inject(PreferenceStore);

    expect(service.showSelfAvatar()).toBeTrue();
    expect(document.documentElement.getAttribute('data-show-self-avatar')).toBe('true');

    service.setShowSelfAvatar(false);
    TestBed.flushEffects();

    expect(service.showSelfAvatar()).toBeFalse();
    expect(await preferences.get('device', 'soms.chat.showSelfAvatar')).toBe(false);
    expect(document.documentElement.getAttribute('data-show-self-avatar')).toBe('false');
  });

  it('defaults to latest and persists the conversation open position', async () => {
    const service = TestBed.inject(ChatAppearanceService);
    const preferences = TestBed.inject(PreferenceStore);

    expect(service.openPosition()).toBe('latest');
    service.setOpenPosition('last-read');

    expect(service.openPosition()).toBe('last-read');
    expect(await preferences.get('device', 'soms.chat.openPosition')).toBe('last-read');
  });
});
