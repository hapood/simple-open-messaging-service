import { TestBed } from '@angular/core/testing';
import {
  provideZonelessChangeDetection,
  signal,
  WritableSignal,
} from '@angular/core';
import { provideTransloco } from '@jsverse/transloco';
import { of } from 'rxjs';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { PeerProfileComponent } from './peer-profile.component';
import { UserService } from '../../services/user.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { ConversationItem, User } from '../../services/model';

/**
 * PeerProfileComponent unit tests — the destructive P2P actions (Unfriend + Block/Unblock).
 *
 * Focuses on the Block/Unblock behavior: the two-step inline confirm (mirrors Unfriend), its mutual
 * exclusivity with the Unfriend confirm (at most one confirm-row visible), the service call shape
 * (userService.setBlock → convList.applyThreadMeta in-place patch), and that a server-side failure keeps
 * the panel + confirm visible so the error is observable. Drives component signals directly (no template
 * render) like user-avatar.spec — zoneless CD is provided for the constructor's revision probe effect.
 */
function makeItem(
  over: { blocked?: boolean; threadId?: number; userId?: number } = {},
): { item: ConversationItem; peer: User } {
  const peer = {
    id: over.userId ?? 42,
    name: 'Alice',
    isForeigner: false,
    domain: null,
    updatedAt: 1,
    profileRev: 7,
  } as unknown as User;
  const item = {
    threadId: over.threadId ?? 5,
    peerUser: peer,
    blocked: over.blocked ?? false,
  } as unknown as ConversationItem;
  return { item, peer };
}

describe('PeerProfileComponent (Block/Unblock + Unfriend)', () => {
  let comp: PeerProfileComponent;
  // Service spies — re-armed per test via .and.returnValue.
  let deleteFriend: jasmine.Spy;
  let setBlock: jasmine.Spy;
  let applyThreadMeta: jasmine.Spy;
  let removeThread: jasmine.Spy;
  let closeChat: jasmine.Spy;
  // Conversation-list state signals — driven from the test to move the open thread / blocked flag.
  let items: WritableSignal<ConversationItem[]>;
  let openThreadId: WritableSignal<number | undefined>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    const { item } = makeItem();
    items = signal<ConversationItem[]>([item]);
    openThreadId = signal<number | undefined>(5);

    deleteFriend = jasmine.createSpy('deleteFriend');
    setBlock = jasmine.createSpy('setBlock');
    applyThreadMeta = jasmine.createSpy('applyThreadMeta');
    removeThread = jasmine.createSpy('removeThread');
    closeChat = jasmine.createSpy('closeChat');

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: [
              { id: 'en', label: 'English' },
              { id: 'zh-CN', label: '简体中文' },
            ],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        PeerProfileComponent,
        {
          provide: UserService,
          useValue: {
            deleteFriend,
            setBlock,
          } as unknown as UserService,
        },
        {
          provide: ConversationListService,
          useValue: {
            openThreadId,
            items,
            applyThreadMeta,
            removeThread,
            load: jasmine.createSpy('load'),
            updatePeerUser: jasmine.createSpy(),
          } as unknown as ConversationListService,
        },
        {
          provide: NavStateMachineService,
          useValue: {
            closeChat,
            closeAside: jasmine.createSpy(),
          } as unknown as NavStateMachineService,
        },
      ],
    })
      // These tests assert the component's class logic (signals + service calls), not the DOM. Blank the
      // template so the view's transitive deps (<app-user-avatar> → AvatarRepository → HttpClient, IDB, …)
      // are never instantiated — the unit under test stays isolated from its view's rendering concerns.
      .overrideComponent(PeerProfileComponent, { set: { template: '' } });
    const fixture = TestBed.createComponent(PeerProfileComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  });
  afterEach(() => TestBed.resetTestingModule());

  it('resolves the peer + blocked flag from the open thread', () => {
    expect(comp.peer()?.id).toBe(42);
    expect(comp.blocked()).toBe(false);
    const { peer } = makeItem({ blocked: true });
    items.set([
      {
        threadId: 5,
        peerUser: peer,
        blocked: true,
      } as unknown as ConversationItem,
    ]);
    expect(comp.blocked()).toBe(true);
  });

  it('askBlock enters the block confirm and cancels an open unfriend confirm (mutually exclusive)', () => {
    comp.askUnfriend();
    expect(comp.confirmUnfriend()).toBe(true);
    comp.askBlock();
    expect(comp.confirmBlock()).toBe(true);
    expect(comp.confirmUnfriend()).toBe(false);
  });

  it('askUnfriend cancels an open block confirm (symmetric — at most one confirm-row)', () => {
    comp.askBlock();
    expect(comp.confirmBlock()).toBe(true);
    comp.askUnfriend();
    expect(comp.confirmUnfriend()).toBe(true);
    expect(comp.confirmBlock()).toBe(false);
  });

  it('cancelBlock leaves the confirm state', () => {
    comp.askBlock();
    comp.cancelBlock();
    expect(comp.confirmBlock()).toBe(false);
  });

  it('doBlock blocks the peer and patches the conversation item in place, then dismisses the confirm', () => {
    setBlock.and.returnValue(of({ code: 0 }));
    comp.askBlock();
    comp.doBlock();
    expect(setBlock.calls.mostRecent().args[0]).toEqual({
      userId: 42,
      block: true,
    });
    expect(applyThreadMeta).toHaveBeenCalledWith(5, { blocked: true });
    expect(comp.confirmBlock()).toBe(false);
  });

  it('doBlock on a non-zero code keeps the panel + confirm visible (server failure is observable)', () => {
    setBlock.and.returnValue(of({ code: 20004 }));
    comp.askBlock();
    comp.doBlock();
    expect(setBlock).toHaveBeenCalled();
    expect(applyThreadMeta).not.toHaveBeenCalled();
    expect(comp.confirmBlock()).toBe(true); // unchanged so the user can retry
  });

  it('doUnblock unblocks the peer in a single tap (no confirm) and patches the item', () => {
    setBlock.and.returnValue(of({ code: 0 }));
    comp.doUnblock();
    expect(setBlock.calls.mostRecent().args[0]).toEqual({
      userId: 42,
      block: false,
    });
    expect(applyThreadMeta).toHaveBeenCalledWith(5, { blocked: false });
  });

  it('doUnfriend ends the friendship but retains readable history by default', async () => {
    deleteFriend.and.returnValue(of({ code: 0 }));
    await comp.doUnfriend();
    expect(deleteFriend.calls.mostRecent().args[0]).toEqual({
      userId: 42,
      deleteData: false,
    });
    expect(applyThreadMeta).toHaveBeenCalledWith(5, {
      friendshipActive: false,
      conversationState: 'READ_ONLY',
    });
    expect(removeThread).not.toHaveBeenCalled();
    expect(closeChat).not.toHaveBeenCalled();
  });

  it('guards: with no peer resolved, doBlock/doUnblock/doUnfriend are all no-ops', () => {
    openThreadId.set(999); // no matching item → peer() is undefined
    setBlock.and.returnValue(of({ code: 0 }));
    deleteFriend.and.returnValue(of({ code: 0 }));
    comp.doBlock();
    comp.doUnblock();
    comp.doUnfriend();
    expect(setBlock).not.toHaveBeenCalled();
    expect(deleteFriend).not.toHaveBeenCalled();
    expect(removeThread).not.toHaveBeenCalled();
  });
});
