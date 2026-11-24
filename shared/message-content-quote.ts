export type MessageContentQuote = MessageContentQuoteFields &
  (
    | {
        seq: number;
        originSeq?: never;
        namespaceId?: number;
        sourceSeq?: number;
      }
    | { originSeq: number; seq?: never; namespaceId?: never; sourceSeq?: never }
  );

interface MessageContentQuoteFields {
  digest?: string;
  status?: 'PENDING' | 'NOT_FOUND';
  author?: string;
  body?: string;
  contentType?: string;
  image?: string;
  imageLabel?: string;
  imageIdentity?: string;
  imageSize?: number;
  imageShape?: 'thumbnail' | 'avatar';
  [key: string]: unknown;
}

/** Resolve a durable quote independently of the containing message's content type. */
export function storedQuoteCoordinate(
  quote: MessageContentQuote,
  publisherNamespaceId: number,
): { seq: number; namespaceId: number } {
  // originSeq was received in this server's coordinate space. Resolve it here,
  // without changing the durable wire discriminant into a local seq.
  if (quote.originSeq !== undefined)
    return { seq: quote.originSeq, namespaceId: 0 };
  if (quote.namespaceId !== undefined)
    return { seq: quote.seq, namespaceId: quote.namespaceId };
  return quote.sourceSeq === undefined
    ? { seq: quote.seq, namespaceId: 0 }
    : { seq: quote.sourceSeq, namespaceId: publisherNamespaceId };
}

/** Read the common top-level quote envelope from any JSON message payload. */
export function parseMessageContentQuote(
  content: string,
): MessageContentQuote | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  return parseQuoteValue((value as Record<string, unknown>)['quote']);
}

function parseQuoteValue(quote: unknown): MessageContentQuote | undefined {
  if (!quote || typeof quote !== 'object' || Array.isArray(quote))
    return undefined;
  const record = quote as Record<string, unknown>;
  if (Object.hasOwn(record, 'originSeq')) {
    if (
      Object.hasOwn(record, 'seq') ||
      Object.hasOwn(record, 'namespaceId') ||
      Object.hasOwn(record, 'sourceSeq') ||
      !Number.isSafeInteger(record['originSeq']) ||
      Number(record['originSeq']) <= 0 ||
      Number(record['originSeq']) >= Number.MAX_SAFE_INTEGER
    )
      return undefined;
  } else if (!Number.isSafeInteger(record['seq']) || Number(record['seq']) < 0)
    return undefined;
  if (
    record['digest'] !== undefined &&
    (typeof record['digest'] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record['digest']))
  )
    return undefined;
  for (const field of ['namespaceId', 'sourceSeq'] as const) {
    if (
      record[field] !== undefined &&
      (!Number.isSafeInteger(record[field]) ||
        Number(record[field]) < (field === 'namespaceId' ? 0 : 1))
    )
      return undefined;
  }
  if (
    record['status'] !== undefined &&
    record['status'] !== 'PENDING' &&
    record['status'] !== 'NOT_FOUND'
  )
    return undefined;
  return record as MessageContentQuote;
}

/** Validate an optional quote at an input boundary, including malformed present fields. */
export function readMessageContentQuote(
  content: string,
): MessageContentQuote | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  if (!Object.hasOwn(value, 'quote')) return undefined;
  const quote = parseQuoteValue((value as Record<string, unknown>)['quote']);
  if (!quote) throw new Error('invalid message quote');
  return quote;
}

/** Return the payload with a server-authored quote at its top level. */
export function withMessageContentQuote(
  content: string,
  quote: MessageContentQuote,
): string {
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('message content must be a JSON object');
  }
  return JSON.stringify({ ...(value as Record<string, unknown>), quote });
}

/** Remove reply context when a message is copied into a direct forward. */
export function withoutMessageContentQuote(content: string): string {
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return content;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy['quote'];
  return JSON.stringify(copy);
}
