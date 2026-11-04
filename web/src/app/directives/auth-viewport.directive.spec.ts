import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthViewportDirective, authFocusedLift } from './auth-viewport.directive';
import { KeyboardInsetService } from '../services/keyboard-inset.service';

@Component({
  standalone: true,
  imports: [AuthViewportDirective],
  template: '<div appAuthViewport><input /></div>',
})
class TestHost {}

describe('auth viewport', () => {
  it('leaves comfortably visible fields in place', () => {
    expect(authFocusedLift(300, 500)).toBe(0);
  });

  it('reveals covered fields without the former 80px cap', () => {
    expect(authFocusedLift(700, 400)).toBe(324);
  });

  it('rounds up to preserve the full clearance', () => {
    expect(authFocusedLift(500.5, 500)).toBe(25);
  });

  it('does not apply keyboard geometry to browser hosts', async () => {
    await TestBed.configureTestingModule({
      imports: [TestHost],
      providers: [{
        provide: KeyboardInsetService,
        useValue: { available: false, inset: signal(300), open: signal(true) },
      }],
    }).compileComponents();
    const fixture = TestBed.createComponent(TestHost);
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('div') as HTMLElement;
    host.querySelector('input')!.focus();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    fixture.detectChanges();
    expect(host.classList.contains('auth-native-viewport')).toBe(false);
    expect(host.classList.contains('auth-native-keyboard-open')).toBe(false);
    expect(host.style.getPropertyValue('--auth-keyboard-inset')).toBe('');
    expect(host.style.getPropertyValue('--auth-focused-lift')).toBe('0px');
    fixture.destroy();
  });
});
