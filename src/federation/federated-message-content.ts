import { ContentType } from '../database/enums.js';
import { canonicalJson, payloadDigest } from './canonical-json.js';
import { isAbsoluteLinkTarget } from '../message/link-target.js';
import { extractDigests, MAX_FILE_NAME_LEN } from '../upload/file-content.js';
import {
  isValidAccount,
  isValidSomfpDomain,
  isValidSomfpUserAccount,
  parseSomfpUserMentionEntity,
} from '../common/account.js';
import { parseMessageEntities } from '../common/message-entity.js';
import {
  hasUnpairedSurrogate,
  unicodeCodePointLength,
} from '../../shared/text-message-content.js';

const SHA256_RE = /^[a-f0-9]{64}$/;

type JsonObject = Record<string, unknown>;

function parseObject(content: string): JsonObject {
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('message content must be a JSON object');
  }
  return value as JsonObject;
}

function assertKeys(
  value: JsonObject,
  required: string[],
  optional: string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error('message content has invalid fields');
  }
}

function digestFromUrl(url: unknown): string {
  if (typeof url !== 'string') throw new Error('media URL is missing');
  const digests = extractDigests(JSON.stringify({ url }));
  if (digests.length !== 1) throw new Error('media URL is not a local CAS URL');
  return digests[0];
}

function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error('invalid media digest');
  }
}

function assertSafeInteger(
  value: unknown,
  positive = false,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (positive ? Number(value) < 1 : Number(value) < 0)
  ) {
    throw new Error('invalid safe integer');
  }
}

function assertPositiveFinite(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('invalid positive number');
  }
}

function assertNonEmptyString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('invalid non-empty string');
  }
}

function validateContactCard(value: JsonObject): void {
  assertKeys(
    value,
    ['account', 'domain', 'displayName', 'bio'],
    ['avatar', 'avatarDigest', 'quote'],
  );
  const account = value['account'];
  if (
    typeof account !== 'string' ||
    !isValidAccount(account) ||
    typeof value['domain'] !== 'string' ||
    !isValidSomfpDomain(value['domain']) ||
    typeof value['displayName'] !== 'string' ||
    unicodeCodePointLength(value['displayName']) < 1 ||
    unicodeCodePointLength(value['displayName']) > 31 ||
    hasUnpairedSurrogate(value['displayName'])
  ) {
    throw new Error('invalid contact card');
  }
  if (
    typeof value['bio'] !== 'string' ||
    unicodeCodePointLength(value['bio']) > 120 ||
    hasUnpairedSurrogate(value['bio'])
  )
    throw new Error('invalid contact card');
}

function validateSingleFields(value: JsonObject, extra: string[]): void {
  if (extra.includes('name')) assertNonEmptyString(value['name']);
  if (extra.includes('mimeType')) assertNonEmptyString(value['mimeType']);
  if (extra.includes('w')) assertSafeInteger(value['w'], true);
  if (extra.includes('h')) assertSafeInteger(value['h'], true);
  if (extra.includes('width')) assertSafeInteger(value['width'], true);
  if (extra.includes('height')) assertSafeInteger(value['height'], true);
  if (extra.includes('duration')) assertPositiveFinite(value['duration']);
}

function validateImageName(value: JsonObject): void {
  assertNonEmptyString(value['name']);
  if (
    value['name'].length > MAX_FILE_NAME_LEN ||
    hasUnpairedSurrogate(value['name'])
  )
    throw new Error('invalid image filename');
}

function validateForwardCard(value: JsonObject): void {
  assertKeys(value, ['bundleId']);
  if (
    typeof value['bundleId'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['bundleId'])
  ) {
    throw new Error('invalid forward card');
  }
}

function parseQuote(value: JsonObject, strict = false): JsonObject | undefined {
  if (value['quote'] === undefined) return undefined;
  if (
    !value['quote'] ||
    typeof value['quote'] !== 'object' ||
    Array.isArray(value['quote'])
  ) {
    throw new Error('invalid quote');
  }
  const quote = value['quote'] as JsonObject;
  assertKeys(
    quote,
    strict ? ['seq', 'digest'] : ['seq'],
    strict
      ? []
      : [
          'digest',
          'namespaceId',
          'sourceSeq',
          'status',
          'author',
          'body',
          'contentType',
          'image',
          'imageLabel',
          'imageIdentity',
          'imageSize',
          'imageShape',
        ],
  );
  if (
    !Number.isSafeInteger(quote['seq']) ||
    Number(quote['seq']) < 0 ||
    (quote['digest'] !== undefined &&
      (typeof quote['digest'] !== 'string' ||
        !/^[a-f0-9]{64}$/.test(quote['digest'])))
  ) {
    throw new Error('invalid quote');
  }
  if (strict) return { seq: quote['seq'], digest: quote['digest'] };
  return quote;
}

