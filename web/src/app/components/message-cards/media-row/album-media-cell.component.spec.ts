import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { Observable, Subject } from 'rxjs';
import { InlineTranslocoLoader } from '../../../i18n/transloco.loader';
import {
  MediaFileProgressService,
  type MediaFileProgress,
} from '../../../services/media-file-progress.service';
import { AlbumMediaCellComponent } from './album-media-cell.component';
import type { AlbumMedia } from '../chat-item';

const media: AlbumMedia = {
  kind: 'image',
  src: '/uploads/msg-assets/aa/aa/' + 'a'.repeat(64) + '?threadId=1&seq=2',
  w: 400,
  h: 300,
  msgId: 2,
  size: 100,
  name: 'photo.jpg',
  mimeType: 'image/jpeg',
  senderName: null,
  sentAt: null,
};
const ready: MediaFileProgress = {
  status: 'ready',
  loaded: 100,
  total: 100,
  bytesPerSecond: null,
};

describe('AlbumMediaCellComponent', () => {
  let events: Subject<MediaFileProgress>;
  let stops: Array<ReturnType<typeof vi.fn>>;
  beforeEach(() => {
    events = new Subject();
    stops = [];
    TestBed.configureTestingModule({
      imports: [AlbumMediaCellComponent],
      providers: [
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        {
          provide: MediaFileProgressService,
          useValue: {
            observe: () =>
              new Observable<MediaFileProgress>((subscriber) => {
                const stop = vi.fn();
                stops.push(stop);
                const subscription = events.subscribe(subscriber);
                return () => {
                  stop();
                  subscription.unsubscribe();
                };
              }),
          },
        },
      ],
    });
  });
  async function mount(value: AlbumMedia = media) {
    const fixture = TestBed.createComponent(AlbumMediaCellComponent);
    fixture.componentRef.setInput('media', value);
    fixture.componentRef.setInput('rect', {
      xPct: 0,
      yPx: 0,
      wPct: 100,
      hPx: 120,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  it('owns independent observations for two cells with the same digest', async () => {
    const first = await mount();
    const second = await mount();
    first.destroy();
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(stops[1]).not.toHaveBeenCalled();
    events.next({
      status: 'downloading',
      loaded: 40,
      total: 100,
      bytesPerSecond: 12,
    });
    await second.whenStable();
    expect(
      second.nativeElement
        .querySelector('[role="progressbar"]')
        .getAttribute('aria-valuenow'),
    ).toBe('40');
    second.destroy();
    expect(stops[1]).toHaveBeenCalledOnce();
  });

  it('removes the download mask on readiness without waiting for the thumbnail load event', async () => {
    const fixture = await mount();
    const height = fixture.nativeElement.offsetHeight;
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    events.next({
      status: 'downloading',
      loaded: 0,
      total: 100,
      bytesPerSecond: 0,
    });
    await fixture.whenStable();
    expect(
      fixture.nativeElement
        .querySelector('[role="progressbar"]')
        .getAttribute('aria-valuenow'),
    ).toBe('0');
    events.next({
      status: 'downloading',
      loaded: 100,
      total: 100,
      bytesPerSecond: 10,
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    events.next(ready);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('img').getAttribute('src')).toBe(
      media.src.replace('msg-assets', 'thumbnails'),
    );
    expect(fixture.nativeElement.querySelector('.mask')).toBeNull();
    expect(fixture.nativeElement.offsetHeight).toBe(height);
    fixture.destroy();
  });

  it('keeps thumbnail failure separate from file readiness and resets for a new resource', async () => {
    const fixture = await mount();
    events.next(ready);
    await fixture.whenStable();
    fixture.nativeElement
      .querySelector('img')
      .dispatchEvent(new Event('error'));
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('app-media-thumbnail mat-icon')
        .textContent,
    ).toContain('broken_image');
    expect(fixture.componentInstance.state().status).toBe('ready');
    expect(fixture.nativeElement.querySelector('.mask')).toBeNull();
    expect(stops).toHaveLength(1);
    fixture.componentRef.setInput('media', {
      ...media,
      src: 'blob:new-preview',
    });
    await fixture.whenStable();
    events.next(ready);
    await fixture.whenStable();
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.querySelector('img').getAttribute('src')).toBe(
      'blob:new-preview',
    );
    fixture.destroy();
  });

  const { w, h, ...base } = media;
  const resources: AlbumMedia[] = [
    media,
    { ...base, kind: 'video', w, h, duration: 12 },
    { ...base, kind: 'audio', duration: 12 },
    { ...base, kind: 'file' },
  ];
  it.each(resources)(
    'uses the same download mask for $kind',
    async (resource) => {
      const fixture = await mount(resource);
      const height = fixture.nativeElement.offsetHeight;
      expect(stops).toHaveLength(1);
      expect(
        fixture.nativeElement.querySelector(
          'app-media-download-overlay [role="progressbar"]',
        ),
      ).not.toBeNull();
      events.next(ready);
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('.mask')).toBeNull();
      expect(fixture.nativeElement.offsetHeight).toBe(height);
      fixture.destroy();
    },
  );

  it.each([
    ['report.pdf', 'application/pdf', 'pdf', 'PDF', false],
    ['archive.abc', 'application/x-abc', 'unknown', 'ABC', true],
    ['README', 'application/octet-stream', 'unknown', 'FILE', true],
  ])(
    'renders file format %s independently of server readiness',
    async (name, mimeType, category, extension, unknown) => {
      const fixture = await mount({
        ...base,
        kind: 'file',
        name: name as string,
        mimeType: mimeType as string,
      });
      const height = fixture.nativeElement.offsetHeight;
      const icon = fixture.nativeElement.querySelector('app-file-icon');
      expect(icon.getAttribute('data-category')).toBe(category);
      expect(icon.querySelector('.unknown-mark') !== null).toBe(unknown);
      expect(icon.querySelector('.extension')?.textContent.trim() ?? '').toBe(
        extension,
      );
      expect(
        fixture.nativeElement.querySelector('[role="progressbar"]'),
      ).not.toBeNull();
      events.next(ready);
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('.mask')).toBeNull();
      expect(fixture.nativeElement.querySelector('app-file-icon')).toBe(icon);
      expect(fixture.nativeElement.offsetHeight).toBe(height);
      fixture.destroy();
    },
  );

  it('mounts audio playback only after server readiness', async () => {
    const fixture = await mount({ ...base, kind: 'audio', duration: 12 });
    fixture.componentRef.setInput('audioPlayback', true);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('audio')).toBeNull();
    events.next(ready);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('audio')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.mask')).toBeNull();
    fixture.destroy();
  });

  it('shows server speed only when requested, independently of sizing', async () => {
    const outer = await mount();
    const detail = await mount();
    detail.componentRef.setInput('showSpeed', true);
    events.next({
      status: 'downloading',
      loaded: 40,
      total: 100,
      bytesPerSecond: 1024,
    });
    await Promise.all([outer.whenStable(), detail.whenStable()]);
    expect(outer.nativeElement.querySelector('.speed')).toBeNull();
    expect(detail.nativeElement.querySelector('.speed').textContent).toBe(
      '1.0 KB/s',
    );
    events.next({
      status: 'downloading',
      loaded: 40,
      total: 100,
      bytesPerSecond: 0,
    });
    await detail.whenStable();
    expect(detail.nativeElement.querySelector('.speed').textContent).toBe(
      '0 B/s',
    );
    events.next(ready);
    await detail.whenStable();
    expect(detail.nativeElement.querySelector('.speed')).toBeNull();
    outer.destroy();
    detail.destroy();
  });
});
