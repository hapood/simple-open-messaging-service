import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S2sController } from './s2s.controller.js';
import { S2sRecognitionController } from './s2s-recognition.controller.js';
import { WellKnownController } from './well-known.controller.js';
import { GLOBAL_PREFIX_EXCLUSIONS } from '../bootstrap.js';
import {
  FEDERATION_API_PREFIX,
  FEDERATION_PROTOCOL_VERSION,
  selectFederationProtocolVersion,
  FEDERATION_WELL_KNOWN_PATH,
} from './federation-protocol.js';

type ControllerClass = abstract new (...args: never[]) => unknown;

function routes(controller: ControllerClass): string[] {
  const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) as
    | string
    | undefined;
  return Object.getOwnPropertyNames(controller.prototype)
    .flatMap((property) => {
      if (property === 'constructor') return [];
      const handler = Object.getOwnPropertyDescriptor(
        controller.prototype,
        property,
      )?.value as unknown;
      if (typeof handler !== 'function') return [];
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        | string
        | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        | RequestMethod
        | undefined;
      if (path === undefined || method === undefined) return [];
      const verb = RequestMethod[method];
      const relative = [controllerPath, path].filter(Boolean).join('/');
      return [`${verb} /${relative}`];
    })
    .sort();
}

describe('Federation v1 surface', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('matches the complete mandatory route manifest', () => {
    expect(
      [S2sController, S2sRecognitionController, WellKnownController]
        .flatMap(routes)
        .sort(),
    ).toEqual(
      [
        'GET /.well-known/somfp',
        'GET /s2s/v1/forward-bundles/:bundleId',
        'GET /s2s/v1/group-meta',
        'GET /s2s/v1/group-member-profile',
        'GET /s2s/v1/media/:digest',
        'GET /s2s/v1/messages',
        'GET /s2s/v1/message-tombstones',
        'GET /s2s/v1/message-author-profile',
        'GET /s2s/v1/profiles/:account',
        'GET /s2s/v1/state-feed',
        'GET /s2s/v1/accounts/:account',
        'POST /s2s/v1/call',
        'POST /s2s/v1/feed-heads',
        'GET /s2s/v1/health',
        'POST /s2s/v1/recognize',
      ].sort(),
    );
  });

  it('keeps every federation route outside the client API prefix', () => {
    const declaredRoutes = [
      S2sController,
      S2sRecognitionController,
      WellKnownController,
    ]
      .flatMap(routes)
      .sort();
    const excludedRoutes = GLOBAL_PREFIX_EXCLUSIONS.map(
      ({ method, path }) => `${RequestMethod[method]} /${path}`,
    ).sort();

    expect(excludedRoutes).toEqual(declaredRoutes);
  });

  it('keeps cross-version bootstrap on the fixed well-known surface', () => {
    vi.stubEnv('SOMS_DOMAIN', 'node-a.example');
    const controller = new WellKnownController({
      getRootPublicKeyB64: () => 'root-key',
      getSigningKeyCertificates: () => [],
    } as never);

    const document = controller.getWellKnown();
    expect(FEDERATION_API_PREFIX).toBe('s2s/v1');
    expect(FEDERATION_WELL_KNOWN_PATH).toBe('.well-known/somfp');
    expect(document.protocolVersions).toEqual([FEDERATION_PROTOCOL_VERSION]);
    expect(document.software).toMatch(/^soms\//);
    expect(document).not.toHaveProperty('capabilities');
    expect(Object.keys(document).sort()).toEqual(
      ['keys', 'protocolVersions', 'rootKey', 'software'].sort(),
    );
  });

  it('selects the highest mutual version from a strict ascending version list', () => {
    expect(selectFederationProtocolVersion([1])).toBe(1);
    expect(selectFederationProtocolVersion([1, 2])).toBe(1);
    expect(selectFederationProtocolVersion([2])).toBeNull();
    expect(selectFederationProtocolVersion([1, 1])).toBeNull();
    expect(selectFederationProtocolVersion([2, 1])).toBeNull();
  });
});
