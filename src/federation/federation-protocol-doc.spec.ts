import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { peerStateEventType } from '../database/schema.js';
import { FEDERATED_MESSAGE_CONTENT_TYPES } from './federation-message-feed.service.js';
import {
  CALL_SIGNAL_KINDS,
  S2S_CALL_OPS,
} from '../calls/federated-call-protocol.js';
import {
  FEDERATION_API_PREFIX,
  FEDERATION_PROTOCOL_VERSION,
} from './federation-protocol.js';

function readSpec(name: string): string {
  return readFileSync(
    join(process.cwd(), 'docs', 'federation', 'spec', 'v1', name),
    'utf8',
  );
}

function readSchema<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readSpec(join('schema', name))) as T;
}

function documentedUnion(markdown: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`type ${escaped} =([\\s\\S]*?);`).exec(
    markdown,
  )?.[1];
  if (!block) throw new Error(`missing documented ${name} union`);
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe('Federation v1 protocol documentation', () => {
  it('lists every state-feed event type exactly once', () => {
    expect(
      documentedUnion(readSpec('state-feed.md'), 'StateEventType'),
    ).toEqual(peerStateEventType.enumValues);
  });

  it('lists every message content type exactly once', () => {
    expect(documentedUnion(readSpec('message-feed.md'), 'ContentType')).toEqual(
      FEDERATED_MESSAGE_CONTENT_TYPES,
    );
  });

  it('lists every call operation and signaling kind exactly once', () => {
    const spec = readSpec('calls.md');
    expect(documentedUnion(spec, 'CallOp')).toEqual(S2S_CALL_OPS);
    expect(documentedUnion(spec, 'CallSignalKind')).toEqual(CALL_SIGNAL_KINDS);
  });

  it('keeps the machine-readable enums aligned with the implementation', () => {
    const state = readSchema<{
      $defs: {
        item: {
          oneOf: Array<{ properties: { eventType: { const: string } } }>;
        };
      };
    }>('state-feed.schema.json');
    const message = readSchema<{
      $defs: { message: { properties: { contentType: { enum: string[] } } } };
    }>('message-feed.schema.json');
    const content = readSchema<{
      properties: { contentType: { enum: string[] } };
    }>('message-content.schema.json');
    const call = readSchema<{
      $defs: { signalKind: { enum: string[] } };
      oneOf: Array<{
        allOf: Array<{
          properties?: { op: { enum?: string[]; const?: string } };
        }>;
      }>;
    }>('call.schema.json');

    expect(
      state.$defs.item.oneOf
        .map((item) => item.properties.eventType.const)
        .sort(),
    ).toEqual([...peerStateEventType.enumValues].sort());
    expect(message.$defs.message.properties.contentType.enum).toEqual(
      FEDERATED_MESSAGE_CONTENT_TYPES,
    );
    expect(content.properties.contentType.enum).toEqual(
      FEDERATED_MESSAGE_CONTENT_TYPES,
    );
    expect(call.$defs.signalKind.enum).toEqual(CALL_SIGNAL_KINDS);
    expect(
      call.oneOf
        .flatMap((branch) => {
          const op = branch.allOf.find((part) => part.properties)?.properties
            ?.op;
          if (!op) return [];
          return op.enum ?? (op.const === undefined ? [] : [op.const]);
        })
        .sort(),
    ).toEqual([...S2S_CALL_OPS].sort());
  });

  it('keeps the HTTP manifest aligned with the versioned route surface', () => {
    const manifest = readSchema<{
      majorVersion: number;
      s2sPrefix: string;
      operations: Array<{ method: string; path: string }>;
    }>('http-manifest.json');
    expect(manifest.majorVersion).toBe(FEDERATION_PROTOCOL_VERSION);
    expect(manifest.s2sPrefix).toBe(`/${FEDERATION_API_PREFIX}`);
    expect(
      manifest.operations.map(
        (operation) => `${operation.method} ${operation.path}`,
      ),
    ).toEqual([
      'GET /.well-known/soms',
      'POST /s2s/v1/recognize',
      'POST /s2s/v1/healthy',
      'POST /s2s/v1/feed-revisions',
      'GET /s2s/v1/state-feed',
      'GET /s2s/v1/message-feed',
      'POST /s2s/v1/call',
      'GET /s2s/v1/users/:account',
      'GET /s2s/v1/media/:digest',
      'GET /s2s/v1/forward-bundles/:bundleId',
    ]);
  });
});
