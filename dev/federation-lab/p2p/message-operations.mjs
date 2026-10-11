import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';

export const messageOperationTypes = new Set([
  'SEND_GROUP_MESSAGE',
  'SEND_P2P_MESSAGE',
  'SEND_QUOTE',
  'FORWARD_DIRECT',
  'FORWARD_HISTORY',
  'SEND_FILE',
  'SEND_GALLERY',
]);

export function parseContent(content) {
  if (content && typeof content === 'object') return structuredClone(content);
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// One logical send may contain multiple identical transport attempts.
export async function submitMessage(send, retryMode) {
  const attempts = [];
  const attempt = async () => {
    const index = attempts.length;
    attempts.push({ index, startedAt: new Date().toISOString() });
    try {
      const result = await send();
      attempts[index] = {
        ...attempts[index],
        status: 'SUCCEEDED',
        id: result.id,
        seq: result.seq,
        originSeq: result.originSeq,
      };
      return result;
    } catch (error) {
      attempts[index] = { ...attempts[index], status: 'FAILED' };
      error.attempts = attempts;
      throw error;
    }
  };
  let results;
  if (retryMode === 'CONCURRENT') {
    const settled = await Promise.allSettled([attempt(), attempt()]);
    const failed = settled.find((item) => item.status === 'rejected');
    if (failed) throw failed.reason;
    results = settled.map((item) => item.value);
  } else {
    results = [await attempt()];
    if (retryMode === 'AFTER_SUCCESS') results.push(await attempt());
  }
  if (
    results.some(
      (item) =>
        String(item.id) !== String(results[0].id) ||
        item.seq !== results[0].seq ||
        item.threadId !== results[0].threadId ||
        item.clientMessageId !== results[0].clientMessageId,
    )
  ) {
    const error = new Error(
      'idempotent send returned different message identities',
    );
    error.attempts = attempts;
    throw error;
  }
  return { message: results[0], attempts };
}

export async function admitMessageOperation(operation, actor) {
  const threadId = operation.threadId ?? operation.groupThreadId;
  const clientMessageId = operation.clientMessageId ?? randomUUID();
  let endpoint = '/send-message';
  let body;
  let expected;
  let send;
  if (operation.type === 'SEND_FILE' || operation.type === 'SEND_GALLERY') {
    const count = operation.type === 'SEND_FILE' ? 1 : 2;
    const parts = await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const color = createHash('sha256')
          .update(`${operation.id}:${index}`)
          .digest();
        return {
          partId: randomUUID(),
          filename: `${operation.id}-${index}.png`,
          mimeType: 'image/png',
          bytes: await sharp({
            create: {
              width: 32,
              height: 32,
              channels: 4,
              background: { r: color[0], g: color[1], b: color[2], alpha: 1 },
            },
          })
            .png()
            .toBuffer(),
        };
      }),
    );
    endpoint = '/send-media + /upload';
    body = { threadId, clientMessageId, fileCnt: count };
    expected = {
      assets: parts.map(({ bytes }) => ({
        digest: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      })),
    };
    send = () => actor.sendMedia({ threadId, clientMessageId, parts });
  } else if (operation.type.startsWith('FORWARD_')) {
    endpoint = '/send-forward';
    body = {
      threadId,
      clientMessageId,
      mode: operation.type === 'FORWARD_DIRECT' ? 'DIRECT' : 'HISTORY',
      sourceMessages: [{ threadId, seq: operation.target.seq }],
    };
    expected = {
      sourceText: parseContent(operation.target.content)?.text,
      ...(body.mode === 'DIRECT'
        ? { text: parseContent(operation.target.content)?.text }
        : {}),
    };
    send = () => actor.post(endpoint, body, `forward ${operation.id}`);
  } else {
    const text = `federation-lab ${operation.id}`;
    const content = {
      text,
      ...(operation.type === 'SEND_QUOTE'
        ? { quote: { seq: operation.target.seq } }
        : {}),
    };
    body = {
      threadId,
      clientMessageId,
      contentType: 'PURE_TEXT',
      content: JSON.stringify(content),
      text,
    };
    expected = {
      text,
      ...(operation.type === 'SEND_QUOTE'
        ? {
            quote: {
              seq: operation.target.seq,
              ...(operation.target.creatorDomain
                ? { actor: operation.target.creatorAddress }
                : {}),
              ...(Number.isSafeInteger(operation.target.publisherNamespaceId) &&
              Number.isSafeInteger(operation.target.profileNamespaceId)
                ? {
                    authorRef: {
                      account: operation.target.creatorAccount,
                      publisherNamespaceId:
                        operation.target.publisherNamespaceId,
                      profileNamespaceId: operation.target.profileNamespaceId,
                    },
                  }
                : operation.target.creatorAddress
                  ? { actor: operation.target.creatorAddress }
                  : {}),
            },
          }
        : {}),
    };
    send = ['SEND_GROUP_MESSAGE', 'SEND_P2P_MESSAGE'].includes(operation.type)
      ? () => actor.sendText(threadId, text, clientMessageId)
      : () =>
          actor.post(
            endpoint,
            {
              threadId,
              clientMessageId,
              contentType: body.contentType,
              content: body.content,
            },
            `quote ${operation.id}`,
          );
  }
  const result = await submitMessage(send, operation.retryMode);
  return {
    actor,
    request: { method: 'POST', endpoint, body },
    expected,
    ...result,
  };
}
