import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ChatThreadListComponent } from './chat-thread-list.component';

describe('ChatThreadListComponent', () => {
  let component: ChatThreadListComponent;
  let fixture: ComponentFixture<ChatThreadListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatThreadListComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ChatThreadListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
