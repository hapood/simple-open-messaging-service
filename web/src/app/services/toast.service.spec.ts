import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ToastService } from './toast.service';

describe('ToastService', () => {
  const snackBar = { open: jasmine.createSpy('open') };

  beforeEach(() => {
    snackBar.open.calls.reset();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ToastService,
        { provide: MatSnackBar, useValue: snackBar },
      ],
    });
  });

  it('makes informational feedback passive by default', () => {
    TestBed.inject(ToastService).info('Saved');

    expect(snackBar.open).toHaveBeenCalledWith(
      'Saved',
      undefined,
      jasmine.objectContaining({
        duration: 4000,
        panelClass: jasmine.arrayContaining(['soms-snack-bar--passive']),
      }),
    );
  });

  it('keeps explicitly interactive feedback clickable', () => {
    TestBed.inject(ToastService).warn('Retry?', {
      duration: 'forever',
      interactive: true,
    });

    expect(snackBar.open).toHaveBeenCalledWith(
      'Retry?',
      undefined,
      jasmine.objectContaining({
        duration: 0,
        panelClass: jasmine.arrayContaining(['soms-snack-bar--interactive']),
      }),
    );
  });

  it('continues to accept a duration as the second argument', () => {
    TestBed.inject(ToastService).warn('Warning', 10000);

    expect(snackBar.open).toHaveBeenCalledWith(
      'Warning',
      undefined,
      jasmine.objectContaining({
        duration: 10000,
        panelClass: jasmine.arrayContaining(['soms-snack-bar--passive']),
      }),
    );
  });
});
