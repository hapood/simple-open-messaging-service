import { readFileSync } from 'node:fs';
import { is, Table } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.js';

const tables = Object.values(schema)
  .filter((value) => is(value, Table))
  .map((table) => getTableConfig(table));
const baseline = readFileSync(
  new URL('../../database/migrations/0000_base.sql', import.meta.url),
  'utf8',
);
const baselineTables = new Map(
  [
    ...baseline.matchAll(/CREATE TABLE public\."([^"]+)" \(\n([\s\S]*?)\n\);/g),
  ].map((match) => [match[1], match[2]]),
);

describe('common row timestamps', () => {
  it('checks every business table in both schema definitions', () => {
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.map((table) => table.name).sort()).toEqual(
      [...baselineTables.keys()].sort(),
    );
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
        expect(column!.getSQLType()).toBe('timestamp (3) with time zone');
        expect(sql).toMatch(
          new RegExp(
            `"${name}" (?:timestamp\\(3\\) with time zone|timestamptz\\(3\\))[^\\n]*NOT NULL`,
          ),
        );
      }
    });
  }
});
