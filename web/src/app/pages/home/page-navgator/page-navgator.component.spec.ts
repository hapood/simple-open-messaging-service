import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PageNavgatorComponent } from './page-navgator.component';

describe('PageNavgatorComponent', () => {
  let component: PageNavgatorComponent;
  let fixture: ComponentFixture<PageNavgatorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PageNavgatorComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PageNavgatorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
