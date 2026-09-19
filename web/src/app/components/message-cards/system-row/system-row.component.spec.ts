import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { CspSafeIcuTranspiler } from '../../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../../i18n/transloco.loader';
import { LanguageService } from '../../../services/language.service';
import { MemberProfileRepository } from '../../../services/member-profile-store.service';
import { UserService } from '../../../services/user.service';
import type { SystemMessageItem } from '../chat-item';
import { SystemRowComponent } from './system-row.component';

describe('SystemRowComponent', () => {
  const me = { account: 'me', domain: 'local' };
  const alice = { account: 'alice', domain: 'peer.test' };
  const findByAddress = vi.fn();
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
    findByAddress.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      imports: [SystemRowComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: { sessionProfile: signal(me) } },
        {
          provide: MemberProfileRepository,
          useValue: {
            findByAddress,
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
    [
      {
        type: 'GROUP_ADMIN_GRANTED',
        member: { account: 'bob', domain: 'local' },
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
        initiator: { account: '$system', domain: 'local' },
      },
      '好友关系已解除',
    ],
    [
      { type: 'FRIEND_REMOVED', initiator: alice },
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
    (initiator, expected) => {
      const fixture = render(
        { type: 'FRIEND_REMOVED', initiator },
        {
          systemPeer: { ...alice, name: 'Alice Profile' },
        },
      );
      expect(fixture.nativeElement.textContent).toContain(expected);
      expect(findByAddress).not.toHaveBeenCalled();
    },
  );

  it('uses a federated address when the peer profile is unavailable', () => {
    const fixture = render(
      { type: 'FRIEND_REMOVED', initiator: me },
      { systemPeer: { ...alice, name: '' } },
    );
    expect(fixture.nativeElement.textContent).toContain('alice@peer.test');
  });

  it('rereads the event member from the local roster when it changes', async () => {
    findByAddress
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ name: 'Alice Profile' });
    const fixture = render(
      { type: 'GROUP_JOINED', member: alice },
      { isGroupConversation: true },
    );
    await vi.waitFor(() =>
      expect(findByAddress).toHaveBeenCalledWith(42, 'alice', 'peer.test'),
    );
    expect(fixture.nativeElement.textContent).toContain('alice@peer.test');
    memberChanges.next([42]);
    await vi.waitFor(() => expect(findByAddress).toHaveBeenCalledTimes(2));
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

  it('reads the creator profile from the local group roster', async () => {
    findByAddress.mockResolvedValue({ name: 'Alice Profile' });
    const fixture = render(
      { type: 'GROUP_CREATED', creator: alice },
      { isGroupConversation: true },
    );
    await vi.waitFor(() =>
      expect(findByAddress).toHaveBeenCalledWith(42, 'alice', 'peer.test'),
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
      caller: me,
      callee: alice,
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
