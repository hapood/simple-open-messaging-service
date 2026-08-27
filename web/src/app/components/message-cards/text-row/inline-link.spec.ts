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
import { ImageDownloadService } from '../../../services/image-download.service';
import { LinkCardService } from '../../../services/link-card.service';
import { MediaSizeThresholdService } from '../../../services/media-size-threshold.service';
import { UserAvatarComponent } from '../../user-avatar/user-avatar.component';
import type { ChatMsgData } from '../chat-item';
import { TextRowComponent } from './text-row.component';

@Component({
  selector: 'app-user-avatar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class StubUserAvatarComponent {
  readonly type = input<unknown>(undefined);
  readonly name = input<string | undefined | null>('');
  readonly identityId = input<number | string | undefined>(undefined);
  readonly account = input<string | undefined | null>(undefined);
  readonly src = input<string | undefined | null>(undefined);
}

describe('TextRowComponent — inline link', () => {
  const url = 'https://example.com/article';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        provideTranslocoTranspiler(CspSafeIcuTranspiler),
        {
          provide: LinkCardService,
          useValue: {
            matchFirst: (text: string) => {
              const start = text.indexOf(url);
              return start < 0
                ? null
                : {
                    rule: { id: 1, hostname: 'example.com' },
                    url,
                    start,
                    end: start + url.length,
                  };
            },
          },
        },
        {
          provide: ImageDownloadService,
          useValue: { thumbnailUrl: ({ src }: { src: string }) => src },
        },
        {
          provide: MediaSizeThresholdService,
          useValue: { shouldDefer: (size: number) => size > 1024 },
        },
      ],
    });
    TestBed.overrideComponent(TextRowComponent, {
      remove: { imports: [UserAvatarComponent] },
      add: { imports: [StubUserAvatarComponent] },
    });
  });

  it('renders the URL as the only link affordance and opens it on click', () => {
    const ref = createComponent(TextRowComponent, {
      environmentInjector: TestBed.inject(EnvironmentInjector),
    });
    const data: ChatMsgData = {
      type: 'msg',
      msgId: 1,
      creator: 'local\u0000local\u0000me',
      isSelf: false,
      name: 'Alice',
      text: `Read ${url} now`,
      time: '12:00',
      contentType: 'PURE_TEXT',
      images: null,
      file: null,
      createdAtMs: 1700000000000,
    };
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    ref.setInput('data', data);
    ref.changeDetectorRef.detectChanges();
    const host = ref.location.nativeElement as HTMLElement;
    const anchor = host.querySelector<HTMLAnchorElement>('a.msg-preview-url');

    expect(anchor?.textContent).toBe(url);
    expect(anchor?.getAttribute('href')).toBe(url);
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.querySelector('.msg-link-card')).toBeNull();
    expect(host.querySelector('.msg-link-open')).toBeNull();

    anchor!.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
    ref.destroy();
  });
});
