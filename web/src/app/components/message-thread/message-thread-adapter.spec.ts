import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { MESSAGE_THREAD_ADAPTER } from './message-thread-adapter';
import { MessageRepository } from '../../services/message-repository.service';
import { UserService } from '../../services/user.service';
import { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import { ProfileRepository } from '../../services/profile-store.service';
import { MsgService } from '../../services/message.service';

describe('production message thread deletion adapter', () => {
  it('delegates facts and events without swallowing repository failures', async () => {
    const deletedLive$ = new Subject();
    const facts = [{ seq: 3, type: 'USER_RETRACTION' }];
    const getMessageDeletions = vi.fn().mockResolvedValue(facts);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MessageRepository,
          useValue: { deletedLive$, getMessageDeletions },
        },
        ...[UserService, ThreadSendOutbox, ProfileRepository, MsgService].map(
          (provide) => ({ provide, useValue: {} }),
        ),
      ],
    });
    const adapter = TestBed.inject(MESSAGE_THREAD_ADAPTER);
    expect(adapter.deletedLive$).toBe(deletedLive$);
    expect(await adapter.getMessageDeletions(42, [3])).toBe(facts);
    expect(getMessageDeletions).toHaveBeenCalledExactlyOnceWith(42, [3]);
    const error = new Error('webdb: no user / unavailable');
    getMessageDeletions.mockRejectedValueOnce(error);
    await expect(adapter.getMessageDeletions(42, [3])).rejects.toBe(error);
  });
});
