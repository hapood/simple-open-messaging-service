import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { of, Subject } from 'rxjs';
import {
  createP2PConversation,
  type ConversationItem,
} from '../../../services/model';
import { vi } from 'vitest';
import { CspSafeIcuTranspiler } from '../../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../../i18n/transloco.loader';
import { LanguageService } from '../../../services/language.service';
import { MemberProfileRepository } from '../../../services/member-profile-store.service';
import { ProfileRepository } from '../../../services/profile-store.service';
import { WebdbService } from '../../../services/webdb.service';
import { ConversationListService } from '../../../services/conversation-list.service';
import { UserService } from '../../../services/user.service';
import type { SystemMessageItem } from '../chat-item';
import { SystemRowComponent } from './system-row.component';

describe('SystemRowComponent', () => {
  const me = {
    account: 'me',
    domain: 'chat.example.test',
    profileNamespaceId: 0,
    profileRev: 0,
  };
  const alice = {
    account: 'alice',
    domain: 'peer.test',
    profileNamespaceId: 12,
    profileRev: 0,
  };
  const participants: [typeof me, typeof alice] = [me, alice];
  const getProfile = vi.fn();
  const resolveProfile = vi.fn();
  const correctSystemMessageProfile = vi.fn();
  const conversations = signal<ConversationItem[]>([]);
  const memberChanges = new Subject<readonly number[]>();
  let language: LanguageService;
  const data = (
    body: unknown,
    extra: Partial<SystemMessageItem> = {},
  ): SystemMessageItem => ({
    type: 'system',
    contentType: 'SYSTEM',
    msgId: 1,
    threadId: 42,
    isSelf: false,
    name: '',
    text: JSON.stringify(body),
    time: '09:30',
    images: null,
    file: null,
    createdAtMs: 1000,
    ...extra,
  });
  const render = (body: unknown, extra: Partial<SystemMessageItem> = {}) => {
    const fixture = TestBed.createComponent(SystemRowComponent);
    fixture.componentRef.setInput('data', data(body, extra));
    fixture.detectChanges();
    return fixture;
  };
  beforeEach(() => {
    getProfile.mockReset().mockResolvedValue(undefined);
    resolveProfile.mockReset().mockReturnValue(
      of({
        account: 'alice',
        domain: 'peer.test',
        namespaceId: 12,
        rev: 3,
        name: '',
      }),
    );
    correctSystemMessageProfile.mockReset().mockResolvedValue(true);
    conversations.set([]);
    TestBed.configureTestingModule({
      imports: [SystemRowComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: UserService,
          useValue: {
            sessionProfile: signal({
              account: 'me',
              domain: 'chat.example.test',
              namespaceId: 0,
              profileRev: 0,
            }),
          },
        },
        {
          provide: ProfileRepository,
          useValue: { getProfile, resolve: resolveProfile },
        },
        { provide: WebdbService, useValue: { correctSystemMessageProfile } },
        {
          provide: ConversationListService,
          useValue: { items: conversations },
        },
        {
          provide: MemberProfileRepository,
          useValue: {
            changed$: memberChanges,
          },
        },
        provideTransloco({
          config: {
            availableLangs: ['en', 'zh-CN'],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        provideTranslocoTranspiler(CspSafeIcuTranspiler),
      ],
    });
    language = TestBed.inject(LanguageService);
    language.setLang('zh-CN');
    TestBed.flushEffects();
  });

  it.each([
    [{ type: 'GROUP_CREATED', creator: me }, 'me 创建了群聊'],
    [{ type: 'GROUP_JOINED', member: alice }, 'alice@peer.test 加入了群聊'],
    [{ type: 'GROUP_LEFT', member: me }, '你已不在该群聊中'],
    [{ type: 'GROUP_DISSOLVED' }, '群聊已解散'],
    [
      {
        type: 'GROUP_ADMIN_GRANTED',
        member: {
          account: 'bob',
          domain: 'chat.example.test',
          profileNamespaceId: 0,
          profileRev: 0,
        },
      },
      'bob 已成为管理员',
    ],
    [
      { type: 'GROUP_ADMIN_REVOKED', member: alice },
      'alice@peer.test 已不再是管理员',
    ],
    [
      { type: 'GROUP_OWNER_TRANSFERRED', previousOwner: me, newOwner: alice },
      'alice@peer.test 已成为群主',
    ],
    [
      {
        type: 'FRIEND_REMOVED',
        initiator: {
          account: '$system',
          domain: 'chat.example.test',
          profileNamespaceId: 0,
          profileRev: 0,
        },
        participants,
      },
      '好友关系已解除',
    ],
    [
      { type: 'FRIEND_REMOVED', initiator: alice, participants },
      'alice@peer.test 已解除与你的好友关系',
    ],
  ])('renders event-specific participants: %j', (body, expected) => {
    expect(render(body).nativeElement.textContent).toContain(expected);
  });

  it.each([
    ['USER_RETRACTION', '消息已撤回'],
    ['MODERATION_REMOVAL', '消息已被管理员删除'],
  ] as const)('renders a deletion tombstone: %s', (deletionType, expected) => {
    expect(
      render(null, { text: '', deletionType }).nativeElement.textContent,
    ).toContain(expected);
  });

  it.each([
    [me, '你已解除与 Alice Profile 的好友关系'],
    [alice, 'Alice Profile 已解除与你的好友关系'],
  ])(
    'derives friendship perspective from initiator: %j',
    async (initiator, expected) => {
      const profiledPeer = { ...alice, profileRev: 3 };
      resolveProfile.mockReturnValue(
        of({
          account: 'alice',
          domain: 'peer.test',
          namespaceId: 12,
          rev: 3,
          name: 'Alice Profile',
        }),
      );
      const fixture = render({
        type: 'FRIEND_REMOVED',
        initiator,
        participants: [me, profiledPeer],
      });
      await vi.waitFor(() =>
        expect(fixture.nativeElement.textContent).toContain('Alice Profile'),
      );
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain(expected);
      expect(resolveProfile).toHaveBeenCalledExactlyOnceWith({
        evidence: null,
        demand: {
          publisherNamespaceId: 12,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 12, account: 'alice', rev: 3 },
        },
      });
    },
  );

  it('uses a federated address when the peer profile is unavailable', () => {
    const fixture = render({
      type: 'FRIEND_REMOVED',
      initiator: me,
      participants,
    });
    expect(fixture.nativeElement.textContent).toContain('alice@peer.test');
  });

  it('rereads the event revision from the local profile cache when it changes', async () => {
    resolveProfile
      .mockReturnValueOnce(
        of({
          account: 'alice',
          domain: 'peer.test',
          namespaceId: 12,
          rev: 3,
          name: '',
        }),
      )
      .mockReturnValue(
        of({
          account: 'alice',
          domain: 'peer.test',
          namespaceId: 12,
          rev: 3,
          name: 'Alice Profile',
        }),
      );
    const fixture = render(
      { type: 'GROUP_JOINED', member: { ...alice, profileRev: 3 } },
      { isGroupConversation: true },
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Alice Profile 加入了群聊',
    );
    memberChanges.next([42]);
    await vi.waitFor(() =>
      expect(fixture.nativeElement.textContent).toContain(
        'Alice Profile 加入了群聊',
      ),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Alice Profile 加入了群聊',
    );
    language.setLang('en');
    TestBed.flushEffects();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Alice Profile joined the group',
    );
    fixture.componentRef.setInput(
      'data',
      data({ type: 'GROUP_LEFT', member: me }),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Alice Profile');
  });

  it("uses only this system row's cached profile key and persists its drift", async () => {
    const participant = { ...alice, profileNamespaceId: 12, profileRev: 3 };
    getProfile.mockResolvedValue({ name: 'Alice before' });
    resolveProfile.mockReturnValue(
      of({
        name: 'Alice after',
        account: alice.account,
        domain: alice.domain,
        namespaceId: 12,
        rev: 4,
      }),
    );
    const fixture = render(
      { type: 'GROUP_JOINED', member: participant },
      { isGroupConversation: true },
    );
    await vi.waitFor(() =>
      expect(correctSystemMessageProfile).toHaveBeenCalledWith(
        42,
        1,
        'alice',
        12,
        4,
      ),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Alice after 加入了群聊',
    );
  });

  it("tracks the caller's P2P remark for a cached group participant", async () => {
    resolveProfile.mockReturnValue(
      of({
        account: 'alice',
        domain: 'peer.test',
        namespaceId: 12,
        rev: 4,
        name: 'Alice cached',
      }),
    );
    const participant = { ...alice, profileNamespaceId: 12, profileRev: 3 };
    const thread = createP2PConversation(
      7,
      {
        account: participant.account,
        name: 'Alice',
        domain: participant.domain,
        namespaceId: participant.profileNamespaceId,
        profileRev: participant.profileRev,
      },
      { alias: 'My remark' },
    );
    conversations.set([thread]);
    const fixture = render(
      { type: 'GROUP_LEFT', member: participant },
      { isGroupConversation: true },
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('My remark');
    conversations.set([{ ...thread, alias: null }]);
    await vi.waitFor(() =>
      expect(fixture.nativeElement.textContent).toContain('Alice cached'),
    );
    fixture.detectChanges();
  });

  it('reads a departed member from its own cached revision without requesting evidence', async () => {
    resolveProfile.mockReturnValue(
      of({
        account: 'alice',
        domain: 'peer.test',
        namespaceId: 12,
        rev: 4,
        name: 'Alice cached',
      }),
    );
    const fixture = render(
      {
        type: 'GROUP_LEFT',
        member: { ...alice, profileNamespaceId: 12, profileRev: 3 },
      },
      {
        isGroupConversation: true,
        localSystemProfileRevs: { '[12,"alice"]': 4 },
      },
    );
    await vi.waitFor(() =>
      expect(resolveProfile).toHaveBeenCalledWith({
        evidence: null,
        demand: {
          publisherNamespaceId: 12,
          lookup: 'ACCOUNT_PROFILE',
          target: {
            profileNamespaceId: 12,
            account: 'alice',
            rev: 4,
          },
        },
      }),
    );
    fixture.detectChanges();
    expect(resolveProfile).toHaveBeenCalled();
  });

  it('reads the creator profile at the event revision', async () => {
    resolveProfile.mockReturnValue(
      of({
        account: 'alice',
        domain: 'peer.test',
        namespaceId: 12,
        rev: 3,
        name: 'Alice Profile',
      }),
    );
    const fixture = render(
      { type: 'GROUP_CREATED', creator: { ...alice, profileRev: 3 } },
      { isGroupConversation: true },
    );
    await vi.waitFor(() =>
      expect(resolveProfile).toHaveBeenCalledWith({
        evidence: null,
        demand: {
          publisherNamespaceId: 12,
          lookup: 'ACCOUNT_PROFILE',
          target: {
            profileNamespaceId: 12,
            account: 'alice',
            rev: 3,
          },
        },
      }),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Alice Profile 创建了群聊',
    );
  });

  it.each([
    { type: 'GROUP_JOINED', subject: alice, actor: me },
    { type: 'FRIEND_REMOVED', reason: 'USER_REQUEST' },
    null,
  ])('rejects old or incomplete event content: %j', (body) => {
    expect(render(body).nativeElement.textContent).toContain('会话已更新');
  });

  it('derives call direction from the caller independently of the system sender', () => {
    language.setLang('en');
    TestBed.flushEffects();
    const fixture = render({
      type: 'CALL_ENDED',
      callId: '550e8400-e29b-41d4-a716-446655440000',
      caller: { ...me, profileNamespaceId: 0, profileRev: 0 },
      callee: { ...alice, profileNamespaceId: 7, profileRev: 0 },
      mediaType: 'VIDEO',
      outcome: 'completed',
      initiatedAt: 1000,
      connectedAt: 2000,
      endedAt: 67000,
    });
    expect(fixture.nativeElement.textContent).toContain('Outgoing call');
    expect(fixture.nativeElement.textContent).toContain('1:05');
  });
});
