import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ContactPickerDialogComponent } from './contact-picker-dialog.component';
import { ConversationListService } from '../../services/conversation-list.service';
import { RouteService } from '../../services/route.service';
import { createGroupConversation, createP2PConversation, displayThreadName } from '../../services/model';

const threads = [
  createP2PConversation(7, { account: 'bob', namespaceId: 4, profileRev: 5 }),
  createGroupConversation(8, {
    id: 8,
    account: '!group12',
    name: 'Group',
    namespaceId: 4,
    profileRev: 6,
  }),
];

describe('ContactPickerDialogComponent', () => {
  const closeDlg = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        { provide: ConversationListService, useValue: { items: signal(threads) } },
        { provide: RouteService, useValue: { closeDlg } },
      ],
    }).overrideComponent(ContactPickerDialogComponent, {
      set: { template: '' },
    });
  });

  it.each(threads)(
    'selects $type synchronously from materialized thread fields',
    (thread) => {
      const subject = thread.type === 'GROUP' ? thread.group : thread.peerUser;
      const component = TestBed.createComponent(ContactPickerDialogComponent)
        .componentInstance;
      component.choose(thread);
      expect(closeDlg).toHaveBeenCalledExactlyOnceWith({
        target: {
          account: subject.account,
          namespaceId: subject.namespaceId,
          profileRev: thread.profileRev,
        },
        account: subject.account,
        name: displayThreadName(thread),
        bio:
          (thread.type === 'GROUP'
            ? thread.group.description
            : thread.peerUser.bio) ?? '',
      });
    },
  );
});
