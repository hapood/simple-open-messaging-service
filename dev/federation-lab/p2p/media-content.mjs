import { parseContent } from './message-operations.mjs';

// Stored message content keeps canonical CAS identities. Contextual authorization
// coordinates are added at client/rendering boundaries, not persisted in the
// durable message body.
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
        /^\/uploads\/msg-assets\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})$/,
      );
    if (!match) {
      errors.push(`${label}: invalid canonical CAS URL`);
      continue;
    }
    const [, first, second, digest] = match;
    if (first !== digest.slice(0, 2) || second !== digest.slice(2, 4)) {
      errors.push(`${label}: CAS URL does not match digest path`);
    }
  }
  return { content, errors };
}
