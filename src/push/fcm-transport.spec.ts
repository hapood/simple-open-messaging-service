import { describe, expect, it, vi } from 'vitest';
import type { Messaging, Message } from 'firebase-admin/messaging';
import { sendFcmMessages } from './fcm-transport.js';

const messages: Message[] = [
  { token: 'fixture-a', data: { type: 'NEW_MESSAGE' } },
  { token: 'fixture-b', data: { type: 'NEW_MESSAGE' } },
];

describe('FCM proxy transport', () => {
  it('uses the SDK batch path when no proxy is configured', async () => {
    const response = {
      responses: [{ success: true }],
      successCount: 1,
      failureCount: 0,
    };
    const sendEach = vi.fn().mockResolvedValue(response);
    const send = vi.fn();
    expect(
      await sendFcmMessages(
        { sendEach, send } as unknown as Messaging,
        messages,
        false,
      ),
    ).toBe(response);
    expect(sendEach).toHaveBeenCalledWith(messages);
    expect(send).not.toHaveBeenCalled();
  });

  it('uses ordered HTTP/1 sends via the proxy and preserves per-token errors', async () => {
    const expired = Object.assign(new Error('unregistered'), {
      code: 'messaging/registration-token-not-registered',
    });
    const send = vi
      .fn()
      .mockResolvedValueOnce('message-a')
      .mockRejectedValueOnce(expired);
    const sendEach = vi.fn();
    const result = await sendFcmMessages(
      { sendEach, send } as unknown as Messaging,
      messages,
      true,
    );
    expect(sendEach).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true, messageId: 'message-a' },
        { success: false, error: expired },
      ],
    });
  });
});
