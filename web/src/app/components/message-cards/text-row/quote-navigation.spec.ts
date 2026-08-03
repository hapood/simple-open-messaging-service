import {
  Component,
  createComponent,
  EnvironmentInjector,
  input,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { CspSafeIcuTranspiler } from '../../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../../i18n/transloco.loader';
import { UserAvatarComponent } from '../../user-avatar/user-avatar.component';
import { ImageDownloadService } from '../../../services/image-download.service';
import { MediaSizeThresholdService } from '../../../services/media-size-threshold.service';
import type { ChatMsgData } from '../chat-item';
import { TextRowComponent } from './text-row.component';

@Component({ selector: 'app-user-avatar', standalone: true, template: '' })
class StubUserAvatarComponent {
  readonly type = input<unknown>(undefined);
  readonly name = input<string | undefined | null>('');
  readonly identityId = input<number | string | undefined>(undefined);
  readonly colorIdentityId = input<number | string | undefined>(undefined);
  readonly src = input<string | undefined | null>(undefined);
}

function message(quote: ChatMsgData['quote']): ChatMsgData {
  return {
    type: 'msg',
    msgId: 2,
    creator: 1,
    isSelf: false,
    name: 'Bob',
    text: 'reply',
    time: '12:00',
    contentType: 'PURE_TEXT',
    images: null,
    file: null,
    createdAtMs: 1_700_000_000_000,
    quote,
  };
}

describe('TextRowComponent — forwarded quote navigation', () => {
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
          provide: ImageDownloadService,
          useValue: { thumbnailUrl: ({ src }: { src: string }) => src },
        },
        {
          provide: MediaSizeThresholdService,
          useValue: { threshold: signal(1024) },
        },
      ],
    });
    TestBed.overrideComponent(TextRowComponent, {
      remove: { imports: [UserAvatarComponent] },
      add: { imports: [StubUserAvatarComponent] },
    });
  });

  function mount(data: ChatMsgData) {
    const ref = createComponent(TextRowComponent, {
      environmentInjector: TestBed.inject(EnvironmentInjector),
    });
    ref.setInput('data', data);
    ref.changeDetectorRef.detectChanges();
    const host = ref.location.nativeElement as HTMLElement;
    document.body.appendChild(host);
    ref.onDestroy(() => host.remove());
    return ref;
  }

  it('emits the bundle-local target id when the quoted message was forwarded', () => {
    const ref = mount(message({ author: 'Alice', body: 'original', seq: 1 }));
    const targets: number[] = [];
    const subscription = ref.instance.quoteJump.subscribe((id) =>
      targets.push(id),
    );

    (ref.location.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('.msg-quote')!
      .click();

    expect(targets).toEqual([1]);
    subscription.unsubscribe();
    ref.destroy();
  });

  it('renders a non-interactive preview when the quoted message was not forwarded', () => {
    const ref = mount(message({ author: 'Alice', body: 'original' }));
    const host = ref.location.nativeElement as HTMLElement;

    expect(host.querySelector('.msg-quote')).not.toBeNull();
    expect(host.querySelector('button.msg-quote')).toBeNull();
    ref.destroy();
  });

  it('keeps an unavailable quote in a separate block before the message body', () => {
    const ref = mount(message({ seq: 1 }));
    const host = ref.location.nativeElement as HTMLElement;
    const bubble = host.querySelector<HTMLElement>('.msg-bubble')!;
    const quote = bubble.querySelector<HTMLElement>('.msg-quote')!;
    const body = bubble.querySelector<HTMLElement>('.msg-bubble-text')!;

    expect(quote.textContent?.trim()).toBe('Message not found');
    expect(body.textContent).toContain('reply');
    expect(quote.nextElementSibling).toBe(body);
    expect(getComputedStyle(bubble).flexDirection).toBe('column');

    ref.destroy();
  });

  it('renders a Telegram-style two-line reply preview', () => {
    const ref = mount(message({ author: 'Alice', body: 'original', seq: 1 }));
    const quote = (
      ref.location.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('.msg-quote')!;
    const author = quote.querySelector<HTMLElement>('strong')!;
    const preview = quote.querySelector<HTMLElement>('.msg-quote-copy > span')!;

    expect(getComputedStyle(quote).display).toBe('grid');
    expect(author.textContent).toBe('Alice');
    expect(getComputedStyle(author).fontSize).toBe(
      getComputedStyle(preview).fontSize,
    );
    expect(getComputedStyle(author).lineHeight).toBe(
      getComputedStyle(preview).lineHeight,
    );
    expect(getComputedStyle(author).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(preview).whiteSpace).toBe('nowrap');

    ref.destroy();
  });

  it('renders a target thumbnail only when reply metadata provides one', () => {
    const ref = mount(
      message({
        seq: 1,
        author: 'Alice',
        body: 'Photo',
        contentType: 'IMAGE',
        image: 'data:image/png;base64,iVBORw0KGgo=',
        imageShape: 'thumbnail',
      }),
    );
    const quote = (
      ref.location.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('.msg-quote')!;

    expect(quote.classList.contains('msg-quote--visual')).toBeTrue();
    expect(quote.querySelector('img.msg-quote-visual')).not.toBeNull();

    ref.destroy();
  });

  it('uses a placeholder instead of requesting an oversized reply image', () => {
    const ref = mount(
      message({
        seq: 1,
        contentType: 'IMAGE',
        image: '/uploads/cas/aa/bb/photo.jpg',
        imageSize: 2048,
        imageShape: 'thumbnail',
      }),
    );
    const quote = (
      ref.location.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('.msg-quote')!;

    expect(quote.querySelector('.msg-quote-placeholder')).not.toBeNull();
    expect(quote.querySelector('img.msg-quote-visual')).toBeNull();

    ref.destroy();
  });
});
