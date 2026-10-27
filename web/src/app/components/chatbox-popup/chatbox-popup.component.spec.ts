// @vitest-environment jsdom
import {
  Component,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { DlgInfo, RouteService } from '../../services/route.service';
import { ChatboxPopupComponent } from './chatbox-popup.component';

@Component({
  template: '<div>Dummy Dialog</div>',
  standalone: true,
})
class DummyDialogComponent {}

describe('ChatboxPopupComponent', () => {
  let closeDlg: ReturnType<typeof vi.fn>;
  const dlgList = signal<DlgInfo[]>([]);

  beforeEach(() => {
    closeDlg = vi.fn();
    dlgList.set([]);

    TestBed.configureTestingModule({
      imports: [ChatboxPopupComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        {
          provide: RouteService,
          useValue: { dlgList, closeDlg },
        },
      ],
    });
  });

  function createComponent(threadId = 10) {
    const fixture = TestBed.createComponent(ChatboxPopupComponent);
    fixture.componentRef.setInput('threadId', threadId);
    fixture.detectChanges();
    return fixture;
  }

  it('closes dialog on backdrop click when disableClose is false/absent', () => {
    dlgList.set([
      {
        id: 1,
        component: DummyDialogComponent,
        presentation: 'chatbox',
        desktopSize: 'standard',
        desktopHeight: 'content',
        scopeThreadId: 10,
        disableClose: false,
      },
    ]);

    const fixture = createComponent(10);
    const element: HTMLElement = fixture.nativeElement;
    const backdrop = element.querySelector<HTMLButtonElement>(
      '.chatbox-popup__backdrop',
    )!;
    expect(backdrop).not.toBeNull();

    backdrop.click();
    expect(closeDlg).toHaveBeenCalledTimes(1);
  });

  it('prevents backdrop close when topmost dialog has disableClose=true', () => {
    dlgList.set([
      {
        id: 1,
        component: DummyDialogComponent,
        presentation: 'chatbox',
        desktopSize: 'standard',
        desktopHeight: 'content',
        scopeThreadId: 10,
        disableClose: true,
      },
    ]);

    const fixture = createComponent(10);
    const element: HTMLElement = fixture.nativeElement;
    const backdrop = element.querySelector<HTMLButtonElement>(
      '.chatbox-popup__backdrop',
    )!;
    expect(backdrop).not.toBeNull();
    expect(backdrop.classList).toContain('chatbox-popup__backdrop--disabled');

    backdrop.click();
    expect(closeDlg).not.toHaveBeenCalled();
  });
});
