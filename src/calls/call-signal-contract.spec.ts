import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { FederationCallBridgeService } from '../federation/federation-call-bridge.service.js';
import { SignalCallDto } from '../dto/call.dto.js';
import {
  parseS2SCallWireFrame,
  toS2SCallWireFrame,
} from './federated-call-protocol.js';

const id = 'c0a80101-0000-4000-8000-000000000001';
const offerId = 'c0a80101-0000-4000-8000-000000000002';
const schema = (name: string) =>
  JSON.parse(readFileSync(`spec/v1/schema/${name}.schema.json`, 'utf8'));
const ajv = new Ajv2020.default({ strict: false });
ajv.addSchema(schema('common'));
const validateWire = ajv.compile(schema('call'));

async function check(kind: string, extra: object, valid: boolean) {
  const wire = {
    callId: id,
    operation: 'signal',
    payload: { signalId: id, signalType: kind, data: 'opaque', ...extra },
  };
  expect(validateWire(wire)).toBe(valid);
  if (valid)
    expect(toS2SCallWireFrame(parseS2SCallWireFrame(wire))).toEqual(wire);
  else expect(() => parseS2SCallWireFrame(wire)).toThrow();
  const dto = plainToInstance(SignalCallDto, {
    id,
    callSid: id,
    kind,
    payload: 'opaque',
    ...extra,
  });
  expect(
    (await validate(dto, { whitelist: true, forbidNonWhitelisted: true }))
      .length === 0,
  ).toBe(valid);
}

describe('closed answer correlation contract', () => {
  it('serializes correlation unchanged into the federation request body', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const bridge = new FederationCallBridgeService(
      { post } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await bridge.sendFrame(
      {
        fromLocalUserId: 1,
        to: { account: 'bob', domain: 'b.example' },
        callSid: id,
        op: 'signal',
        signalId: id,
        signalType: 'answer',
        inReplyTo: offerId,
        data: 'opaque\r\nSDP',
      },
      'b.example',
    );
    const wire = JSON.parse(post.mock.calls[0][1]);
    expect(wire.payload).toEqual({
      signalId: id,
      signalType: 'answer',
      inReplyTo: offerId,
      data: 'opaque\r\nSDP',
    });
    expect(validateWire(wire)).toBe(true);
  });
  it('requires canonical answer correlation across DTO, parser and schema', async () => {
    await check('answer', { inReplyTo: offerId }, true);
    for (const extra of [
      {},
      { inReplyTo: null },
      { inReplyTo: '' },
      { inReplyTo: offerId.toUpperCase() },
      { inReplyTo: 1 },
      { inReplyTo: offerId, unknown: true },
    ]) {
      await check('answer', extra, false);
    }
  });

  it.each(['offer', 'ice', 'video-state'])(
    'forbids correlation on %s and leaves inner data opaque',
    async (kind) => {
      await check(kind, {}, true);
      await check(kind, { inReplyTo: offerId }, false);
      await check(kind, { inReplyTo: null }, false);
    },
  );
});
