import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ChatContextService } from './chat-context.service';
import { createGroupConversation } from '../../services/model';

describe('ChatContextService', () => {
  it('uses the role materialized on the conversation', () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), ChatContextService],
    });
    const context = TestBed.inject(ChatContextService);
    const conversation = createGroupConversation(
      12,
      {
        id: 120,
        account: 'group-120',
        name: 'Group 120',
        domain: 'chat.example.test',
        namespaceId: 0,
      },
      { role: 'ADMIN' },
    );

    context.initialize(conversation);

    expect(context.groupRole()).toBe('ADMIN');
    expect(context.canAdministerGroup()).toBe(true);
  });

  it('keeps an unknown conversation role unknown', () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), ChatContextService],
    });
    const context = TestBed.inject(ChatContextService);
    const conversation = createGroupConversation(12, {
      id: 120,
      account: 'group-120',
      name: 'Group 120',
      domain: 'chat.example.test',
      namespaceId: 0,
    });

    context.initialize(conversation);

    expect(context.groupRole()).toBeNull();
    expect(context.canAdministerGroup()).toBe(false);
  });
});
