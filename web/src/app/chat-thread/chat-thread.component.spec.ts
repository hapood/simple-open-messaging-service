import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ChatThreadComponent } from './chat-thread.component';

describe('ChatThreadComponent', () => {
  let component: ChatThreadComponent;
  let fixture: ComponentFixture<ChatThreadComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatThreadComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ChatThreadComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
