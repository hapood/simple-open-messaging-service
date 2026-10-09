/** Canonical JSON envelope stored in Message.content for PURE_TEXT rows. */
export interface TextMessageContent {
  text: string;
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

    return { text: record['text'] };
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
