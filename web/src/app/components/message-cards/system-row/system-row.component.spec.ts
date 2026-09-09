import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { CspSafeIcuTranspiler } from '../../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../../i18n/transloco.loader';
import { LanguageService } from '../../../services/language.service';
import type { ChatMsgData } from '../chat-item';
import { SystemRowComponent } from './system-row.component';

describe('SystemRowComponent', () => {
  let language: LanguageService;

  const message = (text: string, name = 'Alice'): ChatMsgData => ({
    type: 'system',
    msgId: 1,
    isSelf: false,
    name,
    text,
    time: '09:30',
    contentType: 'SYSTEM',
    images: null,
    file: null,
    createdAtMs: Date.now(),
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [SystemRowComponent],
      providers: [
        provideZonelessChangeDetection(),
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
    language.setLang('en');
    TestBed.flushEffects();
  });

  it('localizes group events and follows a runtime language switch', () => {
    const fixture = TestBed.createComponent(SystemRowComponent);
    fixture.componentRef.setInput(
      'data',
      message(
        JSON.stringify({
          type: 'GROUP_JOINED',
          subject: { account: 'Alice', domain: 'example.test' },
        }),
      ),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Alice joined the group',
    );

    language.setLang('zh-CN');
    TestBed.flushEffects();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Alice 加入了群聊');
  });

  it('localizes the subject of a group event', () => {
    language.setLang('zh-CN');
    TestBed.flushEffects();
    const fixture = TestBed.createComponent(SystemRowComponent);
    fixture.componentRef.setInput(
      'data',
      message(
        JSON.stringify({
          type: 'GROUP_ADMIN_GRANTED',
          subject: { account: '小明', domain: 'example.test' },
        }),
      ),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('小明 已成为管理员');
  });

  it('uses a localized fallback for malformed content', () => {
    language.setLang('zh-CN');
    TestBed.flushEffects();
    const fixture = TestBed.createComponent(SystemRowComponent);
    fixture.componentRef.setInput('data', message('not-json'));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('会话已更新');
  });

  it('renders withdrawal and moderation deletion events', () => {
    language.setLang('zh-CN');
    TestBed.flushEffects();
    const withdrawn = TestBed.createComponent(SystemRowComponent);
    withdrawn.componentRef.setInput(
      'data',
      message(
        JSON.stringify({
          type: 'MESSAGE_WITHDRAWN',
          subject: { account: '小明', domain: 'example.test' },
        }),
      ),
    );
    withdrawn.detectChanges();
    expect(withdrawn.nativeElement.textContent).toContain(
      '小明 撤回了一条消息',
    );

    const moderated = TestBed.createComponent(SystemRowComponent);
    moderated.componentRef.setInput(
      'data',
      message(JSON.stringify({ type: 'MESSAGES_MODERATED', count: 3 })),
    );
    moderated.detectChanges();
    expect(moderated.nativeElement.textContent).toContain(
      '管理员删除了 3 条消息',
    );
  });

  it('renders friendship removal from the current user perspective', () => {
    language.setLang('zh-CN');
    TestBed.flushEffects();
    const fixture = TestBed.createComponent(SystemRowComponent);
    fixture.componentRef.setInput('data', {
      ...message(
        JSON.stringify({
          type: 'FRIEND_REMOVED',
          subject: { account: '小明', domain: 'example.test' },
        }),
      ),
      isSelf: true,
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      '你已解除与 小明 的好友关系',
    );
  });

  it('renders friendship removal from the peer perspective', () => {
    language.setLang('zh-CN');
    TestBed.flushEffects();
    const fixture = TestBed.createComponent(SystemRowComponent);
    fixture.componentRef.setInput(
      'data',
      message(
        JSON.stringify({
          type: 'FRIEND_REMOVED',
          subject: { account: '我', domain: 'example.test' },
        }),
        'Alice',
      ),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Alice 已解除与你的好友关系',
    );
  });

  it('renders an archived federation namespace as a read-only notice', () => {
    language.setLang('zh-CN');
    TestBed.flushEffects();
    const fixture = TestBed.createComponent(SystemRowComponent);
    fixture.componentRef.setInput(
      'data',
      message(
        JSON.stringify({
          type: 'FEDERATION_NAMESPACE_ARCHIVED',
          domain: 'peer.test',
        }),
      ),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      '对方服务器已更新 peer.test 的身份绑定',
    );
    expect(fixture.nativeElement.textContent).toContain('无法继续发送消息');
  });
  it('renders local call type, outcome, direction, and connected duration', () => {
    const fixture = TestBed.createComponent(SystemRowComponent);
    fixture.componentRef.setInput(
      'data',
      message(
        JSON.stringify({
          type: 'CALL_ENDED',
          callId: '550e8400-e29b-41d4-a716-446655440000',
          caller: { account: 'Alice', domain: 'a.test' },
          callee: { account: 'Bob', domain: 'b.test' },
          mediaType: 'VIDEO',
          outcome: 'completed',
          initiatedAt: 1000,
          connectedAt: 2000,
          endedAt: 67000,
        }),
      ),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Incoming call');
    expect(fixture.nativeElement.textContent).toContain('Video call');
    expect(fixture.nativeElement.textContent).toContain('Call ended');
    expect(fixture.nativeElement.textContent).toContain('1:05');
    expect(fixture.nativeElement.textContent).toContain('Waited 0:01');
  });
});
