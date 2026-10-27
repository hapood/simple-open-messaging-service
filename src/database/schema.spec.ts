import { readFileSync, readdirSync } from 'node:fs';
import { is, Table } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.js';

const tables = Object.values(schema)
  .filter((value) => is(value, Table))
  .map((table) => getTableConfig(table));
const migrationsDirectory = new URL(
  '../../database/migrations/',
  import.meta.url,
);
const baseline = readFileSync(
  new URL('0000_base.sql', migrationsDirectory),
  'utf8',
);
const baselineTables = new Map(
  [
    ...baseline.matchAll(/CREATE TABLE public\."([^"]+)" \(\n([\s\S]*?)\n\);/g),
  ].map((match) => [match[1], match[2]]),
);

describe('common row timestamps', () => {
  it('keeps the disposable schema in one baseline', () => {
    expect(
      readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith('.sql'))
        .sort(),
    ).toEqual(['0000_base.sql']);
  });

  it('keeps high-frequency peer observations out of identity rows', () => {
    const identityColumns = tables.find((table) => table.name === 'IdentityNamespace')!.columns.map((column) => column.name);
    expect(identityColumns).not.toContain('lastHandshakeAt');
    expect(identityColumns).not.toContain('latestHealthCheck');
    expect(baselineTables.get('FederationFeedState')).toContain('"lastHandshakeAt" timestamp(3) with time zone');
    expect(baselineTables.get('FederationFeedState')).toContain('"latestHealthCheck" jsonb');
  });

  it('stores peer signing-key creation time as non-null epoch milliseconds', () => {
    const column = tables
      .find((table) => table.name === 'IdentityNamespace')!
      .columns.find((column) => column.name === 'signingKeyCreatedAt')!;
    expect(column.notNull).toBe(true);
    expect(column.default).toBeUndefined();
    expect(column.getSQLType()).toBe('bigint');
    expect(baseline).toContain('"signingKeyCreatedAt" bigint NOT NULL');
    expect(baseline).toContain('BETWEEN 1 AND 9007199254740991');
  });
  it('requires an original profile generation time without a local-time default', () => {
    const column = schema.profileTable.generatedAt;
    expect(column.notNull).toBe(true);
    expect(column.default).toBeUndefined();
    expect(column.getSQLType()).toBe('bigint');
    expect(baselineTables.get('Profile')).toContain('"generatedAt" bigint NOT NULL');
    expect(baselineTables.get('Profile')).toContain('"generatedAt" >= 0 AND "generatedAt" <= 9007199254740991');
  });

  it('checks every business table in both schema definitions', () => {
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.map((table) => table.name).sort()).toEqual(
      [...baselineTables.keys()].sort(),
    );
  });

  it('uses database time for ordinary updates and conflict updates', () => {
    const db = drizzle.mock();
    const update = db
      .update(schema.systemSetting)
      .set({ value: 'next' })
      .toSQL();
    expect(update.sql).toContain('"updatedAt" = CURRENT_TIMESTAMP');
    expect(update.sql).not.toContain('"createdAt" =');
    const upsert = db
      .insert(schema.systemSetting)
      .values({ key: 'timestamp-test', value: 'initial' })
      .onConflictDoUpdate({
        target: schema.systemSetting.key,
        set: { value: 'next' },
      })
      .toSQL();
    expect(upsert.sql).toContain('"updatedAt" = CURRENT_TIMESTAMP');
  });

  it('removes redundant persisted creation timestamps', () => {
    for (const [table, obsolete] of [
      ['AdminActionLog', 'at'],
      ['LoginCode', 'issuedAt'],
      ['S2SKeyCache', 'fetchedAt'],
    ]) {
      expect(
        tables
          .find((candidate) => candidate.name === table)!
          .columns.map((column) => column.name),
      ).not.toContain(obsolete);
      expect(baselineTables.get(table)).not.toMatch(
        new RegExp(
          `(?:"${obsolete}"|\\b${obsolete}\\b) (?:timestamp|timestamptz)`,
        ),
      );
    }
  });

  for (const table of tables) {
    it(`${table.name} has non-null millisecond timestamp columns in Drizzle and SQL`, () => {
      const sql = baselineTables.get(table.name);
      expect(sql).toBeDefined();
      for (const name of ['createdAt', 'updatedAt']) {
        const column = table.columns.find(
          (candidate) => candidate.name === name,
        );
        expect(column, `${table.name}.${name}`).toBeDefined();
        expect(column!.notNull).toBe(true);
        expect(
          column!.default,
          `${table.name}.${name} insert default`,
        ).toBeDefined();
        if (name === 'updatedAt') {
          expect(column!.onUpdateFn, `${table.name} update hook`).toBeTypeOf(
            'function',
          );
        } else {
          expect(column!.onUpdateFn).toBeUndefined();
        }
        expect(column!.getSQLType()).toBe('timestamp (3) with time zone');
        expect(sql).toMatch(
          new RegExp(
            `"${name}" (?:timestamp\\(3\\) with time zone|timestamptz\\(3\\))[^\\n]*DEFAULT CURRENT_TIMESTAMP[^\\n]*NOT NULL`,
          ),
        );
      }
    });
  }
});
