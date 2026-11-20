import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { SendingTaskPresentation } from '../../services/sending-task-presentation.service';
import { TailSendingCueComponent } from './tail-sending-cue.component';

describe('tail sending cue', () => {
  it('keeps dots during mixed success/failure, then shows failures only, and disappears when cleared', async () => {
    const summary = signal({ messageCount: 1, uploadCount: 0, failedCount: 2 });
    TestBed.configureTestingModule({ providers: [
      { provide: SendingTaskPresentation, useValue: { forThread: () => summary() } },
      provideTransloco({ config: { availableLangs: ['en'], defaultLang: 'en' }, loader: InlineTranslocoLoader }),
    ] });
    const fixture = TestBed.createComponent(TailSendingCueComponent);
    fixture.componentRef.setInput('summary', summary());
    fixture.componentRef.setInput('continuation', true);
    fixture.componentRef.setInput('enabled', true);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.dots')).not.toBeNull();
    expect(el.querySelector('app-outbox-indicator')).toBeNull();
    summary.set({ messageCount: 2, uploadCount: 1, failedCount: 2 });
    fixture.componentRef.setInput('summary', summary());
    fixture.detectChanges();
    expect(el.querySelector('app-outbox-indicator')).not.toBeNull();
    expect(el.querySelector('.faces, .bio')).toBeNull();
    expect(el.querySelector('.failures svg')).toBeNull();
    summary.set({ messageCount: 0, uploadCount: 0, failedCount: 2 });
    fixture.componentRef.setInput('summary', summary());
    fixture.detectChanges();
    expect(el.querySelector('.dots')).toBeNull();
    expect(el.querySelector('.failures svg')).not.toBeNull();
    summary.set({ messageCount: 0, uploadCount: 0, failedCount: 0 });
    fixture.componentRef.setInput('summary', summary());
    fixture.detectChanges();
    expect(el.querySelector('.msg-row')).toBeNull();
    fixture.destroy();
  });
});
