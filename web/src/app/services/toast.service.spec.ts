import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ToastContentComponent } from '../components/toast-content/toast-content.component';
import { ToastService } from './toast.service';

describe('ToastService', () => {
  const snackBar = { openFromComponent: vi.fn() };

  beforeEach(() => {
    snackBar.openFromComponent.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ToastService,
        { provide: MatSnackBar, useValue: snackBar },
      ],
    });
  });

  it('uses dismissible content while keeping informational text passive', () => {
    TestBed.inject(ToastService).info('Saved');

    expect(snackBar.openFromComponent).toHaveBeenCalledWith(
      ToastContentComponent,
      expect.objectContaining({
        data: { message: 'Saved' },
        duration: 4000,
        panelClass: [
          'soms-snack-bar',
          'soms-snack-bar--info',
          'soms-snack-bar--passive',
        ],
      }),
    );
  });

  it('allows persistent warnings with a close control', () => {
    TestBed.inject(ToastService).warn('Warning', { duration: 'forever' });

    expect(snackBar.openFromComponent).toHaveBeenCalledWith(
      ToastContentComponent,
      expect.objectContaining({
        data: { message: 'Warning' },
        duration: 0,
        panelClass: [
          'soms-snack-bar',
          'soms-snack-bar--warn',
          'soms-snack-bar--passive',
        ],
      }),
    );
  });

  it('accepts an explicit duration through options', () => {
    TestBed.inject(ToastService).warn('Warning', { duration: 10000 });

    expect(snackBar.openFromComponent).toHaveBeenCalledWith(
      ToastContentComponent,
      expect.objectContaining({
        data: { message: 'Warning' },
        duration: 10000,
        panelClass: expect.arrayContaining([
          'soms-snack-bar--warn',
          'soms-snack-bar--passive',
        ]),
      }),
    );
  });

  it('also provides a close control for persistent passive feedback', () => {
    TestBed.inject(ToastService).info('Notice', { duration: 'forever' });

    expect(snackBar.openFromComponent).toHaveBeenCalledWith(
      ToastContentComponent,
      expect.objectContaining({ data: { message: 'Notice' }, duration: 0 }),
    );
  });
});
