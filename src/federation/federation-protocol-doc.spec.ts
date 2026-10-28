import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { messageDeleteType, peerStateEventType } from '../database/schema.js';
import { FEDERATED_MESSAGE_CONTENT_TYPES } from './federation-message-feed.service.js';
import {
  CALL_SIGNAL_TYPES,
  S2S_CALL_OPERATIONS,
  parseS2SCallWireFrame,
  toS2SCallWireFrame,
  type S2SCallFrame,
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
  it('requires image filenames in both standalone and gallery content', () => {
    const ajv = new Ajv2020Module.default({ strict: false });
    ajv.addSchema(readSchema('common.schema.json'));
    const validate = ajv.compile(readSchema('message-content.schema.json'));
    const image = { digest: 'a'.repeat(64), width: 1, height: 1 };
    for (const name of ['photo.png', '旅行照片.png', undefined, '', null, 1]) {
      const fields = { ...image, ...(name === undefined ? {} : { name }) };
      const expected = typeof name === 'string' && name.length > 0;
      expect(validate({ contentType: 'IMAGE', content: fields })).toBe(
        expected,
      );
      expect(
        validate({
          contentType: 'GALLERY',
          content: { items: [{ kind: 'IMAGE', ...fields }] },
        }),
      ).toBe(expected);
    }
  });

  it('requires the contact-card root key without accepting legacy missing-key forms', () => {
    const ajv = new Ajv2020Module.default({ strict: false });
    ajv.addSchema(readSchema('common.schema.json'));
    const validate = ajv.compile(readSchema('message-content.schema.json'));
    const key = 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=';
    for (const publicKey of [
      key,
      undefined,
      '',
      null,
      1,
      'not-a-key',
      key.slice(0, -1),
    ]) {
      const content = {
        account: 'alice',
        domain: 'a.example',
        displayName: 'Alice',
        bio: '',
        ...(publicKey === undefined ? {} : { publicKey }),
      };
      expect(validate({ contentType: 'CONTACT_CARD', content })).toBe(
        publicKey === key,
      );
    }
  });

  it('keeps every chapter at the final-review draft version', () => {
    const release = JSON.parse(
      readFileSync(join(process.cwd(), 'spec/RELEASE.json'), 'utf8'),
    );
    expect(release).toMatchObject({
      version: '1.0.0-draft.2',
      status: 'draft',
      reviewStage: 'final-review',
      language: 'en',
      authoritativeLanguage: 'en',
    });
    const validatorPath = join(process.cwd(), 'tools/federation-conformance');
    const validator = JSON.parse(
      readFileSync(join(validatorPath, 'package.json'), 'utf8'),
    );
    const lock = JSON.parse(
      readFileSync(join(validatorPath, 'package-lock.json'), 'utf8'),
    );
    expect(validator.version).toBe(release.version);
    expect(lock.version).toBe(release.version);
    expect(lock.packages[''].version).toBe(release.version);
    expect(
      readFileSync(join(process.cwd(), 'spec/CHANGELOG.md'), 'utf8'),
    ).toContain(`## ${release.version}`);
    for (const directory of ['', 'message', 'schema']) {
      for (const file of readdirSync(
        join(process.cwd(), 'spec/v1', directory),
      )) {
        if (!file.endsWith('.md')) continue;
        const chapter = readSpec(join(directory, file));
        if (!chapter.includes('Status:')) continue;
        expect(chapter).toContain('`DRAFT` — Final Review');
        expect(chapter).toContain(`v${release.version}`);
        expect(chapter).not.toContain('Status: `RELEASE CANDIDATE`');
      }
    }
  });

  it('keeps the normative HTTP surface equal to the manifest and actual controllers', () => {
    const manifest = readSchema<{
      operations: Array<{ method: string; path: string }>;
    }>('http-manifest.json');
    const declared = manifest.operations
      .map(({ method, path }) => `${method} ${path}`)
      .sort();
    const documented = [
      ...readSpec('protocol.md').matchAll(/^\| `(GET|POST)`\s*\| `([^`]+)`/gm),
    ]
      .map((match) => `${match[1]} ${match[2]}`)
      .sort();
    expect(documented).toEqual(declared);
    const implemented: string[] = [];
    for (const file of [
      's2s.controller.ts',
      's2s-recognition.controller.ts',
      's2s-verify.controller.ts',
      'well-known.controller.ts',
    ]) {
      const source = readFileSync(
        join(process.cwd(), 'src/federation', file),
        'utf8',
      );
      for (const match of source.matchAll(
        /@(Get|Post)\(\s*'([^']+)'\s*,?\s*\)/g,
      )) {
        const path =
          file === 'well-known.controller.ts'
            ? `/.well-known/${match[2]}`
            : `/${FEDERATION_API_PREFIX}/${match[2]}`;
        implemented.push(`${match[1].toUpperCase()} ${path}`);
      }
    }
    expect(implemented.sort()).toEqual(declared);
  });

  it('validates quoted message digest presence in both directions', () => {
    const ajv = new Ajv2020Module.default({ strict: false });
    ajv.addSchema(readSchema('common.schema.json'));
    ajv.addSchema(readSchema('message-query.schema.json'));
    const validate = ajv.getSchema(
      'urn:somfp:v1:message-query#/$defs/message',
    )!;
    const message = {
      thread: { account: 'alice', peerAccount: 'bob' },
      author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
      seq: 1,
      profileRev: 1,
      originSeq: null,
      originCreatedAt: null,
      createdAt: 0,
      contentType: 'PURE_TEXT',
      content: '{"text":"hello"}',
      assets: [],
    };
    expect(validate(message)).toBe(true);
    expect(validate({ ...message, quoteTarget: { seq: 0 } })).toBe(false);
    expect(validate({ ...message, quoteDigest: 'a'.repeat(64) })).toBe(false);
    expect(
      validate({
        ...message,
        quoteTarget: { seq: 8 },
        quoteDigest: 'a'.repeat(64),
      }),
    ).toBe(true);
    for (const quoteTarget of [{ seq: 0 }, { originSeq: 0 }]) {
      expect(
        validate({ ...message, quoteTarget, quoteDigest: 'a'.repeat(64) }),
      ).toBe(false);
    }
  });

  it('validates namespace-only message authors and rejects legacy or mixed shapes', () => {
    const ajv = new Ajv2020Module.default({ strict: false });
    ajv.addSchema(readSchema('common.schema.json'));
    ajv.addSchema(readSchema('message-query.schema.json'));
    const validate = ajv.getSchema(
      'urn:somfp:v1:message-query#/$defs/message',
    )!;
    const base = {
      seq: 1,
      profileRev: 1,
      originSeq: null,
      originCreatedAt: null,
      createdAt: 0,
      contentType: 'PURE_TEXT',
      content: '{"text":"hello"}',
      assets: [],
    };
    const p2p = {
      ...base,
      thread: { account: 'alice', peerAccount: 'bob' },
      author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
    };
    const group = {
      ...base,
      thread: { account: '!team' },
      author: { account: 'alice', namespaceId: 7 },
    };
    expect(validate(p2p)).toBe(true);
    expect(
      validate({
        ...p2p,
        author: { ref: 'THREAD_PEER_ACCOUNT', namespaceId: 12 },
      }),
    ).toBe(true);
    expect(validate(group)).toBe(true);
    for (const message of [p2p, group]) {
      expect(validate({ ...message, namespaceId: 0 })).toBe(false);
      expect(validate({ ...message, authorRef: 'THREAD_ACCOUNT' })).toBe(false);
      expect(
        validate({
          ...message,
          author: { ...message.author, domain: 'a.example' },
        }),
      ).toBe(false);
      expect(validate({ ...message, author: { namespaceId: 0 } })).toBe(false);
    }
    expect(validate({ ...p2p, author: group.author })).toBe(false);
    expect(validate({ ...group, author: p2p.author })).toBe(false);
    expect(
      validate({ ...p2p, author: { ...p2p.author, account: 'alice' } }),
    ).toBe(false);
    expect(validate({ ...group, author: { account: 'alice' } })).toBe(false);
  });

  it('keeps every Group Meta subject in its operation body', () => {
    const ajv = new Ajv2020Module.default({ strict: false });
    ajv.addSchema(readSchema('common.schema.json'));
    ajv.addSchema(readSchema('group-meta.schema.json'));
    const validate = ajv.getSchema('urn:somfp:v1:group-meta#/$defs/item')!;
    const member = {
      account: 'alice',
      namespaceId: 7,
      role: 'MEMBER',
      profileRev: 2,
    };
    for (const [operation, body] of [
      ['MEMBER_UPSERT', member],
      ['MEMBER_DEPART', member],
      ['GROUP_PROFILE', { account: '!team', namespaceId: 0, profileRev: 3 }],
      ['GROUP_ANNOUNCEMENT', { text: null }],
    ] as const) {
      const item = {
        feedId: 1,
        originCreatedAt: 0,
        operation,
        body,
      };
      expect(validate(item)).toBe(true);
      const { originCreatedAt: _originCreatedAt, ...withoutOriginCreatedAt } =
        item;
      expect(validate(withoutOriginCreatedAt)).toBe(false);
      for (const originCreatedAt of [
        null,
        -1,
        0.5,
        '0',
        Number.MAX_SAFE_INTEGER + 1,
      ])
        expect(validate({ ...item, originCreatedAt })).toBe(false);
      for (const createdAt of [null, 0, '0', false])
        expect(validate({ ...item, createdAt })).toBe(false);
      expect(validate({ ...item, account: 'alice' })).toBe(false);
      expect(validate({ ...item, domain: 'a.example' })).toBe(false);
      expect(
        validate({ ...item, body: { ...body, domain: 'a.example' } }),
      ).toBe(false);
      if ('account' in body) {
        const { account: _account, ...withoutAccount } = body;
        expect(validate({ ...item, body: withoutAccount })).toBe(false);
      }
    }
  });

  it('rejects domain in public and exact profile responses', () => {
    const ajv = new Ajv2020Module.default({ strict: false });
    ajv.addSchema(readSchema('common.schema.json'));
    for (const name of ['profile', 'evidence-profile']) {
      const validate = ajv.compile(readSchema(`${name}.schema.json`));
      const content = { displayName: 'Alice', bio: '', avatar: null };
      const profile =
        name === 'profile'
          ? {
              account: 'alice',
              profileRev: 1,
              generatedAt: 1_700_000_000_000,
              profile: content,
              proof: 'Y2hhbGxlbmdl',
            }
          : { account: 'alice', generatedAt: 1_700_000_000_000, ...content };
      expect(validate(profile)).toBe(true);
      for (const generatedAt of [
        undefined,
        null,
        -1,
        0.5,
        '1',
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const invalid: Record<string, unknown> = { ...profile, generatedAt };
        if (generatedAt === undefined) delete invalid.generatedAt;
        expect(validate(invalid)).toBe(false);
      }
      for (const generatedAt of [0, 1, Number.MAX_SAFE_INTEGER]) {
        expect(validate({ ...profile, generatedAt })).toBe(true);
      }
      expect(validate({ ...profile, domain: 'a.example' })).toBe(false);
    }
  });

  it('validates the revision/nullness contract and rejects flattened public profiles', () => {
    const ajv = new Ajv2020Module.default({ strict: false });
    ajv.addSchema(readSchema('common.schema.json'));
    const validate = ajv.compile(readSchema('profile.schema.json'));
    const empty = {
      account: 'alice',
      profileRev: 0,
      generatedAt: 0,
      profile: null,
      proof: 'Y2hhbGxlbmdl',
    };
    const content = { displayName: 'Alice', bio: '', avatar: null };
    expect(validate(empty)).toBe(true);
    expect(validate({ ...empty, generatedAt: 1 })).toBe(false);
    expect(validate({ ...empty, profileRev: 1 })).toBe(false);
    expect(validate({ ...empty, profile: content })).toBe(false);
    expect(validate({ ...empty, profileRev: 1, profile: content })).toBe(true);
    expect(
      validate({
        ...empty,
        profileRev: 1,
        profile: { ...content, extra: true },
      }),
    ).toBe(false);
    expect(
      validate({
        account: 'alice',
        profileRev: 1,
        proof: empty.proof,
        ...content,
      }),
    ).toBe(false);
  });

  it('validates closed provenance batches and result states', () => {
    const ajv = new Ajv2020Module.default({ strict: false });
    ajv.addSchema(readSchema('common.schema.json'));
    ajv.addSchema(readSchema('message-provenance.schema.json'));
    const request = ajv.getSchema(
      'urn:somfp:v1:message-provenance#/$defs/request',
    )!;
    const response = ajv.getSchema(
      'urn:somfp:v1:message-provenance#/$defs/response',
    )!;
    const coordinate = {
      thread: { account: 'alice', peerAccount: 'bob' },
      seq: 1,
    };
    const query = { ...coordinate, payloadDigest: 'a'.repeat(64) };
    expect(request({ queries: [query] })).toBe(true);
    expect(request({ queries: [] })).toBe(false);
    expect(request({ queries: Array(65).fill(query) })).toBe(false);
    expect(request({ queries: [{ ...query, extra: true }] })).toBe(false);
    for (const known of ['yes', 'no', 'declined']) {
      expect(response({ results: [{ ...coordinate, known }] })).toBe(true);
    }
    expect(response({ results: [{ ...coordinate, known: 'unknown' }] })).toBe(
      false,
    );
  });
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

  it('round-trips every call operation through the published wire schema', () => {
    const ajv = new Ajv2020Module.default({ strict: false });
    ajv.addSchema(readSchema('common.schema.json'));
    const validate = ajv.compile(readSchema('call.schema.json'));
    const callSid = '550e8400-e29b-41d4-a716-446655440000';
    const frames: S2SCallFrame[] = [
      {
        callSid,
        op: 'incoming',
        callType: 'AUDIO',
        payload: { fromAccount: 'alice', toAccount: 'bob' },
      },
      ...(
        [
          'accepted',
          'ringing',
          'declined',
          'cancelled',
          'missed',
          'video-upgraded',
        ] as const
      ).map((op) => ({ callSid, op })),
      {
        callSid,
        op: 'signal',
        payload: { signalId: callSid, signalType: 'offer', data: 'v=0' },
      },
      { callSid, op: 'connected' },
      { callSid, op: 'ended', payload: { endReason: 'completed' } },
    ];
    expect(frames.map((frame) => frame.op).sort()).toEqual(
      [...S2S_CALL_OPERATIONS].sort(),
    );
    for (const frame of frames) {
      const wire = toS2SCallWireFrame(frame);
      expect(validate(wire), JSON.stringify(validate.errors)).toBe(true);
      expect(parseS2SCallWireFrame(wire)).toEqual(frame);
      const withInternalDeadline = { ...wire, createUntil: 1_700_000_300_000 };
      expect(validate(withInternalDeadline)).toBe(false);
      expect(() => parseS2SCallWireFrame(withInternalDeadline)).toThrow();
    }
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
      'POST /s2s/v1/verify',
      'POST /s2s/v1/feed-heads',
      'GET /s2s/v1/state-feed',
      'GET /s2s/v1/profile-namespace-feed',
      'GET /s2s/v1/profile-namespaces/:nsid',
      'GET /s2s/v1/group-meta',
      'GET /s2s/v1/account-profiles/:namespaceId/:account/:profileRev',
      'GET /s2s/v1/group-member-profiles/:groupAccount/:namespaceId/:memberAccount/:profileRev',
      'GET /s2s/v1/messages',
      'GET /s2s/v1/message-tombstones',
      'POST /s2s/v1/message-provenance',
      'POST /s2s/v1/call',
      'GET /s2s/v1/accounts/:account',
      'GET /s2s/v1/media/:digest',
      'GET /s2s/v1/forward-bundles/:bundleId',
    ]);
  });
});