function projectTextContent(
  value: JsonObject,
  strictQuote = false,
): JsonObject {
  assertKeys(value, ['text'], strictQuote ? [] : ['quote']);
  if (typeof value['text'] !== 'string' || value['text'].length === 0)
    throw new Error('invalid text');
  for (const segment of parseMessageEntities(value['text'])) {
    if (segment.kind !== 'entity' || segment.entityType !== 'user') continue;
    if (!parseSomfpUserMentionEntity(segment.entityId)) {
      throw new Error(
        'federated user mention must use a valid namespace/account entity',
      );
    }
  }
  const text = value['text'];
  if (value['quote'] !== undefined) parseQuote(value, strictQuote);
  return { text };
}

function localCasUrl(digest: string): string {
  return `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
}

function projectSingleToWire(
  value: JsonObject,
  extra: string[],
  optional: string[] = [],
): JsonObject {
  assertKeys(value, ['url', 'size', ...extra], [...optional, 'quote']);
  parseQuote(value);
  assertSafeInteger(value['size']);
  validateSingleFields(value, [
    ...extra,
    ...optional.filter((key) => value[key] !== undefined),
  ]);
  return {
    ...value,
    digest: digestFromUrl(value['url']),
    url: undefined,
    size: undefined,
    quote: undefined,
    ...(extra.includes('w') ? { width: value['w'], w: undefined } : {}),
    ...(extra.includes('h') ? { height: value['h'], h: undefined } : {}),
  };
}

function withoutUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

/** Project the existing client/local Message.content shape onto the URL-free Federation v1 shape. */
export function toFederatedMessageContent(
  contentType: ContentType,
  content: string,
): string {
  if (!Object.values(ContentType).includes(contentType))
    throw new Error('unknown federated content type');
  const value = parseObject(content);
  switch (contentType) {
    case ContentType.PURE_TEXT:
      return canonicalJson(projectTextContent(value, false));
    case ContentType.IMAGE:
      validateImageName(value);
      return canonicalJson(
        withoutUndefined(projectSingleToWire(value, ['w', 'h', 'name'])),
      );
    case ContentType.FILE:
      return canonicalJson(
        withoutUndefined(projectSingleToWire(value, ['name', 'mimeType'])),
      );
    case ContentType.VIDEO:
      return canonicalJson(
        withoutUndefined(
          projectSingleToWire(value, [
            'name',
            'mimeType',
            'w',
            'h',
            'duration',
          ]),
        ),
      );
    case ContentType.AUDIO:
      return canonicalJson(
        withoutUndefined(
          projectSingleToWire(value, ['name', 'mimeType', 'duration']),
        ),
      );
    case ContentType.GALLERY: {
      assertKeys(value, ['items'], ['quote']);
      parseQuote(value);
      if (!Array.isArray(value['items']) || value['items'].length === 0) {
        throw new Error('gallery items are missing');
      }
      const items = value['items'].map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error('invalid gallery item');
        }
        const record = item as JsonObject;
        const kind = record['kind'];
        const fields =
          kind === 'IMAGE'
            ? ['name', 'w', 'h']
            : kind === 'VIDEO'
              ? ['name', 'mimeType', 'w', 'h', 'duration']
              : kind === 'AUDIO'
                ? ['name', 'mimeType', 'duration']
                : kind === 'FILE'
                  ? ['name', 'mimeType']
                  : null;
        if (!fields) throw new Error('invalid gallery kind');
        return withoutUndefined({
          kind,
          ...projectSingleToWire(record, ['kind', ...fields]),
        });
      });
      return canonicalJson({ items });
    }
    case ContentType.LINK: {
      assertKeys(
        value,
        ['url', 'title', 'description'],
        ['siteName', 'image', 'favicon', 'quote'],
      );
      parseQuote(value);
      if (
        !isAbsoluteLinkTarget(value['url']) ||
        typeof value['title'] !== 'string' ||
        typeof value['description'] !== 'string' ||
        (value['siteName'] !== undefined &&
          typeof value['siteName'] !== 'string')
      ) {
        throw new Error('invalid link content');
      }
      return canonicalJson({
        url: value['url'],
        title: value['title'],
        description: value['description'],
        ...(value['siteName'] === undefined
          ? {}
          : { siteName: value['siteName'] }),
        ...(value['image'] === undefined
          ? {}
          : { icon: digestFromUrl(value['image']) }),
        ...(value['favicon'] === undefined
          ? {}
          : { favicon: digestFromUrl(value['favicon']) }),
      });
    }
    case ContentType.CONTACT_CARD:
      validateContactCard(value);
      parseQuote(value);
      if (value['avatarDigest'] !== undefined) {
        throw new Error('local contact card must not contain avatarDigest');
      }
      return canonicalJson({
        account: value['account'],
        domain: value['domain'],
        displayName: value['displayName'],
        bio: value['bio'],
        ...(value['avatar'] === undefined
          ? {}
          : { avatarDigest: digestFromUrl(value['avatar']) }),
      });
    case ContentType.FORWARD:
      // Imported cards use the URL-free wire shape. Local cards additionally carry the fields used
      // by the chat renderer; both forms publish to the same minimal wire reference.
      if (
        Object.keys(value).filter((key) => key !== 'quote').length === 1
      ) {
        assertKeys(value, ['bundleId'], ['quote']);
        parseQuote(value);
      } else {
        assertKeys(
          value,
          ['bundleId', 'summaryLines', 'messageCount', 'depth'],
          ['quote'],
        );
        parseQuote(value);
        if (
          !Array.isArray(value['summaryLines']) ||
          !value['summaryLines'].every((line) => typeof line === 'string') ||
          !Number.isSafeInteger(value['messageCount']) ||
          Number(value['messageCount']) < 0 ||
          !Number.isSafeInteger(value['depth']) ||
          Number(value['depth']) < 1 ||
          Number(value['depth']) > 3
        ) {
          throw new Error('invalid forward card');
        }
      }
      if (typeof value['bundleId'] !== 'string')
        throw new Error('invalid forward card');
      validateForwardCard({ bundleId: value['bundleId'] });
      return canonicalJson({ bundleId: value['bundleId'] });
    case ContentType.SYSTEM:
      throw new Error('SYSTEM is not a federated content type');
    default:
      return content;
  }
}

/** Validate Federation v1 digest content and project it back to the existing local client shape. */
export function fromFederatedMessageContent(
  contentType: ContentType,
  content: string,
  assetBytes: ReadonlyMap<string, number> = new Map(),
): string {
  if (!Object.values(ContentType).includes(contentType))
    throw new Error('unknown federated content type');
  const value = parseObject(content);
  const single = (extra: string[], optional: string[] = []): string => {
    assertKeys(value, ['digest', ...extra], optional);
    assertDigest(value['digest']);
    validateSingleFields(value, [
      ...extra,
      ...optional.filter((key) => value[key] !== undefined),
    ]);
    const size = assetBytes.get(value['digest']);
    assertSafeInteger(size);
    return canonicalJson(
      withoutUndefined({
        ...value,
        url: localCasUrl(value['digest']),
        digest: undefined,
        size,
        ...(extra.includes('width')
          ? { w: value['width'], width: undefined }
          : {}),
        ...(extra.includes('height')
          ? { h: value['height'], height: undefined }
          : {}),
      }),
    );
  };
  switch (contentType) {
    case ContentType.PURE_TEXT:
      return canonicalJson(projectTextContent(value, true));
    case ContentType.IMAGE:
      validateImageName(value);
      return single(['width', 'height', 'name']);
    case ContentType.FILE:
      return single(['name', 'mimeType']);
    case ContentType.VIDEO:
      return single(['name', 'mimeType', 'width', 'height', 'duration']);
    case ContentType.AUDIO:
      return single(['name', 'mimeType', 'duration']);
    case ContentType.GALLERY: {
      assertKeys(value, ['items']);
      if (!Array.isArray(value['items']) || value['items'].length === 0) {
        throw new Error('gallery items are missing');
      }
      const items = value['items'].map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error('invalid gallery item');
        }
        const record = item as JsonObject;
        const kind = record['kind'];
        const fields =
          kind === 'IMAGE'
            ? ['name', 'width', 'height']
            : kind === 'VIDEO'
              ? ['name', 'mimeType', 'width', 'height', 'duration']
              : kind === 'AUDIO'
                ? ['name', 'mimeType', 'duration']
                : kind === 'FILE'
                  ? ['name', 'mimeType']
                  : null;
        if (!fields) throw new Error('invalid gallery kind');
        assertKeys(record, ['kind', 'digest', ...fields]);
        assertDigest(record['digest']);
        validateSingleFields(record, fields);
        const size = assetBytes.get(record['digest']);
        assertSafeInteger(size);
        return withoutUndefined({
          ...record,
          url: localCasUrl(record['digest']),
          digest: undefined,
          size,
          ...(fields.includes('width')
            ? { w: record['width'], width: undefined }
            : {}),
          ...(fields.includes('height')
            ? { h: record['height'], height: undefined }
            : {}),
        });
      });
      return canonicalJson({ items });
    }
    case ContentType.LINK:
      assertKeys(
        value,
        ['url', 'title', 'description'],
        ['siteName', 'icon', 'favicon'],
      );
      if (value['icon'] !== undefined) assertDigest(value['icon']);
      if (value['favicon'] !== undefined) assertDigest(value['favicon']);
      if (
        !isAbsoluteLinkTarget(value['url']) ||
        typeof value['title'] !== 'string' ||
        typeof value['description'] !== 'string' ||
        (value['siteName'] !== undefined &&
          typeof value['siteName'] !== 'string')
      ) {
        throw new Error('invalid link content');
      }
      return canonicalJson({
        url: value['url'],
        title: value['title'],
        description: value['description'],
        ...(value['siteName'] === undefined
          ? {}
          : { siteName: value['siteName'] }),
        ...(value['icon'] === undefined
          ? {}
          : { image: localCasUrl(value['icon']) }),
        ...(value['favicon'] === undefined
          ? {}
          : { favicon: localCasUrl(value['favicon']) }),
      });
    case ContentType.CONTACT_CARD:
      validateContactCard(value);
      parseQuote(value);
      if (value['avatar'] !== undefined) {
        throw new Error('federated contact card must not contain avatar');
      }
      if (value['avatarDigest'] !== undefined)
        assertDigest(value['avatarDigest']);
      return canonicalJson({
        account: value['account'],
        domain: value['domain'],
        displayName: value['displayName'],
        bio: value['bio'],
        ...(value['avatarDigest'] === undefined
          ? {}
          : { avatar: localCasUrl(value['avatarDigest']) }),
      });
    case ContentType.FORWARD:
      validateForwardCard(value);
      return content;
    case ContentType.SYSTEM:
      throw new Error('SYSTEM is not a federated content type');
    default:
      return content;
  }
}

/** Digests referenced directly by a URL-free Federation v1 content object. */
export function federatedContentDigests(
  contentType: ContentType,
  content: string,
): string[] {
  const value = parseObject(content);
  const result: unknown[] = [];
  if (
    contentType === ContentType.IMAGE ||
    contentType === ContentType.FILE ||
    contentType === ContentType.VIDEO ||
    contentType === ContentType.AUDIO
  ) {
    result.push(value['digest']);
  } else if (
    contentType === ContentType.GALLERY &&
    Array.isArray(value['items'])
  ) {
    result.push(
      ...value['items'].map((item) => (item as JsonObject)['digest']),
    );
  } else if (contentType === ContentType.LINK) {
    if (value['icon'] !== undefined) result.push(value['icon']);
    if (value['favicon'] !== undefined) result.push(value['favicon']);
  } else if (contentType === ContentType.CONTACT_CARD) {
    if (value['avatarDigest'] !== undefined) result.push(value['avatarDigest']);
  }
  const digests = new Set<string>();
  for (const digest of result) {
    assertDigest(digest);
    digests.add(digest);
  }
  return [...digests];
}

/**
 * The hop-independent content digest of a message, computed over the canonical (JCS) form of the
 * Federation v1 wire `content` for the given `(contentType, content)`. This is the digest a peer
 * computes over the wire it receives, so a publisher stores it at creation time and compares it
 * against the digest carried by a later processing receipt to confirm the content was not altered
 * in transit. It is also the digest a provenance query (`POST /s2s/v1/message-provenance`) supplies.
 *
 * The input `content` is the local stored form; it is projected to the wire form via
 * `toFederatedMessageContent` before hashing, so the digest is independent of the local storage
 * field names and matches what every peer computes over the wire.
 */
export function wirePayloadDigest(
  contentType: ContentType,
  content: string,
  assets: ReadonlyArray<{ digest: string; bytes: number }> = [],
  quoteDigest?: string,
): string {
  return payloadDigest(
    toFederatedMessageContent(contentType, content),
    assets,
    quoteDigest,
  );
}
