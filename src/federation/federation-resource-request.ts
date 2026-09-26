import { HttpStatus } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  isValidSomfpDomain,
  isValidSomfpUserAccount,
} from '../common/account.js';

const GROUP_ACCOUNT_RE = /^![a-z0-9]{2,30}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;

type QueryField = { name: string; optional?: boolean };

export interface ResourceRequestSpec {
  pathPrefix: string;
  pathName: string;
  query?: QueryField[];
}

export interface ParsedResourceRequest {
  pathValue: string;
  query: Record<string, string>;
}

/** Exact resource paths carry independently encoded segments and no query. */
export function parseFederationResourcePath(
  req: FastifyRequest,
  pathPrefix: string,
  pathNames: readonly string[],
): Record<string, string> {
  const { rawPath, rawQuery } = splitResourceGetTarget(req);
  if (!rawPath.startsWith(pathPrefix) || rawQuery !== undefined)
    malformed('invalid resource path or query');
  const segments = rawPath.slice(pathPrefix.length).split('/');
  if (segments.length !== pathNames.length ||
      new Set(pathNames).size !== pathNames.length)
    malformed('invalid resource path segments');
  return Object.fromEntries(
    pathNames.map((name, index) => [name, decodeComponent(segments[index], name)]),
  );
}

export interface FixedResourceRequestSpec {
  path: string;
  query: QueryField[];
}

function malformed(message: string): never {
  throw new BusinessException(
    BusinessCode.FEDERATION_MALFORMED,
    message,
    HttpStatus.BAD_REQUEST,
  );
}

/** Encode one federation resource path/query value in canonical RFC 3986 form. */
export function encodeFederationResourceComponent(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9._~-]/.test(char)) encoded += char;
    else encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

function decodeComponent(raw: string, name: string): string {
  if (!raw || raw.includes('+') || /%(?![0-9A-F]{2})/.test(raw)) {
    return malformed(`${name} has non-canonical percent encoding`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return malformed(`${name} is not valid UTF-8 percent encoding`);
  }
  if (encodeFederationResourceComponent(decoded) !== raw) {
    return malformed(`${name} has non-canonical percent encoding`);
  }
  return decoded;
}

function singleHeader(
  value: string | string[] | undefined,
  name: string,
): string | undefined {
  if (Array.isArray(value)) malformed(`duplicate ${name} header`);
  return value;
}

function splitResourceGetTarget(req: FastifyRequest): {
  rawPath: string;
  rawQuery: string | undefined;
} {
  if (req.method.toUpperCase() !== 'GET')
    malformed('resource method must be GET');
  if ((req.rawBody?.length ?? 0) !== 0)
    malformed('resource GET request body must be empty');
  if (req.headers['content-type'] !== undefined)
    malformed('resource GET must not send Content-Type');
  const contentLength = singleHeader(
    req.headers['content-length'],
    'Content-Length',
  );
  if (contentLength !== undefined && contentLength !== '0')
    malformed('resource GET Content-Length must be 0');

  const rawTarget = req.url ?? '';
  const question = rawTarget.indexOf('?');
  const rawPath = question < 0 ? rawTarget : rawTarget.slice(0, question);
  const rawQuery = question < 0 ? undefined : rawTarget.slice(question + 1);
  return { rawPath, rawQuery };
}

function parseOrderedQuery(
  rawQuery: string | undefined,
  fields: QueryField[],
): Record<string, string> {
  if (fields.length === 0) {
    if (rawQuery !== undefined) malformed('query parameters are not allowed');
    return {};
  }
  if (rawQuery === undefined || rawQuery === '')
    malformed('required query parameters are missing');
  const parts = rawQuery.split('&');
  const requiredCount = fields.filter((field) => !field.optional).length;
  if (parts.length < requiredCount || parts.length > fields.length)
    malformed('resource query has missing, duplicate, or unknown parameters');

  const query: Record<string, string> = {};
  for (let index = 0; index < parts.length; index += 1) {
    const field = fields[index];
    const part = parts[index];
    const equals = part.indexOf('=');
    if (!field || equals <= 0 || part.indexOf('=', equals + 1) >= 0)
      malformed('resource query is malformed');
    const rawName = part.slice(0, equals);
    if (rawName !== field.name)
      malformed(
        'resource query parameters are unknown, duplicated, or out of order',
      );
    query[field.name] = decodeComponent(part.slice(equals + 1), field.name);
  }
  if (parts.length < fields.length && !fields[parts.length]?.optional)
    malformed('required query parameters are missing');
  return query;
}

/** Validate the exact raw GET target before operation-specific scalar checks. */
export function parseFederationResourceRequest(
  req: FastifyRequest,
  spec: ResourceRequestSpec,
): ParsedResourceRequest {
  const { rawPath, rawQuery } = splitResourceGetTarget(req);
  if (!rawPath.startsWith(spec.pathPrefix))
    malformed(`invalid ${spec.pathName} path`);
  const rawPathValue = rawPath.slice(spec.pathPrefix.length);
  if (!rawPathValue || rawPathValue.includes('/'))
    malformed(`invalid ${spec.pathName} path`);
  const pathValue = decodeComponent(rawPathValue, spec.pathName);

  return { pathValue, query: parseOrderedQuery(rawQuery, spec.query ?? []) };
}

/** Validate a fixed-path resource request with an exact ordered raw query. */
export function parseFederationFixedResourceRequest(
  req: FastifyRequest,
  spec: FixedResourceRequestSpec,
): Record<string, string> {
  const { rawPath, rawQuery } = splitResourceGetTarget(req);
  if (rawPath !== spec.path) malformed('invalid resource path');
  return parseOrderedQuery(rawQuery, spec.query);
}

export function requireUserAccount(value: string, name: string): string {
  if (!isValidSomfpUserAccount(value))
    malformed(`${name} is not a UserAccount`);
  return value;
}

export function requireAccount(value: string, name: string): string {
  if (!isValidSomfpUserAccount(value) && !GROUP_ACCOUNT_RE.test(value))
    malformed(`${name} is not an Account`);
  return value;
}

export function requireDomain(value: string, name: string): string {
  if (!isValidSomfpDomain(value)) malformed(`${name} is not a Domain`);
  return value;
}

export function requireSha256Hex(value: string, name: string): string {
  if (!SHA256_HEX_RE.test(value)) malformed(`${name} is not a Sha256Hex`);
  return value;
}

export function requireSafeDecimal(value: string, name: string): number {
  if (!DECIMAL_RE.test(value)) malformed(`${name} is not a DecimalString`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER))
    malformed(`${name} exceeds SafeInteger`);
  return Number(parsed);
}

