// @vitest-environment jsdom
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { ConversationListService } from '../../services/conversation-list.service';
import { MediaTransferService } from '../../services/media-transfer.service';
import { RouteService } from '../../services/route.service';
import { UploadDetailDialogComponent } from './upload-detail-dialog.component';

describe('UploadDetailDialogComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [UploadDetailDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        MediaTransferService,
        { useValue: { closeDlg: vi.fn() }, provide: RouteService },
        { useValue: { items: () => [] }, provide: ConversationListService },
      ],
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('offers send-completed and cancel actions for an active upload', () => {
    const transfers = TestBed.inject(MediaTransferService);
    const sendCompleted = vi.spyOn(transfers, 'sendCompleted');
    const discard = vi.spyOn(transfers, 'discard');
    transfers.start({
      clientMessageId: 'cid-gallery',
      threadId: 10,
      kind: 'file',
      name: 'gallery.zip',
      size: 100,
      supportsSendCompleted: true,
    });

    const fixture = TestBed.createComponent(UploadDetailDialogComponent);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;

    const sendCompletedButton = element.querySelector<HTMLButtonElement>(
      '.ud-action--send-done',
    );
    expect(sendCompletedButton).toBeTruthy();
    sendCompletedButton!.click();
    expect(sendCompleted).toHaveBeenCalledWith('cid-gallery');

    const buttons = [...element.querySelectorAll<HTMLButtonElement>('.ud-action')];
    const cancelButton = buttons.find(
      (button) => button !== sendCompletedButton,
    );
    expect(cancelButton).toBeTruthy();
    cancelButton!.click();
    expect(discard).toHaveBeenCalledWith('cid-gallery');
  });

  it('hides send-completed for single-file uploads', () => {
    const transfers = TestBed.inject(MediaTransferService);
    transfers.start({
      clientMessageId: 'cid-single',
      threadId: 10,
      kind: 'file',
      name: 'one.pdf',
      size: 100,
    });

    const fixture = TestBed.createComponent(UploadDetailDialogComponent);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;

    expect(element.querySelector('.ud-action--send-done')).toBeNull();
  });
});
