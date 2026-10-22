import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

/**
 * Canonical JSON (JCS, RFC 8785) for federation `JsonObjectString` fields.
 *
 * Federation v1 Core Protocol §6.1.1 mandates that a field whose type is
 * `JsonObjectString` (a JSON object encoded as a string, such as a message
 * `content` field) be serialized using the JSON Canonicalization Scheme so the
 * same logical value yields byte-identical output across implementations and
 * time.
 *
 * Serialization is delegated to `canonicalize`, the JavaScript implementation
 * named by RFC 8785 itself (§"JavaScript implementation") and maintained by
 * one of the RFC's co-authors. It enforces every RFC 8785 rule the federation
 * content domain relies on:
 *
 * - object members sorted by member name in UTF-16 code unit order (RFC 8785
 *   §3.2.3, via `Array.prototype.sort` over `Object.keys`);
 * - numbers serialized per ECMAScript `Number.prototype.toString` (RFC 8785
 *   §3.2.2.3): minimal length, no trailing zero, exponent only when needed,
 *   `-0` serialized as `0`;
 * - strings escaped only where required (`"`, `\`, and `U+0000`–`U+001F`),
 *   with lone surrogates rejected (RFC 8785 §3.2.2.2);
 * - `NaN`, `Infinity`, and `-Infinity` rejected rather than silently coerced
 *   to `null` (RFC 8785 §3.2.2.3);
 * - circular references detected and rejected;
 * - no insignificant whitespace; output is a UTF-8 string without a BOM.
 *
 * `canonicalize` returns `undefined` only when the input itself is `undefined`
 * (or a value `JSON.stringify` drops). Because `canonicalJson` requires a JSON
 * object at the top level, the result is always a defined string here.
 *
 * A producer MUST NOT inject a `null` where a JSON object is required.
 * `canonicalJson` validates the top-level shape (object only); deeper-shape
 * validation belongs at the projection layer.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('canonical JSON requires a JSON object');
  }
  const result = canonicalize(value);
  if (result === undefined) {
    throw new Error('canonical JSON produced no output for the given value');
  }
  return result;
}

/**
 * Canonical `JsonObjectString` for a `content` field that already arrives as a
 * string. The string is parsed once, validated to be a JSON object, and
 * re-serialized to the canonical form. This is the "re-serialize to the
 * canonical form before storing, re-publishing, or computing a content digest"
 * step of Core Protocol §6.1.1.
 */
export function canonicalContentString(content: string): string {
  const value: unknown = JSON.parse(content);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('canonical content string requires a JSON object');
  }
  const result = canonicalize(value);
  if (result === undefined) {
    throw new Error('canonical content string produced no output');
  }
  return result;
}

/**
 * The hop-independent content digest of a `JsonObjectString` `content` field,
 * defined by Core Protocol §6.1.1 as `sha256` over the UTF-8 bytes of the JCS
 * canonical form of the parsed `content` value. The input is the wire (or
 * stored) `content` string; it is parsed and canonicalized before hashing, so
 * the digest is stable across producers and hops regardless of the input's
 * member order or number formatting.
 *
 * Returns the 64-character lowercase hex digest.
 */
export function payloadDigest(
  content: string,
  assets: ReadonlyArray<{ digest: string; bytes: number }> = [],
  quoteDigest?: string,
): string {
  const canonicalAssets = [...assets]
    .map(({ digest, bytes }) => ({ digest, bytes }))
    .sort((a, b) => a.digest.localeCompare(b.digest));
  return createHash('sha256')
    .update(
      canonicalJson({
        content: JSON.parse(canonicalContentString(content)) as unknown,
        assets: canonicalAssets,
        ...(quoteDigest === undefined ? {} : { quoteDigest }),
      }),
      'utf8',
    )
    .digest('hex');
}
