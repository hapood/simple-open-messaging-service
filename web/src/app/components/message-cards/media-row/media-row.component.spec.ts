import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { CspSafeIcuTranspiler } from '../../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../../i18n/transloco.loader';
import {
  ImageDownloadService,
  type ImageDownloadTask,
} from '../../../services/image-download.service';
import { MediaSizeThresholdService } from '../../../services/media-size-threshold.service';
import type {
  AlbumMedia,
  AuthoredContentType,
  AuthoredMessageItem,
} from '../chat-item';
import { MediaRowComponent } from './media-row.component';

describe('MediaRowComponent — deferred image loading', () => {
  let downloads: FakeImageDownloads;

  beforeEach(() => {
    downloads = new FakeImageDownloads();
    TestBed.configureTestingModule({
      imports: [MediaRowComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: ['en'],
            defaultLang: 'en',
          },
          loader: InlineTranslocoLoader,
        }),
        provideTranslocoTranspiler(CspSafeIcuTranspiler),
        { provide: ImageDownloadService, useValue: downloads },
        {
          provide: MediaSizeThresholdService,
          useValue: {
            shouldDefer: (size: number) => size > 1024,
            isLoaded: () => false,
            markLoaded: () => undefined,
          },
        },
      ],
    });
  });

  it.each(['IMAGE', 'VIDEO'] as const)(
    'renders a clickable origin quote on %s without opening its media',
    async (contentType) => {
      const media = image(1, 4096);
      const fixture = await render([media], contentType);
      const anchor = { kind: 'origin' as const, namespaceId: 3, originSeq: 4 };
      fixture.componentRef.setInput('data', {
        ...message([media], contentType),
        quote: { anchor },
      });
      fixture.detectChanges();
      await fixture.whenStable();
      const jumped = vi.fn();
      const opened = vi.fn();
      fixture.componentInstance.quoteJump.subscribe(jumped);
      fixture.componentInstance.openImage.subscribe(opened);
      const quote = fixture.nativeElement.querySelector(
        'button.msg-quote',
      ) as HTMLButtonElement;
      expect(quote.textContent).toContain('Click to view quoted message');
      quote.click();
      expect(jumped).toHaveBeenCalledWith(anchor);
      expect(opened).not.toHaveBeenCalled();
      fixture.destroy();
    },
  );

  it('opens the viewer without rendering the old click-to-load copy', async () => {
    const images = [image(1, 4096)];
    const fixture = await render(images);
    const opened = vi.fn().mockName('opened');
    fixture.componentInstance.openImage.subscribe(opened);

    const gate = fixture.nativeElement.querySelector(
      '.msg-media-tap',
    ) as HTMLElement;
    expect(gate).not.toBeNull();
    expect(gate.textContent?.trim()).toBe('');

    (
      fixture.nativeElement.querySelector('.msg-media-cell') as HTMLElement
    ).click();
    expect(opened).toHaveBeenCalledWith({ images, index: 0 });
  });

  it('renders only a passive determinate rail in the chat card', async () => {
    const media = image(1, 4096);
    downloads.set(task(media, 'downloading', 400, 1000));
    const fixture = await render([media]);

    const rail = fixture.nativeElement.querySelector(
      '.msg-media-progress',
    ) as HTMLElement;
    expect(rail).not.toBeNull();
    expect((rail.querySelector('span') as HTMLElement).style.width).toBe('40%');
    expect(
      fixture.nativeElement.querySelector('.msg-media-cell button'),
    ).toBeNull();
  });

  it('updates the mounted image message when a shared download reports progress', async () => {
    const media = image(1, 4096);
    const fixture = await render([media]);

    expect(
      fixture.nativeElement.querySelector('.msg-media-download-progress'),
    ).toBeNull();

    downloads.set(task(media, 'downloading', 400, 1000));
    await fixture.whenStable();

    const progress = fixture.nativeElement.querySelector(
      '.msg-media-download-progress',
    ) as HTMLElement;
    expect(progress).not.toBeNull();
    expect(progress.textContent?.trim()).toBe('40%');
    expect(
      (
        fixture.nativeElement.querySelector(
          '.msg-media-progress > span',
        ) as HTMLElement
      ).style.width,
    ).toBe('40%');
  });

  it('renders a gallery as a compact fixed-width attachment card with stacked type icons', async () => {
    const fixture = await render(
      [file(1, 'notes.pdf'), image(2, 1024), image(3, 4096)],
      'GALLERY',
    );
    const bubble = fixture.nativeElement.querySelector(
      '.msg-media',
    ) as HTMLElement;

    expect(bubble.classList).toContain('msg-media--gallery');
    expect(
      getComputedStyle(fixture.nativeElement.querySelector('.msg-media-frame'))
        .width,
    ).toBe('280px');
    expect(
      fixture.nativeElement.querySelectorAll('.msg-gallery-icon').length,
    ).toBe(3);
    expect(
      fixture.nativeElement.querySelectorAll('.msg-gallery-thumbnail').length,
    ).toBe(1);
    const thumbnail = fixture.nativeElement.querySelector(
      '.msg-gallery-thumbnail',
    ) as HTMLImageElement;
    thumbnail.dispatchEvent(new Event('load'));
    expect(thumbnail.style.opacity).toBe('1');
    expect(
      fixture.nativeElement.querySelector(
        '.msg-gallery-icon--image:not(:has(.msg-gallery-thumbnail)) .msg-gallery-icon-svg',
      ),
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('.msg-gallery-row mat-icon'),
    ).toBeNull();
    expect(
      fixture.nativeElement
        .querySelector('.msg-gallery-title')
        ?.textContent?.trim(),
    ).toBe('File set');
    expect(fixture.nativeElement.querySelector('.msg-media-cell')).toBeNull();
    expect(fixture.nativeElement.querySelector('.msg-media-image')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('.msg-media-meta-count')?.textContent,
    ).toContain('3 Files');
  });

  it('opens a mixed file group at its first image', async () => {
    const images = [file(2, 'notes.pdf'), image(1, 1024), image(3, 1024)];
    const fixture = await render(images, 'GALLERY');
    const opened = vi.fn().mockName('opened');
    fixture.componentInstance.openImage.subscribe(opened);

    (
      fixture.nativeElement.querySelector('.msg-gallery-row') as HTMLElement
    ).click();
    expect(opened).toHaveBeenCalledWith({ images, index: 1 });
  });

  it('uses an already-cached thumbnail for an oversized image icon', async () => {
    const oversized = image(1, 4096);
    downloads.cache(oversized);
    const fixture = await render([oversized, file(2, 'notes.pdf')], 'GALLERY');
    const thumbnail = fixture.nativeElement.querySelector(
      '.msg-gallery-thumbnail',
    ) as HTMLImageElement;

    expect(thumbnail).not.toBeNull();
    expect(thumbnail.getAttribute('src')).toBe('cache:/uploads/1.jpg');
  });

  it('shows an oversized local blob preview without applying the remote cache gate', async () => {
    const local = { ...image(1, 4096), src: 'blob:local-preview' };
    const fixture = await render([local, file(2, 'notes.pdf')], 'GALLERY');
    const markLoaded = vi
      .spyOn(fixture.componentInstance, 'onImageLoad')
      .mockReturnValue(undefined);
    const thumbnail = fixture.nativeElement.querySelector(
      '.msg-gallery-thumbnail',
    ) as HTMLImageElement;

    expect(thumbnail.getAttribute('src')).toBe('blob:local-preview');
    thumbnail.dispatchEvent(new Event('load'));
    expect(thumbnail.style.opacity).toBe('1');
    expect(markLoaded).not.toHaveBeenCalled();
  });

  it('treats an absent federated media status as ready', async () => {
    const fixture = await render([image(1, 1024)]);

    expect(fixture.nativeElement.querySelector('.msg-media-status')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Download failed');
  });

  it('uses five type icons plus an ellipsis when a group contains more than six files', async () => {
    const images = Array.from({ length: 7 }, (_, index) =>
      index % 2 === 0
        ? image(index + 1, 1024)
        : file(index + 1, `file-${index + 1}.pdf`),
    );
    const fixture = await render(images, 'GALLERY');
    const icons = fixture.nativeElement.querySelectorAll('.msg-gallery-icon');

    expect(icons.length).toBe(6);
    expect(icons[5].classList).toContain('msg-gallery-icon--more');
    expect(icons[5].querySelectorAll('circle').length).toBe(3);
  });

  async function render(
    images: AlbumMedia[],
    contentType: AuthoredContentType = 'IMAGE',
  ) {
    const fixture = TestBed.createComponent(MediaRowComponent);
    fixture.componentRef.setInput('data', message(images, contentType));
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }
});

