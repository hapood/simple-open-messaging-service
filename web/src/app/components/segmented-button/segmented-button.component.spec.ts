import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  SegmentedButtonComponent,
  SegmentedButtonOption,
} from './segmented-button.component';

describe('SegmentedButtonComponent', () => {
  let fixture: ComponentFixture<SegmentedButtonComponent<string>>;
  let component: SegmentedButtonComponent<string>;

  const mockOptions: SegmentedButtonOption<string>[] = [
    { key: 'password', label: 'Password', icon: 'password' },
    { key: 'otp', label: 'OTP Code', icon: 'otp' },
    { key: 'qr', label: 'QR Scan', icon: 'qr' },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SegmentedButtonComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SegmentedButtonComponent<string>);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('options', mockOptions);
    fixture.componentRef.setInput('value', 'password');
    fixture.detectChanges();
  });

  it('renders all options as segmented items', () => {
    const items = fixture.nativeElement.querySelectorAll('.mat-button-toggle');
    expect(items.length).toBe(3);
  });

  it('marks the active option as checked', () => {
    const checked = fixture.nativeElement.querySelector(
      '.mat-button-toggle-checked',
    );
    expect(checked).not.toBeNull();
    expect(checked?.textContent).toContain('Password');
  });

  it('updates value when selection changes', () => {
    component.onSelectionChange('otp');
    expect(component.value()).toBe('otp');
  });
});
