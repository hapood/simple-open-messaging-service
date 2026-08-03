import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiPrefix } from './constants';
import type { StandardResponse } from './model';
import { assetUrl } from './runtime';

export interface LinkCardRule {
  id: number;
  matchUrl: string;
  hostname: string;
  displayName: string;
  includeSubdomains: boolean;
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
  private readonly faviconUrls = new Map<number, Promise<string | null>>();
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
          host === item.hostname ||
          (item.includeSubdomains && host.endsWith(`.${item.hostname}`)),
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

  faviconUrl(ruleId: number): Promise<string | null> {
    const cached = this.faviconUrls.get(ruleId);
    if (cached) return cached;
    const request = firstValueFrom(
      this.http.get<StandardResponse<{ url: string }>>(
        `${apiPrefix()}/link-card-rules/${ruleId}/favicon`,
      ),
    )
      .then((response) =>
        response.data?.url ? assetUrl(response.data.url) : null,
      )
      .catch(() => null);
    this.faviconUrls.set(ruleId, request);
    return request;
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
