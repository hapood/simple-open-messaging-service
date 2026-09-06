import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaContentEvidence } from './media-content.mjs';

const path = `/uploads/msg-assets/aa/aa/${'a'.repeat(64)}`;
for (const contentType of ['FILE', 'IMAGE', 'VIDEO', 'AUDIO']) {
  test(`${contentType} compares portable content while checking each local carrier`, () => {
    const make = (threadId, seq) => ({
      threadId,
      seq,
      contentType,
      content: {
        url: `${path}?threadId=${threadId}&seq=${seq}`,
        name: 'file',
        size: 147,
        mimeType: 'image/png',
      },
    });
    const original = make(22, 2);
    const copy = make(11, 3);
    assert.deepEqual(
      mediaContentEvidence(original),
      mediaContentEvidence(copy),
    );
    assert.equal(original.content.url, `${path}?threadId=22&seq=2`);
    copy.content.url = `${path}?threadId=22&seq=2`;
    assert.equal(mediaContentEvidence(copy).errors.length, 1);
    copy.content.url = `${path}?threadId=11&seq=3`;
    copy.content.size = 148;
    assert.notDeepEqual(
      mediaContentEvidence(original).content,
      mediaContentEvidence(copy).content,
    );
  });
}
for (const url of [
  path,
  `${path}?threadId=3&seq=8`,
  `${path}?threadId=8&seq=4`,
  `${path}?threadId=3&seq=4&seq=4`,
  `${path}?threadId=3&seq=4&extra=1`,
  `${path}?threadId=03&seq=4`,
  `${path}?threadId=3&seq=4#fragment`,
  `${path.replace('/aa/', '/bb/')}?threadId=3&seq=4`,
  `https://other.test${path}?threadId=3&seq=4`,
])
  test(`rejects invalid local gallery URL ${url}`, () => {
    const result = mediaContentEvidence({
      threadId: 3,
      seq: 4,
      contentType: 'GALLERY',
      content: { items: [{ url }] },
    });
    assert.equal(result.errors.length, 1);
    assert.equal(result.content.items[0].url, url);
  });

test('accepts equivalent query parameter ordering', () => {
  const result = mediaContentEvidence({
    threadId: 3,
    seq: 4,
    contentType: 'GALLERY',
    content: { items: [{ url: `${path}?seq=4&threadId=3`, size: 123 }] },
  });
  assert.deepEqual(result, {
    content: { items: [{ url: path, size: 123 }] },
    errors: [],
  });
});
