import { TestBed } from '@angular/core/testing';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { of, Subject } from 'rxjs';
import { CspSafeIcuTranspiler } from '../../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../../i18n/transloco.loader';
import {
  MediaFileProgressService,
  type MediaFileProgress,
} from '../../../services/media-file-progress.service';
import type { AlbumMedia, ImageMedia, AuthoredMessageItem } from '../chat-item';
import { MediaRowComponent } from './media-row.component';

describe('MediaRowComponent thumbnail composition', () => {
  const observe = vi.fn();
  beforeEach(() => {
    observe
      .mockReset()
      .mockReturnValue(
        of({ status: 'ready', loaded: 100, total: 100, bytesPerSecond: null }),
      );
    TestBed.configureTestingModule({
      imports: [MediaRowComponent],
      providers: [
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        provideTranslocoTranspiler(CspSafeIcuTranspiler),
        { provide: MediaFileProgressService, useValue: { observe } },
      ],
    });
  });

  async function render(
    images: AlbumMedia[],
    contentType: Extract<
      AuthoredMessageItem,
      { images: AlbumMedia[] }
    >['contentType'] = 'IMAGE',
  ) {
    const fixture = TestBed.createComponent(MediaRowComponent);
    fixture.componentRef.setInput('data', message(images, contentType));
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  it.each(['IMAGE', 'VIDEO'] as const)(
    'keeps quote navigation separate from opening %s',
    async (kind) => {
      const images = [image(1)];
      const fixture = await render(images, kind);
      const anchor = { kind: 'origin' as const, namespaceId: 3, originSeq: 4 };
      fixture.componentRef.setInput('data', {
        ...message(images, kind),
        quote: { kind: 'jumpable', anchor },
      });
      await fixture.whenStable();
      const jump = vi.fn();
      const open = vi.fn();
      fixture.componentInstance.quoteJump.subscribe(jump);
      fixture.componentInstance.openImage.subscribe(open);
      fixture.nativeElement.querySelector('button.msg-quote').click();
      expect(jump).toHaveBeenCalledWith(anchor);
      expect(open).not.toHaveBeenCalled();
      fixture.destroy();
    },
  );

  it('interpolates absorbed cell height in integer pixels inside a stable final album allocation', async () => {
    const fixture = await render([image(1)]);
    const root: HTMLElement = fixture.nativeElement;
    const first = root.querySelector<HTMLElement>('app-album-media-cell')!;
    const frames: Array<{ height: number; top: number; allocation: number }> =
      [];
    const callbacks: FrameRequestCallback[] = [];
    const request = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callbacks.push(callback);
        return callbacks.length;
      });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    try {
      fixture.componentRef.setInput(
        'data',
        message([image(1), image(2)], 'IMAGE'),
      );
      fixture.detectChanges();
      await fixture.whenStable();
      const start = performance.now();
      for (const offset of [16, 40, 80, 120, 180, 220]) {
        const pending = callbacks.splice(0);
        for (const callback of pending) callback(start + offset);
        frames.push({
          height: parseFloat(first.style.height),
          top: parseFloat(first.style.top),
          allocation: first.parentElement!.offsetHeight,
        });
      }
      expect(new Set(frames.map((frame) => frame.height)).size).toBeGreaterThan(
        1,
      );
      expect(new Set(frames.map((frame) => frame.allocation)).size).toBe(1);
      expect(
        frames.every(
          (frame) =>
            Number.isInteger(frame.height) && Number.isInteger(frame.top),
        ),
      ).toBe(true);
      expect(getComputedStyle(first).transitionProperty).not.toMatch(
        /height|top/,
      );
      fixture.componentRef.setInput('data', message([image(1)], 'IMAGE'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.destroy();
      expect(cancel).toHaveBeenCalled();
    } finally {
      request.mockRestore();
      cancel.mockRestore();
      clock.mockRestore();
    }
  });

  it('composes album cells without observing original client downloads', async () => {
    const images = [
      image(1),
      { ...image(2), kind: 'video' as const, duration: 12 },
    ];
    const fixture = await render(images);
    expect(
      fixture.nativeElement.querySelectorAll('app-album-media-cell'),
    ).toHaveLength(2);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(fixture.nativeElement.querySelector('video')).toBeNull();
    const opened = vi.fn();
    fixture.componentInstance.openImage.subscribe(opened);
    fixture.nativeElement.querySelector('app-album-media-cell').click();
    expect(opened).toHaveBeenCalledWith({ images, index: 0 });
    fixture.destroy();
  });

  it.each(['pending', 'downloading', 'failed', 'ready'] as const)(
    'opens video details regardless of stale message status %s',
    async (status) => {
      const images: AlbumMedia[] = [
        { ...image(1), kind: 'video', duration: 12 },
      ];
      const fixture = await render(images, 'VIDEO');
      fixture.componentRef.setInput('data', {
        ...message(images, 'VIDEO'),
        mediaStatus: status,
      });
      await fixture.whenStable();
      const opened = vi.fn();
      fixture.componentInstance.openImage.subscribe(opened);
      fixture.nativeElement.querySelector('app-album-media-cell').click();
      expect(opened).toHaveBeenCalledExactlyOnceWith({ images, index: 0 });
      fixture.destroy();
    },
  );

  it('opens audio details without intercepting playback controls', async () => {
    const images: AlbumMedia[] = [{ ...image(1), kind: 'audio', duration: 12 }];
    const fixture = await render(images, 'AUDIO');
    const opened = vi.fn();
    fixture.componentInstance.openImage.subscribe(opened);
    const root: HTMLElement = fixture.nativeElement;
    const cell = root.querySelector('app-album-media-cell');
    const rate = root.querySelector<HTMLButtonElement>('.ap-rate');
    if (!cell || !rate)
      throw new Error('Audio cell and controls must be mounted');
    rate.click();
    await fixture.whenStable();
    expect(rate.textContent).toContain('1.5');
    rate.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(opened).not.toHaveBeenCalled();
    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(opened).toHaveBeenCalledExactlyOnceWith({ images, index: 0 });
    fixture.destroy();
  });

  it('uses independent file progress even when the message status is stale', async () => {
    const first = new Subject<MediaFileProgress>();
    const second = new Subject<MediaFileProgress>();
    observe.mockImplementation((media: AlbumMedia) =>
      media.msgId === 1 ? first : second,
    );
    const images = [image(1), image(2)];
    const fixture = await render(images);
    fixture.componentRef.setInput('data', {
      ...message(images, 'IMAGE'),
      mediaStatus: 'downloading',
    });
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;
    const height = root.offsetHeight;
    const cells = root.querySelectorAll('app-album-media-cell');
    first.next({
      status: 'ready',
      loaded: 100,
      total: 100,
      bytesPerSecond: null,
    });
    second.next({
      status: 'downloading',
      loaded: 50,
      total: 100,
      bytesPerSecond: 2048,
    });
    await fixture.whenStable();
    expect(cells[0].querySelector('.mask')).toBeNull();
    expect(
      cells[1]
        .querySelector('[role="progressbar"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('50');
    expect(root.querySelector('app-federated-download-status')).toBeNull();
    expect(root.querySelector('.msg-media-status')).toBeNull();
    expect(root.querySelector('.speed')).toBeNull();
    second.next({
      status: 'ready',
      loaded: 100,
      total: 100,
      bytesPerSecond: null,
    });
    await fixture.whenStable();
    expect(root.querySelector('.mask')).toBeNull();
    expect(root.offsetHeight).toBe(height);
    fixture.destroy();
    expect(first.observed).toBe(false);
    expect(second.observed).toBe(false);
  });

  it('keeps the file caption clear of the shared icon and progress surface', async () => {
    const progress = new Subject<MediaFileProgress>();
    observe.mockReturnValue(progress);
    const files: AlbumMedia[] = [
      {
        kind: 'file',
        src: '/uploads/empty.abc',
        name: 'empty.abc',
        size: 0,
        mimeType: 'application/x-abc',
        senderName: null,
        sentAt: null,
        msgId: 1,
      },
    ];
    const fixture = await render(files);
    const root: HTMLElement = fixture.nativeElement;
    const cell = root.querySelector<HTMLElement>('app-album-media-cell');
    const caption = root.querySelector<HTMLElement>('.msg-media-file');
    if (!cell || !caption)
      throw new Error('File cell and caption must be mounted');
    const height = root.offsetHeight;
    expect(caption.textContent).toContain('empty.abc');
    expect(root.querySelector('.msg-media-size')?.textContent).toBe('0 B');
    expect(cell.querySelector('.unknown-mark')).not.toBeNull();
    expect(caption.offsetTop).toBeGreaterThan(cell.offsetHeight / 2 + 22);
    expect(caption.offsetHeight).toBe(20);
    expect(getComputedStyle(caption).pointerEvents).toBe('none');
    expect(cell.querySelector('[role="progressbar"]')).not.toBeNull();
    progress.next({
      status: 'failed',
      loaded: 0,
      total: 0,
      bytesPerSecond: null,
    });
    await fixture.whenStable();
    expect(cell.querySelector('.mask mat-icon')?.textContent).toContain(
      'error_outline',
    );
    progress.next({
      status: 'ready',
      loaded: 0,
      total: 0,
      bytesPerSecond: null,
    });
    await fixture.whenStable();
    expect(cell.querySelector('.mask')).toBeNull();
    expect(cell.querySelector('.unknown-mark')).not.toBeNull();
    expect(root.offsetHeight).toBe(height);
    fixture.destroy();
  });

  it.each([6, 7, 8, 10, 104, 105])(
    'uses projected metadata for %s files with at most six slots',
    async (count) => {
      const images = Array.from({ length: count }, (_, index) =>
        image(index + 1),
      );
      const fixture = await render(images, 'GALLERY');
      const slots = fixture.nativeElement.querySelectorAll('.msg-gallery-icon');
      expect(slots).toHaveLength(6);
      expect(
        fixture.nativeElement.querySelectorAll('app-album-media-cell'),
      ).toHaveLength(count > 6 ? 5 : 6);
      expect(observe).toHaveBeenCalledTimes(count > 6 ? 5 : 6);
      expect(slots[5].classList.contains('msg-gallery-icon--more')).toBe(
        count > 6,
      );
      if (count > 6) {
        expect(slots[5].textContent.trim()).toBe(
          count > 104 ? '…' : `+${count - 5}`,
        );
        expect(slots[5].querySelector('app-album-media-cell')).toBeNull();
        expect(slots[5].querySelector('[role="progressbar"]')).toBeNull();
        expect(observe.mock.calls.map(([media]) => media.msgId)).toEqual([
          1, 2, 3, 4, 5,
        ]);
      }
      expect(
        fixture.nativeElement.querySelector('.msg-gallery-row').offsetHeight,
      ).toBe(62);
      expect(
        fixture.nativeElement.querySelector('.msg-media-meta-count')
          .textContent,
      ).toContain(String(count));
      fixture.destroy();
    },
  );

  it('uses cells for every file kind and opens the full mixed group at its first image', async () => {
    const images: AlbumMedia[] = [
      { ...image(1), kind: 'file', name: 'notes.pdf' },
      { ...image(2), kind: 'audio', duration: 12 },
      image(3),
      { ...image(4), kind: 'video', duration: 12 },
    ];
    const fixture = await render(images, 'GALLERY');
    expect(observe).toHaveBeenCalledTimes(4);
    expect(
      fixture.nativeElement.querySelectorAll('app-album-media-cell'),
    ).toHaveLength(4);
    expect(fixture.nativeElement.querySelector('.speed')).toBeNull();
    const opened = vi.fn();
    fixture.componentInstance.openImage.subscribe(opened);
    fixture.nativeElement.querySelector('.msg-gallery-row').click();
    expect(opened).toHaveBeenCalledWith({ images, index: 2 });
    fixture.destroy();
  });

  it('keeps persisted self messages free of send-task controls after remount', async () => {
    const images = [{ ...image(1), kind: 'video' as const, duration: 12 }];
    for (let mount = 0; mount < 2; mount++) {
      const fixture = await render(images, 'VIDEO');
      fixture.componentRef.setInput('data', {
        ...message(images, 'VIDEO'),
        isSelf: true,
      });
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('.msg-status')).toBeNull();
      expect(
        fixture.nativeElement.querySelector('.msg-failed-actions'),
      ).toBeNull();
      expect(fixture.nativeElement.querySelector('.msg-sending')).toBeNull();
      fixture.destroy();
    }
  });
});

function image(msgId: number): ImageMedia {
  return {
    kind: 'image',
    src: `/uploads/${msgId}.jpg`,
    w: 400,
    h: 300,
    size: 1024,
    name: `${msgId}.jpg`,
    mimeType: 'image/jpeg',
    senderName: null,
    sentAt: null,
    msgId,
  };
}
function message(
  images: AlbumMedia[],
  contentType: Extract<
    AuthoredMessageItem,
    { images: AlbumMedia[] }
  >['contentType'],
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
