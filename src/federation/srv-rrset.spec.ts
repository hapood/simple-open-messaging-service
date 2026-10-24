import { describe, expect, it } from 'vitest';
import { classifySomfpSrvRrset, selectSomfpSrvRecord } from './srv-rrset.js';

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

describe('selectSomfpSrvRecord', () => {
  const records = [
    {
      host: 'backup.example',
      port: 7669,
      priority: 10,
      weight: 100,
      display: '',
    },
    { host: 'a.example', port: 7667, priority: 0, weight: 1, display: '' },
    { host: 'b.example', port: 7668, priority: 0, weight: 3, display: '' },
  ];
  it('selects only the lowest priority and honors weights', () => {
    expect(selectSomfpSrvRecord(records, () => 0).host).toBe('a.example');
    expect(selectSomfpSrvRecord(records, () => 0.25).host).toBe('b.example');
    expect(selectSomfpSrvRecord(records, () => 0.99).host).toBe('b.example');
  });
  it('chooses uniformly when all eligible weights are zero', () => {
    const zero = records.map((record) => ({ ...record, weight: 0 }));
    expect(selectSomfpSrvRecord(zero, () => 0).host).toBe('a.example');
    expect(selectSomfpSrvRecord(zero, () => 0.99).host).toBe('b.example');
  });
  it('rejects an empty candidate set', () => {
    expect(() => selectSomfpSrvRecord([])).toThrow('No SOMFP SRV targets');
  });
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
