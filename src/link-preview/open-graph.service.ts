import { Injectable } from '@nestjs/common';

/**
 * Parsed OpenGraph metadata for a page. `image` is an absolute URL resolved against the page's final
 * URL (after redirects); the caller localizes it into CAS. Fields are absent when the page provided
 * none. The caller supplies required empty strings or a user-text description fallback.
 */
export interface OpenGraphMeta {
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  siteName?: string;
}

export type OpenGraphImageSelection = 'first' | 'last';

/**
 * Extract OpenGraph / Twitter-Card / HTML metadata from a page's HTML. No DOM parser dependency
 * (cheerio/jsdom) — a regex pass over `<meta>` tags is sufficient and avoids a heavy attack surface
 * for untrusted remote HTML. For each field we prefer the OpenGraph value, fall back to the Twitter
 * Card value, then to the native HTML `<title>` / `description` meta — not every site implements OG,
 * so the fallback chain is what makes previews reliably non-empty.
 *
 * Output is HTML-entity-decoded, whitespace-collapsed, and length-capped so a stored LINK card can
 * never carry an over-long or raw-entity title (the store-time `parseLinkContent` guard re-checks).
 */
@Injectable()
export class OpenGraphService {
  parse(
    html: string,
    baseUrl: string,
    imageSelection: OpenGraphImageSelection = 'first',
    descriptionSelection: OpenGraphImageSelection = 'first',
  ): OpenGraphMeta {
    const metas = this.extractMetaMap(html);
    const pick = (keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = metas.get(k)?.[0];
        if (v) return v;
      }
      return undefined;
    };
    const title =
      pick(['og:title', 'twitter:title']) ?? this.extractTitleTag(html);
    const description = this.pickOrdered(
      metas,
      ['og:description', 'twitter:description', 'description'],
      descriptionSelection,
    );
    const siteName = pick(['og:site_name']);
    const imageRaw = this.pickImage(metas, imageSelection);
    let image: string | undefined;
    if (imageRaw) {
      try {
        image = new URL(imageRaw, baseUrl).href;
      } catch {
        image = undefined;
      }
    }
    const faviconRaw = this.extractFavicon(html) ?? '/favicon.ico';
    let favicon: string | undefined;
    try {
      favicon = new URL(faviconRaw, baseUrl).href;
    } catch {
      favicon = undefined;
    }
    return {
      title: this.cap(this.clean(title), MAX_TITLE),
      description: this.cap(this.clean(description), MAX_DESC),
      image,
      favicon,
      siteName: this.cap(this.clean(siteName), MAX_SITE_NAME),
    };
  }

  private pickOrdered(
    metas: Map<string, string[]>,
    keys: string[],
    selection: OpenGraphImageSelection,
  ): string | undefined {
    for (const key of keys) {
      const values = metas.get(key)?.filter(Boolean);
      if (values?.length) {
        return selection === 'last' ? values.at(-1) : values[0];
      }
    }
    return undefined;
  }

  private pickImage(
    metas: Map<string, string[]>,
    selection: OpenGraphImageSelection,
  ): string | undefined {
    for (const key of [
      'og:image',
      'og:image:url',
      'og:image:secure_url',
      'twitter:image',
      'twitter:image:src',
    ]) {
      const values = metas.get(key)?.filter(Boolean);
      if (values?.length) {
        return selection === 'last' ? values.at(-1) : values[0];
      }
    }
    return undefined;
  }

  /** Prefer an explicit page icon; fall back to the conventional origin /favicon.ico in parse(). */
  private extractFavicon(html: string): string | undefined {
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0];
      const rel = this.readAttr(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
      if (!rel.includes('icon')) continue;
      const href = this.readAttr(tag, 'href');
      if (href) return this.decodeEntities(href);
    }
    return undefined;
  }

  /** Build a lowercased property/name → ordered content list from every `<meta>` tag. */
  private extractMetaMap(html: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      const tag = m[0];
      const key = (
        this.readAttr(tag, 'property') ?? this.readAttr(tag, 'name')
      )?.toLowerCase();
      const content = this.readAttr(tag, 'content');
      if (key && content !== undefined) {
        const values = map.get(key) ?? [];
        values.push(this.decodeEntities(content));
        map.set(key, values);
      }
    }
    return map;
  }

  private extractTitleTag(html: string): string | undefined {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? m[1] : undefined;
  }

  /** Read a quoted-or-unquoted attribute value from a tag string, or undefined when absent. */
  private readAttr(tag: string, name: string): string | undefined {
    const re = new RegExp(
      `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      'i',
    );
    const m = tag.match(re);
    return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined;
  }

  private clean(s: string | undefined): string | undefined {
    if (!s) return undefined;
    const t = s.replace(/\s+/g, ' ').trim();
    return t || undefined;
  }

  private cap(s: string | undefined, max: number): string | undefined {
    if (!s) return undefined;
    return s.length > max ? s.slice(0, max) : s;
  }

  /** Decode the common named + numeric HTML entities OG values carry (`&amp;`, `&#39;`, `&#x27;`). */
  private decodeEntities(s: string): string {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)));
  }
}

/** Render a numeric code point, guarding against surrogate/out-of-range values that would throw. */
function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

const MAX_TITLE = 300;
const MAX_DESC = 500;
const MAX_SITE_NAME = 100;
