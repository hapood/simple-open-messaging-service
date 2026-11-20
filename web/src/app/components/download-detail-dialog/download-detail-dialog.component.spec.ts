import { By } from '@angular/platform-browser';
import { MatProgressBar } from '@angular/material/progress-bar';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { DownloadService, type DownloadTask, type DownloadTaskEvent } from '../../services/download.service';
import { RouteService, PopupType } from '../../services/route.service';
import { DownloadDetailDialogComponent } from './download-detail-dialog.component';

describe('account download panel', () => {
  function setup() {
    const events = new Subject<DownloadTaskEvent>();
    const service = { watchAll: () => events, cancel: vi.fn(), dismiss: vi.fn(), retry: vi.fn(async (): Promise<void> => undefined) };
    const closeDlg = vi.fn();
    TestBed.configureTestingModule({ imports: [DownloadDetailDialogComponent], providers: [
      provideTransloco({ config: { availableLangs: ['en'], defaultLang: 'en' }, loader: InlineTranslocoLoader }),
      { provide: DownloadService, useValue: service },
      { provide: RouteService, useValue: { closeDlg } },
    ] });
    const fixture = TestBed.createComponent(DownloadDetailDialogComponent);
    fixture.detectChanges();
    return { fixture, events, service, closeDlg };
  }
  function task(id: string, threadId: number): DownloadTask {
    return { id, request: { threadId, path: '/file', filename: id, mimeType: 'application/octet-stream' }, loaded: 3, total: 10, phase: 'downloading', error: null };
  }

  it('merges tasks from multiple conversations and removes individual rows', () => {
    const { fixture, events } = setup();
    events.next({ type: 'snapshot', tasks: [task('first', 1), task('second', 2)] });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('mat-list-item')).toHaveLength(2);
    events.next({ type: 'upsert', task: { ...task('first', 1), phase: 'failed', error: 'disk full' } });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('disk full');
    events.next({ type: 'remove', id: 'second' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('mat-list-item')).toHaveLength(1);
    fixture.destroy();
    expect(events.observed).toBe(false);
  });

  it('uses an indeterminate rail when the server has not supplied a total', () => {
    const { fixture, events } = setup();
    events.next({ type: 'snapshot', tasks: [{ ...task('unknown', 1), total: null }] });
    fixture.detectChanges();
    const progress = fixture.debugElement.query(By.directive(MatProgressBar)).componentInstance as MatProgressBar;
    expect(progress.mode).toBe('indeterminate');
    events.next({ type: 'upsert', task: { ...task('unknown', 1), loaded: 4, total: 10 } });
    fixture.detectChanges();
    const known = fixture.debugElement.query(By.directive(MatProgressBar)).componentInstance as MatProgressBar;
    expect(known.mode).toBe('determinate');
    expect(known.value).toBe(40);
  });

  it('keeps known zero-byte tasks determinate without division by zero', () => {
    const { fixture, events } = setup();
    events.next({ type: 'snapshot', tasks: [{ ...task('empty', 1), loaded: 0, total: 0, phase: 'completed' }] });
    fixture.detectChanges();
    const progress = fixture.debugElement.query(By.directive(MatProgressBar)).componentInstance as MatProgressBar;
    expect(progress.mode).toBe('determinate');
    expect(progress.value).toBe(100);
  });

  it('delegates actions and suppresses duplicate retries', async () => {
    const { fixture, service, closeDlg } = setup();
    let finish!: () => void;
    service.retry.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const panel = fixture.componentInstance;
    const running = panel.retry('task');
    await panel.retry('task');
    expect(service.retry).toHaveBeenCalledOnce();
    finish(); await running;
    expect(panel.busy().size).toBe(0);
    panel.cancel('task'); panel.dismiss('task'); panel.close();
    expect(service.cancel).toHaveBeenCalledWith('task');
    expect(service.dismiss).toHaveBeenCalledWith('task');
    expect(closeDlg).toHaveBeenCalledWith(PopupType.DOWNLOAD_DETAIL);
  });
});
