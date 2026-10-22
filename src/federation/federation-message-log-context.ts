import { createHash } from 'node:crypto';

/**
 * Structured, size-bounded log context for one federated wire message. Shared by the inbound
 * page orchestrator and the inbound store so both log the same diagnostic shape for the same
 * item. Never logs raw content; logs its byte length and SHA-256 only.
 */
export function federatedMessageLogContext(
  peerDomain: string,
  item: unknown,
  error: unknown,
  context?: Record<string, unknown>,
): string {
  const record = logRecord(item);
  const content =
    typeof record?.['content'] === 'string' ? record['content'] : undefined;
  const author = logAddress(record?.['author']);
  const thread = logThread(record?.['thread']);
  const reason =
    error instanceof Error
      ? `${safeLogText(error.name, 80)}: ${safeLogText(error.message, 320)}`
      : safeLogText(error, 320);
  return JSON.stringify({
    peerDomain: safeLogText(peerDomain, 253),
    seq: safeLogText(record?.['seq'], 32),
    contentType: safeLogText(record?.['contentType'], 80),
    ...(content === undefined
      ? {}
      : {
          contentBytes: Buffer.byteLength(content),
          contentSha256: createHash('sha256').update(content).digest('hex'),
        }),
    ...(author === undefined ? {} : { author }),
    ...(thread === undefined ? {} : { thread }),
    ...(context === undefined ? {} : { context: logContext(context) }),
    reason,
  });
}

function logRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function logAddress(value: unknown): Record<string, string> | undefined {
  const record = logRecord(value);
  if (!record) return undefined;
  return {
    ...(record['ref'] === undefined
      ? { account: safeLogText(record['account'], 128) }
      : { ref: safeLogText(record['ref'], 32) }),
    namespaceId: safeLogText(record['namespaceId'], 32),
  };
}

function logThread(value: unknown): Record<string, unknown> | undefined {
  const record = logRecord(value);
  if (!record) return undefined;
  const type = safeLogText(record['type'], 32);
  if (type === 'GROUP') {
    return {
      type,
      account: safeLogText(record['account'], 128),
      domain: safeLogText(record['domain'], 253),
    };
  }
  if (type === 'P2P') {
    const participants = Array.isArray(record['participants'])
      ? record['participants']
          .slice(0, 2)
          .map(logAddress)
          .filter((address) => address !== undefined)
      : [];
    return {
      type,
      account: safeLogText(record['account'], 128),
      peerAccount: safeLogText(record['peerAccount'], 128),
      participants,
    };
  }
  return {
    type,
    account: safeLogText(record['account'], 128),
    peerAccount: safeLogText(record['peerAccount'], 128),
  };
}

function logContext(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, safeLogText(entry, 128)]),
  );
}

function safeLogText(value: unknown, maxLength: number): string {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'bigint'
        ? String(value)
        : '';
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '�').slice(0, maxLength);
}
