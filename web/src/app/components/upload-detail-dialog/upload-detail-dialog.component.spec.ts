import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { of } from 'rxjs';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import { MediaTransferService } from '../../services/media-transfer.service';
import { MsgService } from '../../services/message.service';
import { WebdbService } from '../../services/webdb.service';
import { RouteService } from '../../services/route.service';
import { UploadDetailDialogComponent } from './upload-detail-dialog.component';

describe('UploadDetailDialogComponent task subscriptions', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [UploadDetailDialogComponent],
      providers: [
        provideZonelessChangeDetection(), provideHttpClient(),
        provideTransloco({ config: { availableLangs: ['en'], defaultLang: 'en' }, loader: InlineTranslocoLoader }),
        { provide: MsgService, useValue: { cancelUploadBatch: () => of({ code: 0 }) } },
        { provide: WebdbService, useValue: {
          enqueuePendingSend: vi.fn(async () => undefined),
          pendingSend: vi.fn(async () => null),
          removePendingSend: vi.fn(async () => undefined),
        } },
        { provide: RouteService, useValue: { closeDlg: vi.fn() } },
      ],
    });
  });

  async function enqueue(cid: string, threadId: number) {
    const outbox = TestBed.inject(ThreadSendOutbox);
    await outbox.enqueue({ clientMessageId: cid, threadId, item: {
      type: 'FILE', file: { path: cid, partId: cid, name: `${cid}.txt`, mimeType: 'text/plain', size: 100 },
    } });
    TestBed.inject(MediaTransferService).start(cid, 100);
    return outbox;
  }

  it('receives snapshots, progress deltas and removal for the selected thread', async () => {
    const outbox = await enqueue('first', 10);
    await enqueue('second', 20);
    const fixture = TestBed.createComponent(UploadDetailDialogComponent);
    fixture.componentRef.setInput('threadId', 10);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.uploads().map(row => row.clientMessageId)).toEqual(['first']);
    TestBed.inject(MediaTransferService).progress('first', 42, 100);
    await fixture.whenStable();
    expect(fixture.componentInstance.uploads()[0].loaded).toBe(42);
    fixture.componentRef.setInput('threadId', 20);
    await fixture.whenStable();
    expect(fixture.componentInstance.uploads().map(row => row.clientMessageId)).toEqual(['second']);
    TestBed.inject(MediaTransferService).progress('first', 90, 100);
    await fixture.whenStable();
    expect(fixture.componentInstance.uploads()[0].clientMessageId).toBe('second');
    await outbox.remove('second');
    await fixture.whenStable();
    expect(fixture.componentInstance.uploads()).toEqual([]);
    fixture.destroy();
    expect(TestBed.inject(MediaTransferService).isUploading('first')).toBe(true);
  });

  it('renders failure details without losing transmitted progress', async () => {
    const outbox = await enqueue('failed', 10);
    const fixture = TestBed.createComponent(UploadDetailDialogComponent);
    fixture.componentRef.setInput('threadId', 10);
    fixture.detectChanges();
    await fixture.whenStable();
    TestBed.inject(MediaTransferService).progress('failed', 73, 100);
    outbox.failUpload('failed', { kind: 'transport', message: 'connection lost' });
    await fixture.whenStable();
    expect(fixture.componentInstance.uploads()[0]).toMatchObject({ loaded: 73, status: 'failed', failure: 'connection lost' });
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('connection lost');
  });

  it('coalesces actions and permits retry after an operation error', async () => {
    const fixture = TestBed.createComponent(UploadDetailDialogComponent);
    fixture.componentRef.setInput('threadId', 10);
    let reject!: (error: Error) => void;
    const cancel = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const retry = vi.fn(async () => undefined);
    fixture.componentRef.setInput('messageActions', { cancel, retry });
    const panel = fixture.componentInstance;
    const first = panel.actOnMessage('cid', 'cancel');
    await panel.actOnMessage('cid', 'cancel');
    expect(cancel).toHaveBeenCalledTimes(1);
    reject(new Error('offline'));
    await first;
    expect(panel.messageActionFailed().has('cid')).toBe(true);
    await panel.actOnMessage('cid', 'retry');
    expect(retry).toHaveBeenCalledWith('cid');
    expect(panel.messageActionFailed().has('cid')).toBe(false);
  });
});
