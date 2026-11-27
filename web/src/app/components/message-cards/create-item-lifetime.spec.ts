import { EnvironmentInjector, provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, HttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideTransloco, provideTranslocoTranspiler } from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { CspSafeIcuTranspiler } from '../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import { LinkCardService } from '../../services/link-card.service';
import { ProfileRepository, type ResolvedProfile } from '../../services/profile-store.service';
import { MediaFileProgressService, type MediaFileProgress } from '../../services/media-file-progress.service';
import type { ChatItemData, TextMessageItem } from './chat-item';
import { createMsgCbElement } from './create-item';

const imageBytes = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
);

function textItem(): CbItem<TextMessageItem> {
  return {
    id: 1,
    data: {
      type: 'msg', msgId: 1, threadId: 42, creator: 'alice', isSelf: false,
      senderDisplayContext: 'group', name: 'Alice', text: 'Original body', time: '12:00',
      contentType: 'PURE_TEXT', images: null, file: null, createdAtMs: 1,
      sender: {
        kind: 'demand', account: 'alice', fallbackName: 'Alice',
        profile: { account: 'alice', publisherNamespaceId: 0, profileNamespaceId: 0, rev: 1, linked: true },
      },
    },
  };
}

function fileItem(): CbItem<ChatItemData> {
  return {
    id: 2,
    data: {
      ...textItem().data,
      msgId: 2, contentType: 'FILE', images: null,
      file: { url: '/file/test', name: 'test.pdf', size: 100, mimeType: 'application/pdf' },
    },
  };
}

describe('message renderer pre-destruction', () => {
  let profiles: Subject<ResolvedProfile>;

  beforeEach(() => {
    profiles = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting(),
        provideTransloco({ config: { availableLangs: ['en'], defaultLang: 'en' }, loader: InlineTranslocoLoader }),
        provideTranslocoTranspiler(CspSafeIcuTranspiler),
        { provide: ProfileRepository, useValue: { resolve: () => profiles } },
        { provide: LinkCardService, useValue: { matchFirst: () => null } },
        { provide: MediaFileProgressService, useFactory: () => {
          const http = TestBed.inject(HttpClient);
          return { observe: () => http.get<MediaFileProgress>('/test/owned-media-progress') };
        } },
      ],
    });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('keeps the original styled DOM and decoded avatar while ending live work before exit', async () => {
    const item = textItem();
    const row = createMsgCbElement(item, true, false, false, TestBed.inject(EnvironmentInjector));
    const exitLayer = document.createElement('div');
    document.body.append(row.el, exitLayer);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    try {
      const blob = await (await fetch(imageBytes)).blob();
      profiles.next({
        publisherNamespaceId: 0, namespaceId: 0, account: 'alice', rev: 1,
        name: 'Resolved Alice', bio: '', avatarDigest: 'a'.repeat(64), avatarBlob: blob,
      });
      const image = row.el.querySelector('img')!;
      await image.decode();
      const originalHost = row.el;
      const originalBody = row.el.querySelector('.msg-bubble')!;
      const previousHeight = row.el.offsetHeight;
      const previousStyle = getComputedStyle(originalBody).lineHeight;
      const url = image.src;
      expect(profiles.observed).toBe(true);
      expect(image.naturalWidth).toBe(8);
      expect(previousHeight).toBeGreaterThan(0);

      row.predestory!();
      row.predestory!();
      expect(profiles.observed).toBe(false);
      expect(revoke).not.toHaveBeenCalled();
      expect(row.el.isConnected).toBe(true);
      expect(row.el.inert).toBe(true);
      expect(row.el.getAttribute('aria-hidden')).toBe('true');
      // The kernel may reparent the original DOM after cancellation, not clone it.
      exitLayer.appendChild(row.el);
      row.el.style.opacity = '0.5';
      row.el.style.transform = 'translateY(8px)';
      row.update({ ...item, data: { ...item.data, text: 'Late body' } }, null);
      expect(row.el).toBe(originalHost);
      expect(row.el.querySelector('.msg-bubble')).toBe(originalBody);
      expect(row.el.textContent).toContain('Original body');
      expect(row.el.textContent).not.toContain('Late body');
      expect(row.el.offsetHeight).toBe(previousHeight);
      expect(getComputedStyle(originalBody).lineHeight).toBe(previousStyle);
      expect(image.src).toBe(url);
      expect(image.naturalWidth).toBe(8);
      // Also prove that the URL remains usable by a new decoder, not just a
      // decoded image that might survive revocation through browser caching.
      const probe = new Image();
      probe.src = url;
      await probe.decode();
      expect(probe.naturalWidth).toBe(8);

      row.destroy();
      row.destroy();
      expect(row.el.isConnected).toBe(false);
      expect(revoke).toHaveBeenCalledExactlyOnceWith(url);
    } finally {
      row.destroy();
      row.el.remove();
      exitLayer.remove();
    }
  });

  it('cancels nested media HTTP before destroying the row or changing its painted state', () => {
    const row = createMsgCbElement(fileItem(), true, false, false, TestBed.inject(EnvironmentInjector));
    document.body.appendChild(row.el);
    try {
      TestBed.tick();
      const request = TestBed.inject(HttpTestingController).expectOne('/test/owned-media-progress');
      const cell = row.el.querySelector('app-album-media-cell');
      expect(cell).not.toBeNull();
      const before = row.el.innerHTML;
      row.predestory!();
      expect(request.cancelled).toBe(true);
      expect(profiles.observed).toBe(false);
      expect(row.el.isConnected).toBe(true);
      expect(row.el.querySelector('app-album-media-cell')).toBe(cell);
      expect(row.el.innerHTML).toBe(before);
      TestBed.tick();
      TestBed.inject(HttpTestingController).expectNone('/test/owned-media-progress');
      expect(row.el.innerHTML).toBe(before);
      row.destroy();
      expect(row.el.isConnected).toBe(false);
    } finally {
      row.destroy();
      row.el.remove();
    }
  });

  it('also cancels nested work when a row is immediately destroyed without an exit', () => {
    const row = createMsgCbElement(fileItem(), true, false, false, TestBed.inject(EnvironmentInjector));
    document.body.appendChild(row.el);
    TestBed.tick();
    const request = TestBed.inject(HttpTestingController).expectOne('/test/owned-media-progress');
    row.destroy();
    expect(request.cancelled).toBe(true);
    expect(profiles.observed).toBe(false);
    expect(row.el.isConnected).toBe(false);
    expect(() => row.destroy()).not.toThrow();
  });
});
