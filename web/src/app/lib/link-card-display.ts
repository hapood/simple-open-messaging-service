/** Format the credibility source shown by both link-card previews and delivered link messages. */
export function linkCardSource(url: string, siteName?: string): string {
  const source = siteName?.trim() || linkCardHost(url);
  return source.replace(/^www\./i, '');
}

/** Extract the normalized hostname used as the card title/source fallback. */
export function linkCardHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}
