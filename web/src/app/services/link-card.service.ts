import { Injectable } from '@angular/core';

export interface DerivedLinkCard {
  url: string;
  start: number;
  end: number;
}

@Injectable({ providedIn: 'root' })
export class LinkCardService {
  matchFirst(text: string): DerivedLinkCard | null {
    for (const candidate of urlCandidates(text)) {
      let parsed: URL;
      try {
        parsed = new URL(candidate.url);
      } catch {
        continue;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      return {
        url: candidate.url,
        start: candidate.start,
        end: candidate.end,
      };
    }
    return null;
  }

  firstUrl(text: string): string | null {
    return urlCandidates(text).next().value?.url ?? null;
  }
}

function* urlCandidates(
  text: string,
): Generator<{ url: string; start: number; end: number }> {
  const regex = /https?:\/\/[^\s<>"'，。；：！？、（）【】《》〈〉]+/giu;
  for (const match of text.matchAll(regex)) {
    let url = match[0];
    while (/[.,;:!?，。；：！？、）】》〉]$/u.test(url)) url = url.slice(0, -1);
    if (!url || match.index === undefined) continue;
    yield { url, start: match.index, end: match.index + url.length };
  }
}
