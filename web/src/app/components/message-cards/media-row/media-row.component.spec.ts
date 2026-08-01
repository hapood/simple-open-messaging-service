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
import type { AlbumImage, ChatMsgData } from '../chat-item';
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
            threshold: signal(1024),
            isLoaded: () => false,
            markLoaded: () => undefined,
          },
        },
      ],
    });
  });

  it('opens the viewer without rendering the old click-to-load copy', async () => {
    const images = [image(1, 4096)];
    const fixture = await render(images);
    const opened = jasmine.createSpy('opened');
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

  async function render(images: AlbumImage[]) {
    const fixture = TestBed.createComponent(MediaRowComponent);
    fixture.componentRef.setInput('data', message(images));
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }
});

class FakeImageDownloads {
  readonly tasks = signal<ImageDownloadTask[]>([]);
  readonly thumbnailVersion = signal(0);
  private readonly byKey = new Map<string, ImageDownloadTask>();

  key(media: Pick<AlbumImage, 'msgId' | 'src'>): string {
    return `${media.msgId ?? 0}:${media.src}`;
  }

  task(
    media: Pick<AlbumImage, 'msgId' | 'src'>,
  ): ImageDownloadTask | undefined {
    return this.byKey.get(this.key(media));
  }

  displayUrl(media: AlbumImage): string {
    return this.task(media)?.blobUrl ?? media.src;
  }

  thumbnailUrl(media: AlbumImage): string {
    return media.src;
  }

  set(value: ImageDownloadTask): void {
    this.byKey.set(value.key, value);
    this.tasks.set([...this.byKey.values()]);
  }
}

function image(msgId: number, size: number): AlbumImage {
  return {
    kind: 'image',
    src: `/uploads/${msgId}.jpg`,
    w: 400,
    h: 300,
    size,
    msgId,
  };
}

function task(
  media: AlbumImage,
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

function message(images: AlbumImage[]): ChatMsgData {
  return {
    type: 'msg',
    msgId: images[0]?.msgId ?? 1,
    creator: 2,
    isSelf: false,
    name: 'Alice',
    text: '',
    time: '12:00',
    contentType: 'IMAGE',
    images,
    file: null,
    createdAtMs: 1,
  };
}
