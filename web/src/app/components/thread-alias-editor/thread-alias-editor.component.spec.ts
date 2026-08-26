import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MsgService } from '../../services/message.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { ThreadAliasEditorComponent } from './thread-alias-editor.component';

describe('ThreadAliasEditorComponent', () => {
  let fixture: ComponentFixture<ThreadAliasEditorComponent>;
  let comp: ThreadAliasEditorComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ThreadAliasEditorComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: MsgService, useValue: {} },
        {
          provide: ConversationListService,
          useValue: { items: signal([]) },
        },
      ],
    }).overrideComponent(ThreadAliasEditorComponent, {
      set: { template: '<input #aliasInput />' },
    });
    fixture = TestBed.createComponent(ThreadAliasEditorComponent);
    fixture.componentRef.setInput('threadId', 5);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('focuses the alias input after entering edit mode', () => {
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    const input = fixture.nativeElement.querySelector(
      'input',
    ) as HTMLInputElement;
    const focus = vi.spyOn(input, 'focus');

    comp.start();
    frame?.(0);

    expect(comp.editing()).toBe(true);
    expect(focus).toHaveBeenCalled();
  });
});
