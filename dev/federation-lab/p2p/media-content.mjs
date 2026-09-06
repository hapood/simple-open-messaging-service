import { parseContent } from './message-operations.mjs';

// Media URLs authorize a node-local carrier; only the CAS identity is portable.
export function mediaContentEvidence(message) {
  const content = parseContent(message.content);
  const errors = [];
  const gallery = message.contentType === 'GALLERY';
  if (
    !gallery &&
    !['FILE', 'IMAGE', 'VIDEO', 'AUDIO'].includes(message.contentType)
  )
    return { content, errors };
  if (gallery && (!Array.isArray(content?.items) || content.items.length === 0))
    return { content, errors: ['invalid gallery items'] };
  const items = gallery ? content.items : [content];
  for (const [index, item] of items.entries()) {
    const label = gallery ? `items[${index}]` : 'content';
    const match =
      typeof item?.url === 'string' &&
      item.url.match(
        /^\/uploads\/msg-assets\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\?([^#]+)$/,
      );
    if (!match) {
      errors.push(`${label}: invalid contextual CAS URL`);
      continue;
    }
    const [, first, second, digest, query] = match;
    const params = new URLSearchParams(query);
    const coordinate = (key, expected) =>
      Number.isSafeInteger(expected) &&
      expected > 0 &&
      params.getAll(key).length === 1 &&
      params.get(key) === String(expected);
    if (
      first !== digest.slice(0, 2) ||
      second !== digest.slice(2, 4) ||
      [...params.keys()].length !== 2 ||
      !coordinate('threadId', message.threadId) ||
      !coordinate('seq', message.seq)
    ) {
      errors.push(
        `${label}: CAS URL does not match local carrier or digest path`,
      );
      continue;
    }
    // Preserve every metadata field and item order, including the digest in the path.
    item.url = `/uploads/msg-assets/${first}/${second}/${digest}`;
  }
  return { content, errors };
}
