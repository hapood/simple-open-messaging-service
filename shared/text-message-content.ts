/** Canonical JSON envelope stored in Message.content for PURE_TEXT rows. */
export interface TextMessageContent {
  text: string;
  quote?: {
    seq: number;
    preview?: string;
  };
}

export function parseTextMessageContent(
  content: string,
): TextMessageContent | null {
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const record = value as Record<string, unknown>;
    if (typeof record['text'] !== 'string') return null;

    const result: TextMessageContent = { text: record['text'] };
    if (record['quote'] === undefined) return result;
    if (
      !record['quote'] ||
      typeof record['quote'] !== 'object' ||
      Array.isArray(record['quote'])
    )
      return null;

    const quote = record['quote'] as Record<string, unknown>;
    if (!Number.isInteger(quote['seq']) || Number(quote['seq']) < 0)
      return null;
    if (quote['preview'] !== undefined && typeof quote['preview'] !== 'string')
      return null;
    result.quote = {
      seq: Number(quote['seq']),
      ...(typeof quote['preview'] === 'string'
        ? { preview: quote['preview'] }
        : {}),
    };
    return result;
  } catch {
    return null;
  }
}

/** Parse a PURE_TEXT value that has already crossed an input-validation boundary. */
export function requireTextMessageContent(content: string): TextMessageContent {
  const parsed = parseTextMessageContent(content);
  if (!parsed) throw new Error('invalid PURE_TEXT message envelope');
  return parsed;
}

export function stringifyTextMessageContent(
  content: TextMessageContent,
): string {
  return JSON.stringify(content);
}
