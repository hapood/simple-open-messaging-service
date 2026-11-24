import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { InlineTranslocoLoader } from '../../../i18n/transloco.loader';
import {
  MediaFileProgressService,
  type MediaFileProgress,
} from '../../../services/media-file-progress.service';
import type { ChatMsgData } from '../chat-item';
import { FileRowComponent } from './file-row.component';

const message: ChatMsgData = {
  type: 'msg',
  contentType: 'FILE',
  msgId: 42,
  creator: 'alice',
  isSelf: false,
  name: 'Alice',
  text: '',
  time: '12:00',
  createdAtMs: 123,
  images: null,
  file: {
    url: '/uploads/empty.abc',
    name: 'empty.abc',
    size: 0,
    mimeType: 'application/x-abc',
  },
};

describe('FileRowComponent shared resource presentation', () => {
  it('renders unknown files with required metadata and keeps opening independent of server readiness', async () => {
    const progress = new Subject<MediaFileProgress>();
    const observe = vi.fn(() => progress);
    TestBed.configureTestingModule({
      imports: [FileRowComponent],
      providers: [
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        { provide: MediaFileProgressService, useValue: { observe } },
      ],
    });
    const fixture = TestBed.createComponent(FileRowComponent);
    fixture.componentRef.setInput('data', message);
    fixture.detectChanges();
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;
    const height = root.offsetHeight;
    expect(root.querySelector('.msg-file-name')?.textContent).toContain(
      'empty.abc',
    );
    expect(root.querySelector('.msg-file-size')?.textContent).toContain('0 B');
    expect(
      root.querySelector('app-file-icon')?.getAttribute('data-category'),
    ).toBe('unknown');
    expect(root.querySelector('.unknown-mark')).not.toBeNull();
    expect(root.querySelector('.extension')?.textContent).toContain('ABC');
    expect(
      root.querySelector('app-media-download-overlay [role="progressbar"]'),
    ).not.toBeNull();
    expect(observe).toHaveBeenCalledOnce();
    const opened = vi.fn();
    fixture.componentInstance.openFile.subscribe(opened);
    root.querySelector<HTMLElement>('.msg-file-row')!.click();
    expect(opened).toHaveBeenCalledOnce();
    progress.next({
      status: 'ready',
      loaded: 0,
      total: 0,
      bytesPerSecond: null,
    });
    await fixture.whenStable();
    expect(root.querySelector('.mask')).toBeNull();
    expect(root.offsetHeight).toBe(height);
    root
      .querySelector<HTMLElement>('.msg-file-row')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(opened).toHaveBeenCalledTimes(2);
    fixture.destroy();
    expect(progress.observed).toBe(false);
  });
});
