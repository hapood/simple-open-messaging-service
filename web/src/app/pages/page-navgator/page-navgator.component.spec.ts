import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';

import { PageNavgatorComponent } from './page-navgator.component';

describe('PageNavgatorComponent', () => {
  let component: PageNavgatorComponent;
  let fixture: ComponentFixture<PageNavgatorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PageNavgatorComponent],
      // The app is zoneless (Zone.js is not loaded); specs using createComponent must explicitly provide zoneless change detection, otherwise NG0908.
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(PageNavgatorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
