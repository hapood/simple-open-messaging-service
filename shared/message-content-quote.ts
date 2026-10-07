export interface MessageContentQuote {
  seq: number;
  digest?: string;
  namespaceId?: number;
  sourceSeq?: number;
  status?: 'PENDING' | 'NOT_FOUND';
  [key: string]: unknown;
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const quote = (value as Record<string, unknown>).quote;
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) return undefined;
  const record = quote as Record<string, unknown>;
  if (!Number.isSafeInteger(record.seq) || Number(record.seq) < 0) return undefined;
  if (
    record.digest !== undefined &&
    (typeof record.digest !== 'string' || !/^[a-f0-9]{64}$/.test(record.digest))
  )
    return undefined;
  return record as MessageContentQuote;
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return content;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.quote;
  return JSON.stringify(copy);
}
