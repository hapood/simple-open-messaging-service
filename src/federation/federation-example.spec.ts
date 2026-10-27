import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { canonicalContentString, canonicalJson } from './canonical-json.js';

const read = (name: string) => readFileSync(`spec/v1/${name}`, 'utf8');
const publicKey = Buffer.from(
  'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=',
  'base64',
);

describe('published request and message examples', () => {
  for (const chapter of ['transport-security.md', 'calls.md', 'resources.md']) {
    it(`reproduces every signed request in ${chapter}`, () => {
      const blocks = [...read(chapter).matchAll(/```http\n([\s\S]*?)```/g)]
        .map((match) => match[1].trimEnd())
        .filter((block) => block.includes('Signature-Input:'));
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const [head, body = ''] = block.split('\n\n');
        const [line, ...lines] = head.split('\n');
        const [method, target] = line.split(' ');
        const headers = Object.fromEntries(
          lines.map((header) => {
            const colon = header.indexOf(':');
            return [
              header.slice(0, colon).toLowerCase(),
              header.slice(colon + 1).trim(),
            ];
          }),
        );
        expect(headers['s2s-root-key']).toBe(publicKey.toString('base64'));
        expect(headers['content-digest']).toBe(
          `sha-256=:${createHash('sha256').update(body).digest('base64')}:`,
        );
        const question = target.indexOf('?');
        const path = question < 0 ? target : target.slice(0, question);
        const query = question < 0 ? '?' : target.slice(question);
        const base = [
          `"@method": ${method}`,
          `"@path": ${path}`,
          `"@query": ${query}`,
          `"@authority": ${headers.host}`,
          `"date": ${headers.date}`,
          `"content-digest": ${headers['content-digest']}`,
          `"@signature-params": ${headers['signature-input'].slice(5)}`,
        ].join('\n');
        expect(
          ed25519.verify(
            Buffer.from(headers.signature.slice(6, -1), 'base64'),
            Buffer.from(base),
            publicKey,
          ),
        ).toBe(true);
        if (path === '/s2s/v1/feed-heads') {
          expect(Object.keys(JSON.parse(body)).sort()).toEqual([
            'generatedAt',
            'profileNamespaceFeedEndId',
            'stateFeedEndId',
          ]);
        }
      }
    });
  }

  it('computes each published forward-bundle example digest from its canonical body', () => {
    for (const chapter of ['message/forward.md', 'resources.md']) {
      for (const match of read(chapter).matchAll(/```json\n([\s\S]*?)```/g)) {
        const value = JSON.parse(match[1]);
        if (!('messages' in value) || !('id' in value)) continue;
        const body = {
          messages: value.messages,
          children: value.messages
            .map((message: unknown) =>
              message !== null &&
              typeof message === 'object' &&
              'childBundleId' in message
                ? message.childBundleId
                : undefined,
            )
            .filter((id: unknown): id is string => typeof id === 'string')
            .sort(),
          assets: value.assets ?? [],
        };
        expect(value.id).toBe(
          createHash('sha256').update(canonicalJson(body)).digest('hex'),
        );
      }
    }
  });

  it('uses producer-canonical embedded content and valid self-author receipt coordinates', () => {
    let messages = 0;
    function check(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      const row = value as Record<string, any>;
      if (
        typeof row.content === 'string' &&
        typeof row.contentType === 'string'
      ) {
        messages++;
        expect(row.content).toBe(canonicalContentString(row.content));
        if (row.author?.ref === 'THREAD_PEER_ACCOUNT') {
          expect(row.originSeq).toBeGreaterThan(0);
          expect(row.originCreatedAt).toBeTypeOf('number');
        }
      }
      for (const child of Object.values(row)) check(child);
    }
    for (const chapter of [
      'message/text.md',
      'message/media.md',
      'message/contact-card.md',
      'message/link.md',
      'message/forward.md',
      'resources.md',
    ]) {
      for (const match of read(chapter).matchAll(/```json\n([\s\S]*?)```/g)) {
        check(JSON.parse(match[1]));
      }
    }
    expect(messages).toBeGreaterThan(5);
  });
});
