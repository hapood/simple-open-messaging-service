import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DiagnosticsReportService } from '../../services/diagnostics-report.service';
import { DebugToolsService } from '../../services/debug-tools.service';
import { DebugLogFabComponent } from './debug-log-fab.component';

describe('DebugLogFabComponent', () => {
  let fixture: ComponentFixture<DebugLogFabComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DebugLogFabComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: DebugToolsService,
          useValue: { enabled: () => true },
        },
        {
          provide: DiagnosticsReportService,
          useValue: { upload: jasmine.createSpy('upload') },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DebugLogFabComponent);
    fixture.detectChanges();
  });

  afterEach(() => fixture.destroy());

  it('starts with the floating trigger centered in the viewport', () => {
    const fab = fixture.nativeElement.querySelector(
      '.dbg-fab',
    ) as HTMLButtonElement;
    const rect = fab.getBoundingClientRect();

    expect(rect.left + rect.width / 2).toBeCloseTo(window.innerWidth / 2, 0);
    expect(rect.top + rect.height / 2).toBeCloseTo(window.innerHeight / 2, 0);
  });

  it('sets the viewer open on the first click while its lazy chunk loads', () => {
    const fab = fixture.nativeElement.querySelector(
      '.dbg-fab',
    ) as HTMLButtonElement;
    fab.click();

    expect(fixture.componentInstance.open()).toBeTrue();
  });

  it('suppresses the compatibility click immediately after dragging', () => {
    const component = fixture.componentInstance;
    const fab = fixture.nativeElement.querySelector(
      '.dbg-fab',
    ) as HTMLButtonElement;
    spyOn(fab, 'setPointerCapture');
    spyOn(fab, 'releasePointerCapture');

    component.onDown(
      new PointerEvent('pointerdown', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 10,
        clientY: 10,
      }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 30,
        clientY: 10,
      }),
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 30,
        clientY: 10,
      }),
    );

    const click = new MouseEvent('click', { cancelable: true });
    component.onClick(click);

    expect(component.open()).toBeFalse();
    expect(click.defaultPrevented).toBeTrue();
  });

  it('does not suppress a stationary long press', () => {
    const component = fixture.componentInstance;
    const fab = fixture.nativeElement.querySelector(
      '.dbg-fab',
    ) as HTMLButtonElement;
    spyOn(fab, 'setPointerCapture');
    spyOn(fab, 'releasePointerCapture');

    component.onDown(
      new PointerEvent('pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 10,
        clientY: 10,
      }),
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 10,
        clientY: 10,
      }),
    );

    component.onClick(new MouseEvent('click'));

    expect(component.open()).toBeTrue();
  });
});
