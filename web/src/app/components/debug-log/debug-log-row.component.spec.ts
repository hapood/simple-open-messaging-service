import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import type { IdentifiedLine } from './debug-log-merge';
import { DebugLogRowComponent } from './debug-log-row.component';

describe('DebugLogRowComponent', () => {
  let fixture: ComponentFixture<DebugLogRowComponent>;
  const line: IdentifiedLine = {
    id: 7,
    ts: Date.parse('2026-07-21T06:23:05.677Z'),
    rawTs: '2026-07-21T06:23:05.677Z',
    level: 'error',
    source: 'js',
    text: 'Request timeout',
    raw: '2026-07-21T06:23:05.677Z [error] Request timeout',
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DebugLogRowComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    fixture = TestBed.createComponent(DebugLogRowComponent);
    fixture.componentRef.setInput('line', line);
  });

  it('highlights matching message text without replacing the original row content', () => {
    fixture.componentRef.setInput('matcher', /timeout/i);
    fixture.detectChanges();

    const mark = fixture.nativeElement.querySelector('mark') as HTMLElement;
    expect(mark.textContent).toBe('timeout');
    expect(fixture.nativeElement.textContent).toContain('Request');
  });

  it('emits selection from a row click', () => {
    const selected: number[] = [];
    fixture.componentInstance.select.subscribe((id) => selected.push(id));
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.dbg-line') as HTMLElement).click();
    expect(selected).toEqual([7]);
  });

  it('expands raw details and emits the complete line for copying', () => {
    const copied: IdentifiedLine[] = [];
    fixture.componentInstance.copy.subscribe((value) => copied.push(value));
    fixture.componentRef.setInput('selected', true);
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector('.detail-toggle') as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('pre').textContent).toBe(
      line.raw,
    );

    (
      fixture.nativeElement.querySelector(
        '.details button',
      ) as HTMLButtonElement
    ).click();
    expect(copied).toEqual([line]);
  });
});
