import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ContactPickerDialogComponent } from './contact-picker-dialog.component';
import { ConversationListService } from '../../services/conversation-list.service';
import { RouteService } from '../../services/route.service';
import {
  createGroupConversation,
  createP2PConversation,
  displayThreadName,
} from '../../services/model';

const threads = [
  createP2PConversation({
    threadId: 7,
    account: 'bob',
    publisherNamespaceId: 4,
    profileRev: 5,
  }),
  createGroupConversation({
    threadId: 8,
    account: '!group12',
    publisherNamespaceId: 4,
    profileRev: 6,
    profile: { name: 'Group', bio: '', avatarDigest: null },
  }),
];

describe('ContactPickerDialogComponent', () => {
  const closeDlg = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ConversationListService,
          useValue: { items: signal(threads) },
        },
        { provide: RouteService, useValue: { closeDlg } },
      ],
    }).overrideComponent(ContactPickerDialogComponent, {
      set: { template: '' },
    });
  });

  it.each(threads)(
    'selects $type synchronously from materialized thread fields',
    (thread) => {
      const component = TestBed.createComponent(
        ContactPickerDialogComponent,
      ).componentInstance;
      component.choose(thread);
      expect(closeDlg).toHaveBeenCalledExactlyOnceWith({
        target: {
          account: thread.account,
          namespaceId: thread.publisherNamespaceId,
          profileRev: thread.profileRev,
        },
        account: thread.account,
        name: displayThreadName(thread),
        bio: thread.profile.bio ?? '',
      });
    },
  );
});
