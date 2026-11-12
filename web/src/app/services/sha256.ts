/**
 * SHA-256 for avatar digests.
 *
 * The web client is deployed as a secure context, so WebCrypto is the
 * audited implementation; when `crypto.subtle` is unavailable this rejects
 * with a clear error instead of silently switching algorithms.
 */
export async function sha256(input: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 requires WebCrypto (secure context)');
  const hash = new Uint8Array(await subtle.digest('SHA-256', input));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
