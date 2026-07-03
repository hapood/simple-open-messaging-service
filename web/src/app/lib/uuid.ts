/**
 * Generate an RFC 4122 v4 UUID — always spec-compliant, in any context.
 *
 * `crypto.randomUUID()` is the natural source but is gated to SECURE contexts (https or localhost): it is `undefined`
 * on a plain-HTTP non-localhost origin (e.g. http://192.168.2.7:4200). The naïve `?? Date.now()+Math.random()` fallback
 * used in three call sites produced a NON-UUID string there, which the backend rejects for fields that validate UUID
 * format (`SendMessageDto.clientMessageId` → code 10000 "clientMessageId must be a UUID").
 *
 * `crypto.getRandomValues` is NOT secure-context-gated, so the fallback below builds a real v4 UUID from it. Use this
 * everywhere a UUID is needed (clientMessageId, device_id, …) instead of hand-rolling `randomUUID ?? <non-uuid>`.
 */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant (RFC 4122)
  const h = (i: number): string => b[i].toString(16).padStart(2, '0');
  return `${h(0)}${h(1)}${h(2)}${h(3)}-${h(4)}${h(5)}-${h(6)}${h(7)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`;
}
