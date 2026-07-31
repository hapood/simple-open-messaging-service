import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConversationListService } from '../../services/conversation-list.service';
import { ConversationItem } from '../../services/model';
import { UserListComponent } from './user-list.component';

describe('UserListComponent', () => {
  it('excludes users supplied by the caller', () => {
    const items = signal([
      item(1, 101, 'Alice'),
      item(2, 102, 'Bob'),
      { ...item(3, 103, 'Group'), type: 'GROUP' },
    ] as ConversationItem[]);
    TestBed.configureTestingModule({
      imports: [UserListComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ConversationListService, useValue: { items } },
      ],
    });
    const fixture = TestBed.createComponent(UserListComponent);
    fixture.componentRef.setInput('excludedUserIds', new Set([102]));

    expect(fixture.componentInstance.dispThreadList().map((thread) => thread.peerUser.id)).toEqual([101]);
  });
});

function item(id: number, userId: number, name: string): ConversationItem {
  return {
    id,
    threadId: id,
    type: 'P2P',
    peerUser: { id: userId, name, account: name.toLowerCase() },
  } as ConversationItem;
}
