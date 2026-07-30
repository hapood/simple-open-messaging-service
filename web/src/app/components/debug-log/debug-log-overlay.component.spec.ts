import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DiagnosticsReportService } from '../../services/diagnostics-report.service';
import { DebugLogOverlayComponent } from './debug-log-overlay.component';

describe('DebugLogOverlayComponent diagnostics upload', () => {
  let fixture: ComponentFixture<DebugLogOverlayComponent>;
  let reports: jasmine.SpyObj<DiagnosticsReportService>;

  beforeEach(async () => {
    reports = jasmine.createSpyObj<DiagnosticsReportService>(
      'DiagnosticsReportService',
      ['upload'],
    );
    await TestBed.configureTestingModule({
      imports: [DebugLogOverlayComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DiagnosticsReportService, useValue: reports },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DebugLogOverlayComponent);
    Object.defineProperty(fixture.componentInstance, 'rustAvailable', {
      value: true,
    });
    fixture.detectChanges();
  });

  afterEach(() => fixture.destroy());

  it('requires confirmation before uploading a full diagnostic bundle', () => {
    fixture.componentInstance.beginUpload();
    fixture.detectChanges();

    expect(reports.upload).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('may contain URLs');
    expect(fixture.nativeElement.textContent).toContain('Confirm upload');
  });

  it('shows the report id after a successful upload', async () => {
    reports.upload.and.resolveTo(42);
    fixture.componentInstance.beginUpload();
    await fixture.componentInstance.uploadReport();

    expect(reports.upload).toHaveBeenCalledOnceWith();
    expect(fixture.componentInstance.uploadState()).toBe('idle');
    expect(fixture.componentInstance.actionNotice()).toContain('#42');
  });

  it('reports a retained retry bundle when upload fails', async () => {
    reports.upload.and.rejectWith(new Error('offline'));
    fixture.componentInstance.beginUpload();
    await fixture.componentInstance.uploadReport();

    expect(fixture.componentInstance.uploadState()).toBe('idle');
    expect(fixture.componentInstance.actionNotice()).toContain(
      'retained for retry',
    );
  });
});
