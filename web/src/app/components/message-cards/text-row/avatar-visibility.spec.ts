import {
  Component,
  createComponent,
  EnvironmentInjector,
  input,
  provideZonelessChangeDetection,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { CspSafeIcuTranspiler } from '../../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../../i18n/transloco.loader';
import { UserAvatarComponent } from '../../user-avatar/user-avatar.component';
import type { AuthoredMessageItem, ChatMsgData } from '../chat-item';
import { TextRowComponent } from './text-row.component';
import { LinkCardService } from '../../../services/link-card.service';
import { ImageDownloadService } from '../../../services/image-download.service';
import { MediaSizeThresholdService } from '../../../services/media-size-threshold.service';
import { RouteService } from '../../../services/route.service';

/**
 * Guards the `data-show-self-avatar` chat-appearance preference: the CSS that hides the avatar when the
 * preference is off MUST be scoped to self-sent rows (`.msg-row.msg-self .msg-avatar`) — never the other
 * party's avatar. This mounts the real TextRowComponent (kernel-style, via createComponent) with its real
 * `_row-base.scss` styles and reads `getComputedStyle` on the `.msg-avatar` slot in a real headless browser,
 * so the Angular emulated-`:host-context` cascade is exercised exactly as in production. A regression that
 * broadens the hide selector (e.g. dropping the `.msg-self` qualifier) would fail here.
 *
 * The inner `<app-user-avatar>` is stubbed (its DB/HTTP layer is irrelevant to the slot's visibility, which
 * is owned by this row's own CSS), so the test isolates the cascade under test.
 */
@Component({
  selector: 'app-user-avatar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class StubUserAvatarComponent {
  readonly type = input<unknown>(undefined);
  readonly name = input<string | undefined | null>('');
  readonly identityId = input<number | undefined>(undefined);
  readonly account = input<string | undefined | null>(undefined);
  readonly federatedDomain = input<string | undefined | null>(undefined);
  readonly src = input<string | undefined | null>(undefined);
}

function buildMsg(
  overrides: Partial<AuthoredMessageItem>,
): AuthoredMessageItem {
  return {
    type: 'msg',
    msgId: 1,
    creator: JSON.stringify([0, 'local', 'me']),
    isSelf: false,
    name: 'Alice',
    text: 'hi',
    time: '12:00',
    contentType: 'PURE_TEXT',
    images: null,
    file: null,
    createdAtMs: 1700000000000,
    ...overrides,
  };
}

describe('TextRowComponent — avatar visibility vs data-show-self-avatar', () => {
  const HTML = document.documentElement;

  beforeEach(() => {
    HTML.removeAttribute('data-show-self-avatar');
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: ['en', 'zh-CN'],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        provideTranslocoTranspiler(CspSafeIcuTranspiler),
        {
          provide: LinkCardService,
          useValue: { matchFirst: () => null },
        },
        {
          provide: ImageDownloadService,
          useValue: { thumbnailUrl: ({ src }: { src: string }) => src },
        },
        {
          provide: MediaSizeThresholdService,
          useValue: { shouldDefer: (size: number) => size > 1024 },
        },
        {
          provide: RouteService,
          useValue: { popupDlg: () => undefined },
        },
      ],
    });
    TestBed.overrideComponent(TextRowComponent, {
      remove: { imports: [UserAvatarComponent] },
      add: { imports: [StubUserAvatarComponent] },
    });
  });

  afterEach(() => {
    HTML.removeAttribute('data-show-self-avatar');
  });

  /** Mount a group-head message row attached to the document (so `:host-context(<html>)` can match),
   *  set the preference attribute, and return the `.msg-avatar` slot's resolved `display`. */
  function avatarDisplayFor(
    data: ChatMsgData,
    pref: 'true' | 'false' | 'unset',
  ): string {
    HTML.setAttribute(
      'data-show-self-avatar',
      pref === 'unset' ? 'false' : pref,
    );
    if (pref === 'unset') HTML.removeAttribute('data-show-self-avatar');

    const envInjector = TestBed.inject(EnvironmentInjector);
    const ref = createComponent(TextRowComponent, {
      environmentInjector: envInjector,
    });
    const host = ref.location.nativeElement as HTMLElement;
    document.body.appendChild(host);
    try {
      ref.setInput('data', data);
      ref.setInput('isShowHead', true); // group head → avatar slot is rendered
      ref.changeDetectorRef.detectChanges();

      const slot = host.querySelector<HTMLElement>('.msg-avatar');
      expect(slot).not.toBeNull();
      return getComputedStyle(slot!).display;
    } finally {
      document.body.removeChild(host);
      ref.destroy();
    }
  }

  function senderNameShownFor(data: ChatMsgData): boolean {
    const fixture = TestBed.createComponent(TextRowComponent);
    fixture.componentRef.setInput('data', data);
    fixture.componentRef.setInput('isShowHead', true);
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('.msg-name') !== null;
  }

  it('keeps the OTHER party avatar visible regardless of the preference (the reported bug guard)', () => {
    const other = buildMsg({
      isSelf: false,
      creator: JSON.stringify([1, 'peer.test', 'alice']),
      name: 'Alice',
    });
    // Turning "show my avatar" OFF must hide only SELF avatars — never the other party's.
    expect(avatarDisplayFor(other, 'false')).not.toBe('none');
    expect(avatarDisplayFor(other, 'true')).not.toBe('none');
    // No preference set yet (fresh load) behaves like "off" for self, but still shows the other party.
    expect(avatarDisplayFor(other, 'unset')).not.toBe('none');
  });

  it('hides the SELF avatar when the preference is off and shows it when on', () => {
    const self = buildMsg({
      isSelf: true,
      creator: JSON.stringify([0, 'local', 'me']),
      name: 'Me',
    });
    expect(avatarDisplayFor(self, 'false')).toBe('none');
    expect(avatarDisplayFor(self, 'unset')).toBe('none');
    expect(avatarDisplayFor(self, 'true')).toBe('block');
  });

  it('hides the redundant sender name in a direct conversation', () => {
    expect(
      senderNameShownFor(
        buildMsg({ isSelf: false, isGroupConversation: false }),
      ),
    ).toBe(false);
  });

  it('shows the sender name for an incoming group-conversation head', () => {
    expect(
      senderNameShownFor(
        buildMsg({ isSelf: false, isGroupConversation: true }),
      ),
    ).toBe(true);
  });
});
