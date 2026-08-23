import { TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { SplitButtonComponent } from './split-button.component';

describe('SplitButtonComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SplitButtonComponent, NoopAnimationsModule],
    }).compileComponents();
  });

  it('emits the primary action', () => {
    const fixture = TestBed.createComponent(SplitButtonComponent);
    fixture.componentRef.setInput('label', 'Forward');
    fixture.componentRef.setInput('menuAriaLabel', 'Forward options');
    fixture.componentRef.setInput('options', []);
    const emitted = vi.fn();
    fixture.componentInstance.primaryAction.subscribe(emitted);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLButtonElement>('.split-button__primary')?.click();

    expect(emitted).toHaveBeenCalledOnce();
  });

  it('disables both actions together', () => {
    const fixture = TestBed.createComponent(SplitButtonComponent);
    fixture.componentRef.setInput('label', 'Forward');
    fixture.componentRef.setInput('menuAriaLabel', 'Forward options');
    fixture.componentRef.setInput('options', []);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const buttons = element.querySelectorAll<HTMLButtonElement>(
      '.split-button button',
    );
    expect([...buttons].every((button) => button.disabled)).toBe(true);
  });
});
