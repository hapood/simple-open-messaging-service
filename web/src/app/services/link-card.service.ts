import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiPrefix } from './constants';
import type { StandardResponse } from './model';

export interface LinkCardRule {
  id: number;
  hostname: string;
}

export interface DerivedLinkCard {
  rule: LinkCardRule;
  url: string;
  start: number;
  end: number;
}

@Injectable({ providedIn: 'root' })
export class LinkCardService {
  private readonly http = inject(HttpClient);
  readonly rules = signal<readonly LinkCardRule[]>([]);

  matchFirst(text: string): DerivedLinkCard | null {
    for (const candidate of urlCandidates(text)) {
      let parsed: URL;
      try {
        parsed = new URL(candidate.url);
      } catch {
        continue;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      const host = parsed.hostname.toLowerCase();
      const rule = this.rules().find(
        (item) =>
          host === item.hostname || host.endsWith(`.${item.hostname}`),
      );
      if (rule)
        return {
          rule,
          url: candidate.url,
          start: candidate.start,
          end: candidate.end,
        };
    }
    return null;
  }

  /** App bootstrap waits for this after session restoration, so message rows never render against an
   * empty, still-loading allowlist and then jump from plain text to cards. A failed request degrades
   * to no cards and still releases bootstrap rather than leaving the launch screen stuck. */
  async loadRules(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.http.get<StandardResponse<LinkCardRule[]>>(
          `${apiPrefix()}/link-card-rules`,
        ),
      );
      this.rules.set(response.data ?? []);
    } catch {
      this.rules.set([]);
    }
  }
}

function* urlCandidates(
  text: string,
): Generator<{ url: string; start: number; end: number }> {
  const regex = /https?:\/\/[^\s<>"']+/giu;
  for (const match of text.matchAll(regex)) {
    let url = match[0];
    while (/[.,;:!?，。；：！？、）】》〉]$/u.test(url)) url = url.slice(0, -1);
    if (!url || match.index === undefined) continue;
    yield { url, start: match.index, end: match.index + url.length };
  }
}