class FakeImageDownloads {
  readonly tasks = signal<ImageDownloadTask[]>([]);
  readonly thumbnailVersion = signal(0);
  private readonly byKey = new Map<string, ImageDownloadTask>();
  private readonly cached = new Set<string>();

  key(media: Pick<AlbumMedia, 'msgId' | 'src'>): string {
    return `${media.msgId ?? 0}:${media.src}`;
  }

  task(
    media: Pick<AlbumMedia, 'msgId' | 'src'>,
  ): ImageDownloadTask | undefined {
    return this.byKey.get(this.key(media));
  }

  displayUrl(media: AlbumMedia): string {
    return this.task(media)?.blobUrl ?? media.src;
  }

  thumbnailUrl(media: AlbumMedia): string {
    return media.src;
  }

  cachedThumbnailUrl(media: AlbumMedia): string {
    return this.cached.has(this.key(media)) ? `cache:${media.src}` : '';
  }

  cache(media: AlbumMedia): void {
    this.cached.add(this.key(media));
    this.thumbnailVersion.update((value) => value + 1);
  }

  set(value: ImageDownloadTask): void {
    this.byKey.set(value.key, value);
    this.tasks.set([...this.byKey.values()]);
  }
}

function image(msgId: number, size: number): AlbumMedia {
  return {
    kind: 'image',
    src: `/uploads/${msgId}.jpg`,
    w: 400,
    h: 300,
    size,
    msgId,
  };
}

function file(msgId: number, name: string): AlbumMedia {
  return {
    kind: 'file',
    src: `/uploads/${msgId}`,
    w: 0,
    h: 0,
    size: 512,
    name,
    mimeType: 'application/pdf',
    msgId,
  };
}

function task(
  media: AlbumMedia,
  status: ImageDownloadTask['status'],
  loaded: number,
  total: number,
): ImageDownloadTask {
  return {
    key: `${media.msgId}:${media.src}`,
    threadId: 1,
    msgId: media.msgId ?? 0,
    src: media.src,
    name: `${media.msgId}.jpg`,
    expectedSize: media.size ?? 0,
    loaded,
    total,
    status,
    saveAfterLoad: false,
    blobUrl: status === 'loaded' ? `blob:${media.msgId}` : null,
    startedAt: 1,
  };
}

function message(
  images: AlbumMedia[],
  contentType: AuthoredContentType = 'IMAGE',
): AuthoredMessageItem {
  return {
    type: 'msg',
    msgId: images[0]?.msgId ?? 1,
    creator: JSON.stringify([1, 'alice']),
    isSelf: false,
    name: 'Alice',
    text: '',
    time: '12:00',
    contentType,
    images,
    file: null,
    createdAtMs: 1,
  };
}
