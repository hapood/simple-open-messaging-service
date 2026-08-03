const CAS_URL_RE =
  /\/uploads\/cas\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}(?:\?threadId=[0-9]+&seq=[0-9]+)?/g;

/** Bind every CAS reference in serialized message content to its authorizing carrier Message. */
export function contextualizeCasUrls(
  content: string,
  threadId: number,
  seq: number,
): string {
  return content.replace(
    CAS_URL_RE,
    (url) => `${url.split('?')[0]}?threadId=${threadId}&seq=${seq}`,
  );
}

export function contextualCasUrl(
  digest: string,
  threadId: number,
  seq: number,
): string {
  return `/uploads/cas/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}?threadId=${threadId}&seq=${seq}`;
}
