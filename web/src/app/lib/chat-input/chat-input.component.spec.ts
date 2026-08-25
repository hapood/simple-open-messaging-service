import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ChatInputComponent } from './chat-input.component';
import { NativeUploadService } from '../../services/native-upload.service';
import { KeyboardInsetService } from '../../services/keyboard-inset.service';
import { PreferenceStore } from '../../services/preference-store.service';
import { LinkCardGenerationService } from '../../services/link-card-generation.service';
import { RouteService } from '../../services/route.service';
import { ComposerDraftService } from '../../services/composer-draft.service';

describe('ChatInputComponent link generation', () => {
  it('starts generation only after the user activates the link action', async () => {
    vi.useFakeTimers();
    const begin = vi.fn().mockResolvedValue({
      generationId: 'generation-1',
      status: 'pending',
      expiresAt: Date.now() + 60_000,
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: NativeUploadService, useValue: {} },
        { provide: KeyboardInsetService, useValue: {} },
        {
          provide: PreferenceStore,
          useValue: {
            get: vi.fn().mockResolvedValue(undefined),
            set: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: LinkCardGenerationService,
          useValue: {
            begin,
            snapshot: vi.fn(),
            resume: vi.fn(),
            forget: vi.fn(),
          },
        },
        { provide: RouteService, useValue: { popupDlg: vi.fn() } },
        {
          provide: ComposerDraftService,
          useValue: { drafts: signal(0), get: vi.fn(), save: vi.fn() },
        },
      ],
    });

    const component = TestBed.runInInjectionContext(
      () => new ChatInputComponent(),
    );
    component.onLinkMarkers([
      { href: 'https://example.com', start: 0, end: 19 },
    ]);
    await vi.advanceTimersByTimeAsync(500);

    expect(component.detectedLink()).toBe('https://example.com');
    expect(begin).not.toHaveBeenCalled();

    component.onLinkClick();
    await vi.runAllTimersAsync();

    expect(begin).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenCalledWith('https://example.com', '', undefined);
    vi.useRealTimers();
  });
});
