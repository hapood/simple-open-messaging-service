import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ContactPickerDialogComponent } from './contact-picker-dialog.component';
import { ConversationListService } from '../../services/conversation-list.service';
import { RouteService } from '../../services/route.service';
import {
  createGroupConversation,
  createP2PConversation,
} from '../../services/model';

describe('ContactPickerDialogComponent', () => {
  it('selects a federated person by profile reference instead of a local numeric id', () => {
    const peer = createP2PConversation(7, {
      account: 'bob',
      domain: 'bravo.test',
      namespaceId: 4,
      profileRev: 5,
      name: 'Bob',
    });
    const closeDlg = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ConversationListService,
          useValue: { items: signal([peer]) },
        },
        { provide: RouteService, useValue: { closeDlg } },
      ],
    }).overrideComponent(ContactPickerDialogComponent, {
      set: { template: '' },
    });
    TestBed.createComponent(
      ContactPickerDialogComponent,
    ).componentInstance.choose(peer);
    expect(closeDlg).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          account: 'bob',
          domain: 'bravo.test',
          namespaceId: 4,
          profileRev: 5,
        },
      }),
    );
    expect(closeDlg.mock.calls[0][0]).not.toHaveProperty('targetUserId');
  });

  it('uses the same reference shape for a group', () => {
    const group = createGroupConversation(8, {
      id: 8,
      account: '!group12',
      name: 'Group',
      domain: 'bravo.test',
      namespaceId: 4,
      profileRev: 6,
    });
    const closeDlg = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ConversationListService,
          useValue: { items: signal([group]) },
        },
        { provide: RouteService, useValue: { closeDlg } },
      ],
    }).overrideComponent(ContactPickerDialogComponent, {
      set: { template: '' },
    });
    TestBed.createComponent(
      ContactPickerDialogComponent,
    ).componentInstance.choose(group);
    expect(closeDlg).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          account: '!group12',
          domain: 'bravo.test',
          namespaceId: 4,
          profileRev: 6,
        },
      }),
    );
    expect(closeDlg.mock.calls[0][0]).not.toHaveProperty('targetGroupId');
  });
});
