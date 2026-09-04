import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messageDeleteType, peerStateEventType } from '../database/schema.js';
import { FEDERATED_MESSAGE_CONTENT_TYPES } from './federation-message-feed.service.js';
import {
  CALL_SIGNAL_TYPES,
  S2S_CALL_OPERATIONS,
} from '../calls/federated-call-protocol.js';
import {
  FEDERATION_API_PREFIX,
  FEDERATION_PROTOCOL_VERSION,
} from './federation-protocol.js';

function readSpec(name: string): string {
  return readFileSync(join(process.cwd(), 'spec', 'v1', name), 'utf8');
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
    expect(documentedUnion(readSpec('message.md'), 'ContentType')).toEqual(
      FEDERATED_MESSAGE_CONTENT_TYPES,
    );
  });

  it('lists every message tombstone type exactly once', () => {
    expect(
      documentedUnion(
        readSpec('message-tombstone-feed.md'),
        'MessageTombstoneType',
      ),
    ).toEqual(messageDeleteType.enumValues);
  });

  it('lists every call operation and signaling kind exactly once', () => {
    const spec = readSpec('calls.md');
    expect(documentedUnion(spec, 'CallOperation')).toEqual(S2S_CALL_OPERATIONS);
    expect(documentedUnion(spec, 'CallSignalType')).toEqual(CALL_SIGNAL_TYPES);
  });

  it('keeps the machine-readable enums aligned with the implementation', () => {
    const state = readSchema<{
      $defs: {
        item: {
          oneOf: Array<{ properties: { eventType: { const: string } } }>;
        };
      };
    }>('state-feed.schema.json');
    const common = readSchema<{
      $defs: {
        contentType: { enum: string[] };
      };
    }>('common.schema.json');
    const call = readSchema<{
      $defs: { signalType: { enum: string[] } };
      oneOf: Array<{
        allOf: Array<{
          properties?: { operation: { enum?: string[]; const?: string } };
        }>;
      }>;
    }>('call.schema.json');
    const tombstone = readSchema<{
      $defs: { tombstone: { properties: { type: { enum: string[] } } } };
    }>('message-tombstone-query.schema.json');

    expect(
      [
        ...new Set(
          state.$defs.item.oneOf.map((item) => item.properties.eventType.const),
        ),
      ].sort(),
    ).toEqual([...peerStateEventType.enumValues].sort());
    expect(common.$defs.contentType.enum).toEqual(
      FEDERATED_MESSAGE_CONTENT_TYPES,
    );
    expect(call.$defs.signalType.enum).toEqual(CALL_SIGNAL_TYPES);
    expect(tombstone.$defs.tombstone.properties.type.enum).toEqual(
      messageDeleteType.enumValues,
    );
    expect(
      call.oneOf
        .flatMap((branch) => {
          const operation = branch.allOf.find((part) => part.properties)
            ?.properties?.operation;
          if (!operation) return [];
          return (
            operation.enum ??
            (operation.const === undefined ? [] : [operation.const])
          );
        })
        .sort(),
    ).toEqual([...S2S_CALL_OPERATIONS].sort());
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
      'GET /.well-known/somfp',
      'POST /s2s/v1/recognize',
      'GET /s2s/v1/health',
      'POST /s2s/v1/feed-heads',
      'GET /s2s/v1/state-feed',
      'GET /s2s/v1/group-meta',
      'GET /s2s/v1/profiles/:account',
      'GET /s2s/v1/group-member-profile',
      'GET /s2s/v1/message-author-profile',
      'GET /s2s/v1/messages',
      'GET /s2s/v1/message-tombstones',
      'POST /s2s/v1/call',
      'GET /s2s/v1/accounts/:account',
      'GET /s2s/v1/media/:digest',
      'GET /s2s/v1/forward-bundles/:bundleId',
    ]);
  });
});
