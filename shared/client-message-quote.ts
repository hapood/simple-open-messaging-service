/** Client references contain only origin coordinates, never a stored preview or digest. */
export interface ClientMessageQuote {
  namespaceId: number;
  originSeq: number;
}

export function parseClientMessageQuote(
  content: string,
): ClientMessageQuote | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const quote = (value as Record<string, unknown>)['quote'];
  if (!quote || typeof quote !== 'object' || Array.isArray(quote))
    return undefined;
  const record = quote as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record['namespaceId']) ||
    Number(record['namespaceId']) < 0 ||
    !Number.isSafeInteger(record['originSeq']) ||
    Number(record['originSeq']) < 1
  )
    return undefined;
  return {
    namespaceId: Number(record['namespaceId']),
    originSeq: Number(record['originSeq']),
  };
}
