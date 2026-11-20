import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { DownloadService, type DownloadTaskEvent } from '../../services/download.service';
import { PopupType, RouteService } from '../../services/route.service';
import { DownloadButtonComponent } from './download-button.component';

describe('native download entry', () => {
  afterEach(() => { delete window.__TAURI_INTERNALS__; });
  function setup() {
    const events = new Subject<DownloadTaskEvent>();
    const popupDlg = vi.fn();
    TestBed.configureTestingModule({ imports: [DownloadButtonComponent], providers: [
      provideTransloco({ config: { availableLangs: ['en'], defaultLang: 'en' }, loader: InlineTranslocoLoader }),
      { provide: DownloadService, useValue: { watchAll: () => events } },
      { provide: RouteService, useValue: { popupDlg } },
    ] });
    const fixture = TestBed.createComponent(DownloadButtonComponent);
    fixture.detectChanges();
    return { fixture, events, popupDlg };
  }

  it('does not render an entry in the browser', () => {
    delete window.__TAURI_INTERNALS__;
    const { fixture, popupDlg } = setup();
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
    fixture.componentInstance.open();
    expect(popupDlg).not.toHaveBeenCalled();
  });

  it('animates only active downloads and opens the account-wide panel', () => {
    window.__TAURI_INTERNALS__ = {};
    const { fixture, events, popupDlg } = setup();
    const task = { id: 'download', request: { threadId: 20, path: '/file', filename: 'file', mimeType: 'application/octet-stream' }, loaded: 1, total: 10, phase: 'downloading' as const, error: null };
    events.next({ type: 'snapshot', tasks: [task] });
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.classList.contains('downloading')).toBe(true);
    button.click();
    expect(popupDlg).toHaveBeenCalledWith(PopupType.DOWNLOAD_DETAIL, {});
    events.next({ type: 'upsert', task: { ...task, phase: 'saving' } });
    fixture.detectChanges();
    expect(button.classList.contains('downloading')).toBe(false);
  });
});
