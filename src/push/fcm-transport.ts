import type { FirebaseError } from 'firebase-admin/app';
import type {
  BatchResponse,
  Message,
  Messaging,
  SendResponse,
} from 'firebase-admin/messaging';

/** The Admin SDK's HTTP/2 batch transport bypasses HTTPS proxy agents. Use its
 * HTTP/1 send path per recipient when FCM is configured to use a proxy. Preserve
 * the batch response ordering so invalid tokens are still pruned independently. */
export async function sendFcmMessages(
  messaging: Messaging,
  messages: Message[],
  useHttpProxy: boolean,
): Promise<BatchResponse> {
  if (!useHttpProxy) return messaging.sendEach(messages);
  const responses: SendResponse[] = await Promise.all(
    messages.map(async (message) => {
      try {
        return { success: true, messageId: await messaging.send(message) };
      } catch (error) {
        return { success: false, error: error as FirebaseError };
      }
    }),
  );
  const successCount = responses.filter((response) => response.success).length;
  return {
    responses,
    successCount,
    failureCount: responses.length - successCount,
  };
}
