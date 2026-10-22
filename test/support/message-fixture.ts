import { createHash } from 'node:crypto';
import { message } from '../../src/database/schema.js';
import { wirePayloadDigest } from '../../src/federation/federated-message-content.js';

type MessageInsert = typeof message.$inferInsert;

function fillDigest(values: MessageInsert): MessageInsert {
  if (values.payloadDigest !== undefined) return values;
  // SYSTEM rows are exempt from Message_payload_digest_check.
  if (values.contentType === 'SYSTEM') return values;
  // Prefer the canonical wire digest; fixtures with placeholder content that
  // cannot be projected to the wire form (e.g. an IMAGE body without files)
  // fall back to a content hash. The check only demands a non-NULL digest, and
  // these rows never cross to a peer that would recompute it.
  let digest: string;
  try {
    digest = wirePayloadDigest(
      values.contentType as Parameters<typeof wirePayloadDigest>[0],
      values.content,
    );
  } catch {
    digest = createHash('sha256')
      .update(values.content ?? '')
      .digest('hex');
  }
  return { ...values, payloadDigest: digest };
}

/**
 * Wraps direct `Message` fixture inserts so they satisfy
 * `Message_payload_digest_check`, which requires a non-NULL hop-independent
 * digest for every non-SYSTEM row. Tests that assert on exact digest values
 * keep passing their own `payloadDigest`; the wrapper only fills the gap.
 */
export function withMessageDigest(values: MessageInsert): MessageInsert;
export function withMessageDigest(values: MessageInsert[]): MessageInsert[];
export function withMessageDigest(
  values: MessageInsert | MessageInsert[],
): MessageInsert | MessageInsert[] {
  if (Array.isArray(values)) return values.map(fillDigest);
  return fillDigest(values);
}
