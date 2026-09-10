import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { Subject, EMPTY } from 'rxjs';
import { vi } from 'vitest';
import { CspSafeIcuTranspiler } from '../../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../../i18n/transloco.loader';
import { LanguageService } from '../../../services/language.service';
import {
  ProfileResolutionService,
  type ResolvedProfile,
} from '../../../services/profile-resolution.service';
import { UserService } from '../../../services/user.service';
import type { SystemMessageItem } from '../chat-item';
import { SystemRowComponent } from './system-row.component';

describe('SystemRowComponent', () => {
  const me = { account: 'me', domain: 'local' };
  const alice = { account: 'alice', domain: 'peer.test' };
  const resolve = vi.fn();
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
    resolve.mockReset().mockReturnValue(EMPTY);
    TestBed.configureTestingModule({
      imports: [SystemRowComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: { sessionProfile: signal(me) } },
        { provide: ProfileResolutionService, useValue: { resolve } },
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
    [{ type: 'MESSAGE_WITHDRAWN', author: me }, '你撤回了一条消息'],
    [
      { type: 'MESSAGE_WITHDRAWN', author: alice },
      'alice@peer.test 撤回了一条消息',
    ],
    [{ type: 'MESSAGES_MODERATED', count: 3 }, '管理员删除了 3 条消息'],
    [{ type: 'FRIEND_REMOVED', initiator: { account: '$system', domain: 'local' } }, '好友关系已解除'],
    [
      { type: 'FRIEND_REMOVED', initiator: alice },
      'alice@peer.test 已解除与你的好友关系',
    ],
    [
      { type: 'FEDERATION_NAMESPACE_ARCHIVED', domain: 'peer.test' },
      '对方服务器已更新 peer.test 的身份绑定',
    ],
  ])('renders event-specific participants: %j', (body, expected) => {
    expect(render(body).nativeElement.textContent).toContain(expected);
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
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('uses a federated address when the peer profile is unavailable', () => {
    const fixture = render(
      { type: 'FRIEND_REMOVED', initiator: me },
      { systemPeer: { ...alice, name: '' } },
    );
    expect(fixture.nativeElement.textContent).toContain('alice@peer.test');
  });

  it('resolves the event member in the current thread, handles async completion and language changes', () => {
    const results = new Subject<ResolvedProfile>();
    resolve.mockReturnValue(results);
    const fixture = render(
      { type: 'GROUP_JOINED', member: alice },
      { isGroupConversation: true },
    );
    expect(resolve).toHaveBeenCalledWith({
      type: 'GROUP_MEMBER',
      threadId: 42,
      memberAccount: 'alice',
      memberDomain: 'peer.test',
    });
    expect(fixture.nativeElement.textContent).toContain('alice@peer.test');
    results.next({ name: 'Alice Profile' } as ResolvedProfile);
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
    expect(results.observed).toBe(false);
    expect(fixture.nativeElement.textContent).not.toContain('Alice Profile');
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
