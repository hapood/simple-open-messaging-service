import { Subject } from 'rxjs';
import type { StandardResponse } from '../../services/model';
import type { ThreadAliasApplied } from '../../../../../shared/thread-attention';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MsgService } from '../../services/message.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { ThreadAliasEditorComponent } from './thread-alias-editor.component';

describe('ThreadAliasEditorComponent', () => {
  let fixture: ComponentFixture<ThreadAliasEditorComponent>;
  let comp: ThreadAliasEditorComponent;
  let response: Subject<StandardResponse<ThreadAliasApplied>>;
  const confirm = vi.fn();
  const save = vi.fn();

  beforeEach(() => {
    response = new Subject();
    confirm.mockReset();
    save.mockReset().mockReturnValue(response);
    TestBed.configureTestingModule({
      imports: [ThreadAliasEditorComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: MsgService, useValue: { setAlias: save } },
        {
          provide: ConversationListService,
          useValue: { items: signal([]), confirmThreadAlias: confirm },
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

  it('publishes only the normalized successful response and blocks duplicate submissions', () => {
    comp.start();
    comp.draft.set('  New  ');
    comp.save();
    comp.save();
    expect(save).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(comp.draft()).toBe('  New  ');
    response.next({
      code: 0,
      message: '',
      data: { threadId: 5, threadFeedId: 9, alias: 'New' },
    });
    expect(confirm).toHaveBeenCalledExactlyOnceWith({
      threadId: 5,
      threadFeedId: 9,
      alias: 'New',
    });
    expect(comp.editing()).toBe(false);
  });

  it('keeps failed drafts private and available for retry', () => {
    comp.start();
    comp.draft.set('Draft');
    comp.save();
    response.error(new Error('offline'));
    expect(confirm).not.toHaveBeenCalled();
    expect(comp.draft()).toBe('Draft');
    expect(comp.editing()).toBe(true);
    expect(comp.failed()).toBe(true);
    expect(comp.saving()).toBe(false);
  });

  it('does not clear text entered after submission and publishes explicit clears', () => {
    comp.start();
    comp.draft.set('');
    comp.save();
    comp.draft.set('Next draft');
    response.next({
      code: 0,
      message: '',
      data: { threadId: 5, threadFeedId: 10, alias: null },
    });
    expect(confirm).toHaveBeenCalledWith({
      threadId: 5,
      threadFeedId: 10,
      alias: null,
    });
    expect(comp.editing()).toBe(true);
    expect(comp.draft()).toBe('Next draft');
  });

  it('does not publish business rejections', () => {
    comp.start();
    comp.draft.set('Draft');
    comp.save();
    response.next({ code: 1, message: 'rejected' });
    expect(confirm).not.toHaveBeenCalled();
    expect(comp.failed()).toBe(true);
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
