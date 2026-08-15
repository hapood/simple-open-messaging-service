import { ContentType } from '../database/enums.js';
import { extractDigests } from '../upload/file-content.js';
import { isValidGroupAccount, isValidUserAccount } from '../common/account.js';
import { parseFederatedCallContent } from '../calls/call-content.js';
import {
  parseMessageEntities,
  serializeUserMention,
  transformMessageEntities,
} from '../common/message-entity.js';

const SHA256_RE = /^[a-f0-9]{64}$/;

type JsonObject = Record<string, unknown>;

export interface FederationAuthoredMessageSnapshot {
  contentType: string;
  content: string;
  clientMessageId: string | null;
  quoteTarget?: {
    targetSeq: number;
  };
  assets: Array<{
    digest: string;
    bytes: number;
  }>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as JsonObject;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function canonicalizeMessageContent(content: string): string {
  return canonicalJson(parseObject(content));
}

export function authoredMessageSnapshot(
  value: Pick<
    FederationAuthoredMessageSnapshot,
    'contentType' | 'content' | 'clientMessageId' | 'quoteTarget' | 'assets'
  >,
): FederationAuthoredMessageSnapshot {
  return {
    contentType: value.contentType,
    content: canonicalizeMessageContent(value.content),
    clientMessageId: value.clientMessageId,
    ...(value.quoteTarget === undefined
      ? {}
      : { quoteTarget: value.quoteTarget }),
    assets: [...value.assets].sort((a, b) => a.digest.localeCompare(b.digest)),
  };
}

export function authoredMessageSnapshotsEqual(
  left: FederationAuthoredMessageSnapshot,
  right: FederationAuthoredMessageSnapshot,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

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

function validateSingleFields(value: JsonObject, extra: string[]): void {
  assertSafeInteger(value['size']);
  if (extra.includes('name')) assertNonEmptyString(value['name']);
  if (extra.includes('mimeType')) assertNonEmptyString(value['mimeType']);
  if (extra.includes('w')) assertSafeInteger(value['w'], true);
  if (extra.includes('h')) assertSafeInteger(value['h'], true);
  if (extra.includes('duration')) assertPositiveFinite(value['duration']);
}

function validateForwardCard(value: JsonObject): void {
  assertKeys(value, ['bundleId']);
  if (
    typeof value['bundleId'] !== 'string' ||
    Buffer.byteLength(value['bundleId'], 'utf8') < 1 ||
    Buffer.byteLength(value['bundleId'], 'utf8') > 26 ||
    value['bundleId'].includes('/') ||
    value['bundleId'].includes('\0')
  ) {
    throw new Error('invalid forward card');
  }
}

function projectTextContent(
  value: JsonObject,
  strictQuote = false,
  domainMapping?: { from: string; to: string },
): JsonObject {
  assertKeys(value, ['text'], strictQuote ? [] : ['quote']);
  if (typeof value['text'] !== 'string' || value['text'].length === 0)
    throw new Error('invalid text');
  for (const segment of parseMessageEntities(value['text'])) {
    if (
      segment.kind === 'entity' &&
      segment.entityType === 'user' &&
      !segment.entityId.includes('@')
    ) {
      throw new Error('federated user mention must use a full address');
    }
  }
  const text = domainMapping
    ? transformMessageEntities(value['text'], (entity) => {
        if (entity.entityType !== 'user') return entity.raw;
        const separator = entity.entityId.lastIndexOf('@');
        const account = entity.entityId.slice(0, separator);
        const domain = entity.entityId.slice(separator + 1);
        return domain === domainMapping.from
          ? serializeUserMention(entity.label, `${account}@${domainMapping.to}`)
          : entity.raw;
      })
    : value['text'];
  if (value['quote'] === undefined) return { text };
  if (
    !value['quote'] ||
    typeof value['quote'] !== 'object' ||
    Array.isArray(value['quote'])
  ) {
    throw new Error('invalid quote');
  }
  const quote = value['quote'] as JsonObject;
  const allowed = ['seq', 'author', 'body', 'contentType'];
  if (
    !('seq' in quote) ||
    (strictQuote && Object.keys(quote).some((key) => !allowed.includes(key)))
  ) {
    throw new Error('invalid quote');
  }
  assertSafeInteger(quote['seq']);
  for (const field of allowed.slice(1)) {
    if (quote[field] !== undefined && typeof quote[field] !== 'string') {
      throw new Error('invalid quote preview');
    }
  }
  return { text };
}

function localCasUrl(digest: string): string {
  return `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
}

function projectSingleToWire(value: JsonObject, extra: string[]): JsonObject {
  assertKeys(value, ['url', 'size', ...extra]);
  validateSingleFields(value, extra);
  return { ...value, digest: digestFromUrl(value['url']), url: undefined };
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
  localDomain: string,
): string {
  const value = parseObject(content);
  switch (contentType) {
    case ContentType.PURE_TEXT:
      return JSON.stringify(
        projectTextContent(value, false, { from: 'local', to: localDomain }),
      );
    case ContentType.IMAGE:
      return JSON.stringify(
        withoutUndefined(projectSingleToWire(value, ['w', 'h'])),
      );
    case ContentType.FILE:
      return JSON.stringify(
        withoutUndefined(projectSingleToWire(value, ['name', 'mimeType'])),
      );
    case ContentType.VIDEO:
      return JSON.stringify(
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
      return JSON.stringify(
        withoutUndefined(
          projectSingleToWire(value, ['name', 'mimeType', 'duration']),
        ),
      );
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
            ? ['w', 'h']
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
      return JSON.stringify({ items });
    }
    case ContentType.LINK: {
      assertKeys(
        value,
        ['url', 'title', 'description'],
        ['siteName', 'image', 'favicon'],
      );
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(String(value['url']));
      } catch {
        throw new Error('invalid link URL');
      }
      if (
        (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') ||
        typeof value['title'] !== 'string' ||
        typeof value['description'] !== 'string' ||
        (value['siteName'] !== undefined &&
          typeof value['siteName'] !== 'string')
      ) {
        throw new Error('invalid link content');
      }
      return JSON.stringify({
        url: value['url'],
        title: value['title'],
        description: value['description'],
        ...(value['siteName'] === undefined
          ? {}
          : { siteName: value['siteName'] }),
        ...(value['image'] === undefined
          ? {}
          : { imageDigest: digestFromUrl(value['image']) }),
        ...(value['favicon'] === undefined
          ? {}
          : { faviconDigest: digestFromUrl(value['favicon']) }),
      });
    }
    case ContentType.INVITE:
      assertKeys(
        value,
        ['type', 'from', 'group', 'groupName', 'groupDomain'],
        ['groupAvatar', 'groupIsLocal'],
      );
      if (
        value['type'] !== 'GROUP_INVITE' ||
        typeof value['from'] !== 'string' ||
        !isValidUserAccount(value['from']) ||
        typeof value['group'] !== 'string' ||
        !isValidGroupAccount(value['group']) ||
        typeof value['groupName'] !== 'string' ||
        typeof value['groupDomain'] !== 'string' ||
        value['groupDomain'].length === 0
      ) {
        throw new Error('invalid invite content');
      }
      return JSON.stringify({
        group: value['group'],
        groupName: value['groupName'],
        groupDomain: value['groupDomain'],
      });
    case ContentType.FORWARD:
      assertKeys(value, [
        'version',
        'bundleId',
        'summaryLines',
        'messageCount',
        'assetCount',
      ]);
      if (typeof value['bundleId'] !== 'string')
        throw new Error('invalid forward card');
      validateForwardCard({ bundleId: value['bundleId'] });
      return JSON.stringify({ bundleId: value['bundleId'] });
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
  localDomain: string,
  inviterAccount?: string,
): string {
  const value = parseObject(content);
  const single = (extra: string[]): string => {
    assertKeys(value, ['digest', 'size', ...extra]);
    assertDigest(value['digest']);
    validateSingleFields(value, extra);
    return JSON.stringify(
      withoutUndefined({
        ...value,
        url: localCasUrl(value['digest']),
        digest: undefined,
      }),
    );
  };
  switch (contentType) {
    case ContentType.PURE_TEXT:
      return JSON.stringify(
        projectTextContent(value, true, { from: localDomain, to: 'local' }),
      );
    case ContentType.IMAGE:
      return single(['w', 'h']);
    case ContentType.FILE:
      return single(['name', 'mimeType']);
    case ContentType.VIDEO:
      return single(['name', 'mimeType', 'w', 'h', 'duration']);
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
            ? ['w', 'h']
            : kind === 'VIDEO'
              ? ['name', 'mimeType', 'w', 'h', 'duration']
              : kind === 'AUDIO'
                ? ['name', 'mimeType', 'duration']
                : kind === 'FILE'
                  ? ['name', 'mimeType']
                  : null;
        if (!fields) throw new Error('invalid gallery kind');
        assertKeys(record, ['kind', 'digest', 'size', ...fields]);
        assertDigest(record['digest']);
        validateSingleFields(record, fields);
        return withoutUndefined({
          ...record,
          url: localCasUrl(record['digest']),
          digest: undefined,
        });
      });
      return JSON.stringify({ items });
    }
    case ContentType.LINK:
      assertKeys(
        value,
        ['url', 'title', 'description'],
        ['siteName', 'imageDigest', 'faviconDigest'],
      );
      if (value['imageDigest'] !== undefined)
        assertDigest(value['imageDigest']);
      if (value['faviconDigest'] !== undefined)
        assertDigest(value['faviconDigest']);
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(String(value['url']));
      } catch {
        throw new Error('invalid link URL');
      }
      if (
        (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') ||
        typeof value['title'] !== 'string' ||
        typeof value['description'] !== 'string' ||
        (value['siteName'] !== undefined &&
          typeof value['siteName'] !== 'string')
      ) {
        throw new Error('invalid link content');
      }
      return JSON.stringify({
        url: value['url'],
        title: value['title'],
        description: value['description'],
        ...(value['siteName'] === undefined
          ? {}
          : { siteName: value['siteName'] }),
        ...(typeof value['imageDigest'] === 'string'
          ? { image: localCasUrl(value['imageDigest']) }
          : {}),
        ...(typeof value['faviconDigest'] === 'string'
          ? { favicon: localCasUrl(value['faviconDigest']) }
          : {}),
      });
    case ContentType.INVITE:
      assertKeys(value, ['group', 'groupName', 'groupDomain']);
      if (
        typeof value['group'] !== 'string' ||
        !isValidGroupAccount(value['group']) ||
        typeof value['groupName'] !== 'string' ||
        typeof value['groupDomain'] !== 'string' ||
        value['groupDomain'].length === 0
      ) {
        throw new Error('invalid invite content');
      }
      return JSON.stringify({
        ...value,
        ...(inviterAccount === undefined
          ? {}
          : { type: 'GROUP_INVITE', from: inviterAccount }),
        groupAvatar: '',
        groupIsLocal: value['groupDomain'] === localDomain,
      });
    case ContentType.CALL:
      if (!parseFederatedCallContent(content)) {
        throw new Error('invalid federated call content');
      }
      return content;
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
    if (value['imageDigest'] !== undefined) result.push(value['imageDigest']);
    if (value['faviconDigest'] !== undefined)
      result.push(value['faviconDigest']);
  }
  const digests = new Set<string>();
  for (const digest of result) {
    assertDigest(digest);
    digests.add(digest);
  }
  return [...digests];
}
