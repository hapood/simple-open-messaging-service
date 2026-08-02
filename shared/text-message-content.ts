/** Canonical JSON envelope stored in Message.content for PURE_TEXT rows. */
export interface TextMessageContent {
  text: string;
  quote?: {
    seq: number;
    author?: string;
    body?: string;
    contentType?: string;
    image?: string;
    imageLabel?: string;
    imageIdentity?: string;
    imageSize?: number;
    imageShape?: 'thumbnail' | 'avatar';
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
    for (const field of [
      'author',
      'body',
      'contentType',
      'image',
      'imageLabel',
      'imageIdentity',
    ] as const) {
      if (quote[field] !== undefined && typeof quote[field] !== 'string')
        return null;
    }
    if (
      quote['imageSize'] !== undefined &&
      (typeof quote['imageSize'] !== 'number' ||
        !Number.isFinite(quote['imageSize']) ||
        quote['imageSize'] < 0)
    )
      return null;
    if (
      quote['imageShape'] !== undefined &&
      quote['imageShape'] !== 'thumbnail' &&
      quote['imageShape'] !== 'avatar'
    )
      return null;
    result.quote = {
      seq: Number(quote['seq']),
      ...(typeof quote['author'] === 'string'
        ? { author: quote['author'] }
        : {}),
      ...(typeof quote['body'] === 'string' ? { body: quote['body'] } : {}),
      ...(typeof quote['contentType'] === 'string'
        ? { contentType: quote['contentType'] }
        : {}),
      ...(typeof quote['image'] === 'string' ? { image: quote['image'] } : {}),
      ...(typeof quote['imageLabel'] === 'string'
        ? { imageLabel: quote['imageLabel'] }
        : {}),
      ...(typeof quote['imageIdentity'] === 'string'
        ? { imageIdentity: quote['imageIdentity'] }
        : {}),
      ...(typeof quote['imageSize'] === 'number'
        ? { imageSize: quote['imageSize'] }
        : {}),
      ...(quote['imageShape'] === 'thumbnail' ||
      quote['imageShape'] === 'avatar'
        ? { imageShape: quote['imageShape'] }
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
