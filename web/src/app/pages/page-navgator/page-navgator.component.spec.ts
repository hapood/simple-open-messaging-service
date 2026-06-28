import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';

import { PageNavgatorComponent } from './page-navgator.component';

describe('PageNavgatorComponent', () => {
  let component: PageNavgatorComponent;
  let fixture: ComponentFixture<PageNavgatorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PageNavgatorComponent],
      // 应用是 zoneless（不加载 Zone.js）；spec 走 createComponent 必须显式提供 zoneless，否则 NG0908。
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
