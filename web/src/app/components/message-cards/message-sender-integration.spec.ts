import {
  EnvironmentInjector,
  provideZonelessChangeDetection,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { CspSafeIcuTranspiler } from '../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { LinkCardService } from '../../services/link-card.service';
import { readStickyAvatarIdentity } from '../../lib/sticky-avatar';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { AvatarView } from '../user-avatar/avatar-view';
import { UserAvatarType } from '../user-avatar/model';
import type { ChatItemData } from './chat-item';
import { createMsgCbElement } from './create-item';
import { MessageSenderService } from './message-sender.service';
import { StickyAvatarOverlayComponent } from './sticky-avatar-overlay/sticky-avatar-overlay.component';

/** The virtualized factory owns the subscription; all paint locations share its signal. */
describe('message sender presentation integration', () => {
  it('updates the name, natural avatar, tail and sticky together and cancels replaced or destroyed rows', () => {
    const first = new Subject<AvatarView>();
    const replacement = new Subject<AvatarView>();
    const resolve = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(replacement);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        provideTranslocoTranspiler(CspSafeIcuTranspiler),
        { provide: MessageSenderService, useValue: { resolve } },
        { provide: LinkCardService, useValue: { matchFirst: () => null } },
      ],
    });
    const item: CbItem<ChatItemData> = {
      id: 1,
      data: {
        type: 'msg',
        msgId: 1,
        creator: 'a',
        isSelf: false,
        senderDisplayContext: 'group',
        name: 'Captured',
        text: 'hi',
        time: '12:00',
        contentType: 'PURE_TEXT',
        images: null,
        file: null,
        createdAtMs: 1,
      },
    };
    const row = createMsgCbElement(
      item,
      true,
      false,
      false,
      TestBed.inject(EnvironmentInjector),
    );
    document.body.appendChild(row.el);
    const overlay = TestBed.createComponent(StickyAvatarOverlayComponent);
    try {
      const identity = readStickyAvatarIdentity(row.el)!;
      expect(identity).toBeDefined();
      overlay.componentRef.setInput('avatar', {
        ...identity,
        side: 'other',
        top: 12,
      });
      overlay.detectChanges();
      first.next({
        name: 'Pinned Alice',
        imageUrl: null,
        colorKey: 'alice',
        type: UserAvatarType.OTHER,
      });
      overlay.detectChanges();
      expect(row.el.querySelector('.msg-name')?.textContent?.trim()).toBe(
        'Pinned Alice',
      );
      const labels = Array.from(
        row.el.querySelectorAll('[role="img"]'),
        (element) => element.getAttribute('aria-label'),
      );
      expect(labels).toEqual(['Pinned Alice avatar', 'Pinned Alice avatar']);
      expect(
        overlay.nativeElement
          .querySelector('[role="img"]')
          .getAttribute('aria-label'),
      ).toBe('Pinned Alice avatar');
      first.next({
        name: 'Updated Alice',
        imageUrl: 'data:image/png;base64,YQ==',
        type: UserAvatarType.OTHER,
      });
      overlay.detectChanges();
      expect(row.el.querySelector('.msg-name')?.textContent?.trim()).toBe(
        'Updated Alice',
      );
      expect(row.el.querySelectorAll('img').length).toBe(2);
      expect(
        overlay.nativeElement.querySelector('img').getAttribute('src'),
      ).toBe('data:image/png;base64,YQ==');
      row.update!({ ...item, data: { ...item.data, text: 'edited' } }, null);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(first.observed).toBe(true);
      expect(row.el.querySelectorAll('img').length).toBe(2);
      row.update!(
        { ...item, data: { ...item.data, name: 'New Subject' } },
        null,
      );
      expect(first.observed).toBe(false);
      expect(row.el.querySelectorAll('img').length).toBe(0);
      expect(row.el.querySelector('.msg-name')?.textContent?.trim()).toBe(
        'New Subject',
      );
      first.next({ name: 'Stale', imageUrl: null, type: UserAvatarType.OTHER });
      replacement.next({
        name: 'Bob',
        imageUrl: null,
        type: UserAvatarType.OTHER,
      });
      overlay.detectChanges();
      expect(row.el.querySelector('.msg-name')?.textContent?.trim()).toBe(
        'Bob',
      );
      expect(
        overlay.nativeElement
          .querySelector('[role="img"]')
          .getAttribute('aria-label'),
      ).toBe('Bob avatar');
    } finally {
      overlay.destroy();
      row.destroy();
      row.el.remove();
    }
    expect(replacement.observed).toBe(false);
  });
});
