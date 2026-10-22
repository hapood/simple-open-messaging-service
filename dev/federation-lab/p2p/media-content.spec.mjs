import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaContentEvidence } from './media-content.mjs';

const path = `/uploads/msg-assets/aa/aa/${'a'.repeat(64)}`;
for (const contentType of ['FILE', 'IMAGE', 'VIDEO', 'AUDIO']) {
  test(`${contentType} compares canonical CAS content`, () => {
    const message = {
      threadId: 22,
      seq: 2,
      contentType,
      content: {
        url: path,
        name: 'file',
        size: 147,
        mimeType: 'image/png',
      },
    };
    assert.deepEqual(mediaContentEvidence(message), {
      content: message.content,
      errors: [],
    });
  });
}

for (const url of [
  `${path}?threadId=3&seq=4`,
  `${path}?seq=4&threadId=3`,
  `${path}#fragment`,
  `${path.replace('/aa/', '/bb/')}`,
  `https://other.test${path}`,
])
  test(`rejects invalid stored gallery URL ${url}`, () => {
    const result = mediaContentEvidence({
      threadId: 3,
      seq: 4,
      contentType: 'GALLERY',
      content: { items: [{ url }] },
    });
    assert.equal(result.errors.length, 1);
    assert.equal(result.content.items[0].url, url);
  });

test('accepts canonical gallery URLs without mutating content', () => {
  const content = { items: [{ url: path, size: 123 }] };
  const result = mediaContentEvidence({
    threadId: 3,
    seq: 4,
    contentType: 'GALLERY',
    content,
  });
  assert.deepEqual(result, { content, errors: [] });
  assert.equal(content.items[0].url, path);
});
