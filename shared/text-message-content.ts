/** Canonical JSON envelope stored in Message.content for PURE_TEXT rows. */
export interface TextMessageContent {
  text: string;
  quote?: {
    /** Durable namespace-scoped sequence; read projection emits local seq (zero if unresolved). */
    seq: number;
    /** Durable coordinate namespace: zero is local seq, positive is that source's originSeq. */
    namespaceId?: number;
    /** Legacy durable / unresolved read coordinate; new durable writes use seq + namespaceId. */
    sourceSeq?: number;
    status?: 'PENDING' | 'NOT_FOUND';
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

/** Local SOMS product default; this is not a Federation v1 wire limit. */
export const TEXT_MESSAGE_MAX_CODE_POINTS = 4000;

/** JSON Schema string lengths and the Federation contract count Unicode code points. */
export function unicodeCodePointLength(value: string): number {
  return Array.from(value).length;
}

export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
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
    if (
      quote['namespaceId'] !== undefined &&
      (!Number.isSafeInteger(quote['namespaceId']) ||
        Number(quote['namespaceId']) < 0)
    )
      return null;
    if (
      quote['sourceSeq'] !== undefined &&
      (!Number.isSafeInteger(quote['sourceSeq']) ||
        Number(quote['sourceSeq']) < 1)
    )
      return null;
    if (
      quote['status'] !== undefined &&
      quote['status'] !== 'PENDING' &&
      quote['status'] !== 'NOT_FOUND'
    )
      return null;
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
      ...(quote['namespaceId'] === undefined
        ? {}
        : { namespaceId: Number(quote['namespaceId']) }),
      ...(quote['sourceSeq'] === undefined
        ? {}
        : { sourceSeq: Number(quote['sourceSeq']) }),
      ...(quote['status'] === 'PENDING' || quote['status'] === 'NOT_FOUND'
        ? { status: quote['status'] }
        : {}),
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

/** Older unresolved rows used sourceSeq and inherited the containing message's namespace. */
export function storedQuoteCoordinate(
  quote: NonNullable<TextMessageContent['quote']>,
  sourceNamespaceId: number,
): { seq: number; namespaceId: number } {
  if (quote.namespaceId !== undefined)
    return { seq: quote.seq, namespaceId: quote.namespaceId };
  return quote.sourceSeq === undefined
    ? { seq: quote.seq, namespaceId: 0 }
    : { seq: quote.sourceSeq, namespaceId: sourceNamespaceId };
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
