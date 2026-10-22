/** Format the credibility source shown by both link-card previews and delivered link messages. */
export function linkCardSource(url: string, siteName?: string): string {
  const source = siteName?.trim() || linkCardHost(url);
  return source.replace(/^www\./i, '');
}

/** Extract the normalized hostname used as the card title/source fallback. */
export function linkCardHost(url: string): string {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.replace(/^www\./i, '') || parsed.protocol.slice(0, -1)
    );
  } catch {
    return url;
  }
}
