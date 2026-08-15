import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import Ajv2020Module, {
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
const normativeSpecDir = join(process.cwd(), 'spec', 'v1');
const releaseSpecDir = join(normativeSpecDir, '..');
const specDir = join(normativeSpecDir, 'schema');
const protocolVersion = 1;
const federationApiPrefix = 's2s/v1';

interface Vector {
  name: string;
  schema: string;
  semantic?: string;
  value?: unknown;
  values?: unknown[];
}

// Ajv publishes this subpath as CommonJS while also exposing a typed `default` class. Under
// NodeNext the outer default import is the CJS namespace, so select its typed inner default.
const Ajv2020 = Ajv2020Module.default;
type Ajv2020Instance = InstanceType<typeof Ajv2020>;

function printErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`)
    .join('; ');
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function buildAjv(): Promise<Ajv2020Instance> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const names = (await readdir(specDir)).filter((name) =>
    name.endsWith('.schema.json'),
  );
  for (const name of names) {
    ajv.addSchema((await json(join(specDir, name))) as AnySchema);
  }
  return ajv;
}

async function validateReleaseMetadata(): Promise<void> {
  const release = (await json(join(releaseSpecDir, 'RELEASE.json'))) as {
    protocol?: string;
    abbreviation?: string;
    version?: string;
    major?: number;
    status?: string;
    normativeEntryPoint?: string;
    licenseFile?: string;
    conformance?: string;
  };
  const expected = {
    protocol: 'Simple Open Chat Federation Protocol',
    abbreviation: 'SOCFP',
    major: protocolVersion,
    status: 'release-candidate',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (release[key as keyof typeof release] !== value) {
      throw new Error(`RELEASE.json has unexpected ${key}`);
    }
  }
  if (
    typeof release.version !== 'string' ||
    !new RegExp(`^${protocolVersion}\\.\\d+\\.\\d+-rc\\.(0|[1-9]\\d*)$`).test(
      release.version,
    )
  ) {
    throw new Error(
      'RELEASE.json version must be a release-candidate SemVer for the wire major',
    );
  }
  for (const path of [
    release.normativeEntryPoint,
    release.licenseFile,
    release.conformance,
  ]) {
    if (!path) throw new Error('RELEASE.json is missing a required path');
    await readFile(join(releaseSpecDir, path));
  }
}

function validateStrictVersions(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const versions = (value as { protocolVersions?: unknown }).protocolVersions;
  return (
    Array.isArray(versions) &&
    versions.includes(protocolVersion) &&
    versions.every(
      (version, index) =>
        Number.isSafeInteger(version) &&
        version >= 1 &&
        (index === 0 || version > versions[index - 1]),
    )
  );
}

function semanticValid(schema: string, value: unknown): boolean {
  if (schema === 'urn:socfp:v1:discovery') {
    if (!validateStrictVersions(value)) return false;
    const doc = value as {
      rootKey: { ed25519: string };
      keys: Array<{
        keyId: string;
        ed25519: string;
        notBefore: number;
        notAfter: number;
        authorizationSignature: string;
      }>;
    };
    const root = Buffer.from(doc.rootKey.ed25519, 'base64');
    const ids = new Set<string>();
    return doc.keys.every((key) => {
      if (ids.has(key.keyId) || key.notBefore >= key.notAfter) return false;
      ids.add(key.keyId);
      const statement = JSON.stringify({
        keyId: key.keyId,
        ed25519: key.ed25519,
        usage: 'socfp-http-message-signature',
        notBefore: key.notBefore,
        notAfter: key.notAfter,
      });
      return ed25519.verify(
        Buffer.from(key.authorizationSignature, 'base64'),
        Buffer.from(statement),
        root,
      );
    });
  }
  if (
    schema === 'urn:socfp:v1:identity#/$defs/v1DiscoveryResult' ||
    schema === 'urn:socfp:v1:identity#/$defs/healthResult'
  ) {
    const extensions = (
      value as {
        extensions?: string[];
        acceptedExtensions?: string[] | null;
      }
    ).extensions ??
      (value as { acceptedExtensions?: string[] | null }).acceptedExtensions;
    return (
      extensions === null ||
      extensions === undefined ||
      extensions.every(
        (extension, index) =>
          index === 0 || extension > extensions[index - 1],
      )
    );
  }
  if (schema === 'urn:socfp:v1:state-feed') {
    const page = value as {
      hasMore?: boolean;
      scannedThrough?: string;
      stateFeedEndId?: string;
      items?: Array<{ body?: Record<string, unknown> }>;
    };
    if (!page.hasMore && page.scannedThrough !== page.stateFeedEndId)
      return false;
    return (page.items ?? []).every(({ body = {} }) => {
      if (body.status !== 'REQUESTED') return true;
      if (typeof body.requestedAt !== 'number') return false;
      return (
        body.expiresAt === null ||
        (typeof body.expiresAt === 'number' &&
          body.expiresAt > body.requestedAt)
      );
    });
  }
  if (schema === 'urn:socfp:v1:message-feed') {
    const page = value as {
      scannedThrough?: string;
      messageFeedEndId?: string;
      items?: Array<{
        feedId: string;
        messageEndSeq: string;
      }>;
    };
    if (
      page.scannedThrough === undefined ||
      page.messageFeedEndId === undefined
    )
      return false;
    let previous: bigint | undefined;
    return (page.items ?? []).every((item) => {
      const feedId = BigInt(item.feedId);
      const ordered = previous === undefined || feedId > previous;
      previous = feedId;
      return ordered && feedId <= BigInt(page.scannedThrough!);
    });
  }
  if (schema === 'urn:socfp:v1:message-query') {
    const page = value as {
      scannedThrough?: string;
      messages?: Array<{
        seq: number;
        createdAt: number;
        originSeq: number | null;
        originCreatedAt: number | null;
        contentType: string;
        content: string;
      }>;
    };
    if (page.scannedThrough === undefined) return false;
    let previous: number | undefined;
    return (page.messages ?? []).every((message) => {
      const ordered = previous === undefined || message.seq > previous;
      previous = message.seq;
      return (
        ordered &&
        BigInt(message.seq) <= BigInt(page.scannedThrough!) &&
        ((message.originSeq === null && message.originCreatedAt === null) ||
          (Number.isSafeInteger(message.originSeq) &&
            message.originSeq! > 0 &&
            Number.isSafeInteger(message.originCreatedAt) &&
            message.originCreatedAt! >= 0)) &&
        parsedContent(message.contentType, message.content) !== null
      );
    });
  }
  if (schema === 'urn:socfp:v1:error') {
    const error = value as {
      code?: number;
      data?: { resumeAfter?: string };
    };
    if (error.code !== 50019) return true;
    return error.data?.resumeAfter !== undefined;
  }
  return true;
}

let contentValidator: ValidateFunction | undefined;
function parsedContent(contentType: string, encoded: string): unknown | null {
  try {
    const content = JSON.parse(encoded) as unknown;
    return contentValidator?.({ contentType, content }) ? content : null;
  } catch {
    return null;
  }
}

async function validateVectors(ajv: Ajv2020Instance): Promise<void> {
  contentValidator = ajv.getSchema('urn:socfp:v1:message-content');
  if (!contentValidator)
    throw new Error('message content schema was not registered');
  for (const [file, expected] of [
    ['valid.json', true],
    ['invalid.json', false],
  ] as const) {
    const document = (await json(join(specDir, 'vectors', file))) as {
      vectors: Vector[];
    };
    for (const vector of document.vectors) {
      const validate = ajv.getSchema(vector.schema);
      if (!validate)
        throw new Error(`${vector.name}: unknown schema ${vector.schema}`);
      const values = vector.values ?? [vector.value];
      for (const value of values) {
        const shapeValid = validate(value);
        const semantic = shapeValid && semanticValid(vector.schema, value);
        if (semantic !== expected) {
          throw new Error(
            `${file} / ${vector.name}: expected ${expected}, shape=${shapeValid}, semantic=${semantic}; ${printErrors(validate.errors)}`,
          );
        }
      }
    }
  }
}

async function validateManifest(ajv: Ajv2020Instance): Promise<void> {
  const manifest = (await json(join(specDir, 'http-manifest.json'))) as {
    majorVersion: number;
    s2sPrefix: string;
    operations: Array<{
      method: string;
      path: string;
      requestSchema?: string;
      responseSchema?: string;
      parameterSchema?: string;
      secondaryContentSchema?: string;
    }>;
    errorSchema: string;
  };
  if (
    manifest.majorVersion !== protocolVersion ||
    manifest.s2sPrefix !== `/${federationApiPrefix}`
  ) {
    throw new Error('HTTP manifest version/prefix differs from code constants');
  }
  const expected = new Set([
    'GET /.well-known/socfp',
    'POST /s2s/v1/recognize',
    'POST /s2s/v1/healthy',
    'POST /s2s/v1/discover',
    'POST /s2s/v1/feed-heads',
    'GET /s2s/v1/state-feed',
    'GET /s2s/v1/message-feed',
    'GET /s2s/v1/messages',
    'GET /s2s/v1/message-tombstone-feed',
    'GET /s2s/v1/message-tombstones',
    'POST /s2s/v1/call',
    'GET /s2s/v1/users/:account',
    'GET /s2s/v1/media/:digest',
    'GET /s2s/v1/forward-bundles/:bundleId',
  ]);
  const actual = new Set(
    manifest.operations.map(
      (operation) => `${operation.method} ${operation.path}`,
    ),
  );
  if (
    expected.size !== actual.size ||
    [...expected].some((item) => !actual.has(item))
  ) {
    throw new Error(
      'HTTP manifest does not contain the exact Federation v1 surface',
    );
  }
  const schemaIds = [
    manifest.errorSchema,
    ...manifest.operations.flatMap((operation) => [
      operation.requestSchema,
      operation.responseSchema,
      operation.parameterSchema,
      operation.secondaryContentSchema,
    ]),
  ].filter((id): id is string => !!id);
  for (const id of schemaIds) {
    if (!ajv.getSchema(id))
      throw new Error(`HTTP manifest references unknown schema ${id}`);
  }
}

async function validateErrorRegistry(): Promise<void> {
  const markdown = await readFile(join(normativeSpecDir, 'errors.md'), 'utf8');
  const heading = '## 稳定错误码注册表（Stable Code Registry）';
  const start = markdown.indexOf(heading);
  if (start < 0)
    throw new Error('errors.md is missing the stable code registry');
  const section = markdown.slice(start + heading.length).split('\n## ')[0];
  const documented = new Map<number, string>();
  for (const match of section.matchAll(
    /^\|\s*(\d+)\s*\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm,
  )) {
    const code = Number(match[1]);
    if (documented.has(code))
      throw new Error(`errors.md repeats stable code ${code}`);
    documented.set(code, match[2]);
  }
  if (documented.size === 0)
    throw new Error('errors.md stable code registry is empty');

  const errorSchema = (await json(join(specDir, 'error.schema.json'))) as {
    properties: { code: { enum: number[] } };
  };
  const schemaCodes = errorSchema.properties.code.enum;
  const documentedCodes = [...documented.keys()];

  const sameCodes = (left: number[], right: number[]) =>
    left.length === right.length && left.every((code, i) => code === right[i]);
  if (!sameCodes(documentedCodes, schemaCodes)) {
    throw new Error(
      `Federation v1 error code drift: errors.md=${documentedCodes.join(',')} schema=${schemaCodes.join(',')}`,
    );
  }
}

async function validateSignatureVector(file: string): Promise<void> {
  const vector = (await json(join(specDir, 'vectors', file))) as {
    privateKeyBase64: string;
    publicKeyBase64: string;
    request: {
      method: string;
      path: string;
      query: string;
      authority: string;
      body: string;
    };
    created: number;
    expires: number;
    keyId: string;
    headers: Record<string, string>;
    signatureBase: string;
  };
  const digest = `sha-256=:${createHash('sha256').update(vector.request.body).digest('base64')}:`;
  const privateKey = Buffer.from(vector.privateKeyBase64, 'base64');
  const signature = Buffer.from(
    ed25519.sign(new TextEncoder().encode(vector.signatureBase), privateKey),
  );
  const encodedSignature = `sig1=:${signature.toString('base64')}:`;
  const expectedDate = new Date(vector.created * 1000).toUTCString();
  const expectedInput = `sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=${vector.created};expires=${vector.expires};keyid="${vector.keyId}";alg="ed25519"`;
  if (
    vector.expires !== vector.created + 300 ||
    digest !== vector.headers['content-digest'] ||
    expectedDate !== vector.headers.date ||
    expectedInput !== vector.headers['signature-input'] ||
    encodedSignature !== vector.headers.signature ||
    !ed25519.verify(
      signature,
      new TextEncoder().encode(vector.signatureBase),
      Buffer.from(vector.publicKeyBase64, 'base64'),
    )
  ) {
    throw new Error(
      `${file}: HTTP Message Signature vector does not reproduce exactly`,
    );
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  await validateReleaseMetadata();
  const ajv = await buildAjv();
  const schema = argument('--schema');
  const file = argument('--file');
  if ((schema && !file) || (!schema && file)) {
    throw new Error('--schema and --file must be supplied together');
  }
  if (schema && file) {
    const validate = ajv.getSchema(schema);
    if (!validate) throw new Error(`unknown schema ${schema}`);
    const value = await json(resolve(file));
    if (!validate(value) || !semanticValid(schema, value)) {
      throw new Error(
        `input is not conformant: ${printErrors(validate.errors)}`,
      );
    }
    console.log(`conformant: ${file} (${schema})`);
    return;
  }
  await validateManifest(ajv);
  await validateErrorRegistry();
  await validateVectors(ajv);
  await validateSignatureVector('http-message-signature.json');
  await validateSignatureVector('call-http-message-signature.json');
  console.log('SOCFP v1 conformance package: PASS');
}

await main();
