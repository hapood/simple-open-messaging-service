import { sha256 } from './sha256';

/** Decode the JSON transport once, then keep only binary bytes in the client cache. */
export async function decodeProfileAvatar(
  base64: string | null,
): Promise<{ digest: string; blob: Blob } | null> {
  if (base64 === null) return null;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // sha256() prefers SubtleCrypto; the production module throws without it, and the
  // playground build swaps in a pure-TypeScript fallback for plain-HTTP origins.
  const digest = await sha256(bytes);
  return { digest, blob: new Blob([bytes], { type: 'image/webp' }) };
}

/** Notification and request APIs need a data URL, but it is never persisted. */
export async function avatarBlobDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}
