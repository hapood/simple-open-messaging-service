/** Paint-only composer candidates, matching the native editor's scheme-based recognition.
 * A candidate starts at the first HTTP(S) scheme in a non-whitespace run and ends at its
 * boundary. It is not a validated URL: fetching and SSRF validation belong to the server.
 * Offsets are UTF-16, matching both browser editor and Android Editable offsets.
 */
export interface ComposerUrlMarker {
  href: string;
  start: number;
  end: number;
}

export function detectComposerUrls(text: string): ComposerUrlMarker[] {
  const markers: ComposerUrlMarker[] = [];
  // Kotlin Char.isWhitespace includes Unicode separators and U+001C–U+001F,
  // but not the BOM treated as whitespace by JavaScript's \\s.
  const runs = /[^\p{Z}\u0009-\u000d\u001c-\u001f]+/gu;
  for (const run of text.matchAll(runs)) {
    const scheme = /https?:\/\//i.exec(run[0]);
    if (!scheme) continue;
    const start = run.index + scheme.index;
    const end = run.index + run[0].length;
    markers.push({ href: text.slice(start, end), start, end });
  }
  return markers;
}
