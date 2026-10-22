import { describe, expect, it } from 'vitest';
import { classifySomfpSrvRrset } from './srv-rrset.js';

const record = (
  over: Partial<{
    name: string;
    port: number;
    priority: number;
    weight: number;
  }>,
) => ({
  name: 'edge.example.net',
  port: 7667,
  priority: 0,
  weight: 0,
  ...over,
});

describe('classifySomfpSrvRrset', () => {
  it('treats an empty answer as no service', () => {
    expect(classifySomfpSrvRrset([])).toEqual({ kind: 'empty' });
  });

  it('treats a sole "." target as an explicit disablement', () => {
    expect(classifySomfpSrvRrset([record({ name: '.', port: 0 })])).toEqual({
      kind: 'disabled',
    });
  });

  it('rejects "." mixed with real targets', () => {
    expect(classifySomfpSrvRrset([record({ name: '.' }), record({})])).toEqual({
      kind: 'invalid',
      reason: 'mixed',
    });
  });

  it('rejects IP-literal targets and out-of-range fields', () => {
    expect(classifySomfpSrvRrset([record({ name: '192.0.2.10' })])).toEqual({
      kind: 'invalid',
      reason: 'fields',
    });
    expect(classifySomfpSrvRrset([record({ name: '[2001:db8::1]' })])).toEqual({
      kind: 'invalid',
      reason: 'fields',
    });
    expect(classifySomfpSrvRrset([record({ port: 0 })])).toEqual({
      kind: 'invalid',
      reason: 'fields',
    });
    expect(classifySomfpSrvRrset([record({ weight: 65_536 })])).toEqual({
      kind: 'invalid',
      reason: 'fields',
    });
  });

  it('normalizes targets, preserves record text and order, and deduplicates endpoints', () => {
    const rrset = classifySomfpSrvRrset([
      record({ name: 'Edge.Example.Net.', priority: 10, weight: 5 }),
      record({ priority: 0, weight: 0 }),
    ]);
    expect(rrset).toEqual({
      kind: 'targets',
      // Records keep DNS answer order; consumers apply their own selection order.
      records: [
        {
          priority: 10,
          weight: 5,
          port: 7667,
          host: 'edge.example.net',
          display: '10 5 7667 Edge.Example.Net.',
        },
        {
          priority: 0,
          weight: 0,
          port: 7667,
          host: 'edge.example.net',
          display: '0 0 7667 edge.example.net',
        },
      ],
      targets: [{ host: 'edge.example.net', port: 7667 }],
    });
  });
});
