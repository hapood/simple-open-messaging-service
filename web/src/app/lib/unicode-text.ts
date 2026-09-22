/** Limit text by Unicode code points rather than UTF-16 code units. */
export function limitUnicodeCodePoints(value: string, max: number): string {
  return [...value].slice(0, max).join('');
}

/** Count Unicode code points accepted by the text boundary. */
export function unicodeCodePointLength(value: string): number {
  return [...value].length;
}