export function requireBundleId(value: string, name = 'bundleId'): string {
  if (
    Buffer.byteLength(value, 'utf8') < 1 ||
    Buffer.byteLength(value, 'utf8') > 26 ||
    value.includes('\0') ||
    value.includes('/')
  ) {
    malformed(`${name} is not a bounded bundle ID`);
  }
  return value;
}

export type FederationRange =
  | { kind: 'none' }
  | { kind: 'valid'; start: number; end: number }
  | { kind: 'unsatisfiable' }
  | { kind: 'malformed' };

export function parseFederationRange(
  rangeHeader: string | string[] | undefined,
  total: number,
): FederationRange {
  if (!Number.isSafeInteger(total) || total < 0) return { kind: 'malformed' };
  if (Array.isArray(rangeHeader)) return { kind: 'malformed' };
  const header = rangeHeader;
  if (!header) return { kind: 'none' };
  const match = /^bytes=(.*)$/i.exec(header);
  if (!match) return { kind: 'malformed' };
  const spec = match[1];
  if (spec.includes(',')) return { kind: 'malformed' };
  const dash = spec.indexOf('-');
  if (dash < 0 || spec.indexOf('-', dash + 1) >= 0)
    return { kind: 'malformed' };
  const left = spec.slice(0, dash);
  const right = spec.slice(dash + 1);
  if (!left && !right) return { kind: 'malformed' };
  let start: number;
  let end: number;
  if (left === '') {
    const suffixLength = Number(right);
    if (!/^[1-9]\d*$/.test(right) || !Number.isSafeInteger(suffixLength))
      return { kind: 'malformed' };
    if (total === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number(left);
    if (!/^(0|[1-9]\d*)$/.test(left) || !Number.isSafeInteger(start))
      return { kind: 'malformed' };
    if (right === '') {
      end = total - 1;
    } else {
      const requestedEnd = Number(right);
      if (!/^(0|[1-9]\d*)$/.test(right) || !Number.isSafeInteger(requestedEnd))
        return { kind: 'malformed' };
      if (start > requestedEnd) return { kind: 'unsatisfiable' };
      end = Math.min(requestedEnd, total - 1);
    }
  }
  if (start >= total || start > end) return { kind: 'unsatisfiable' };
  return { kind: 'valid', start, end };
}
