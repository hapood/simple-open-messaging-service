import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { systemSetting } from '../src/database/schema.js';

// Use the real PostgreSQL defaults and Drizzle write paths, not a mocked clock.
describe('common row timestamp persistence', () => {
  let database: DatabaseService;
  let mod: TestingModule;
  const keys = ['timestamp-default', 'timestamp-update', 'timestamp-upsert'];
  const oldTime = new Date('2000-01-01T00:00:00.000Z');

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  afterAll(async () => {
    await database.db
      .delete(systemSetting)
      .where(inArray(systemSetting.key, keys));
    await mod.close();
  });

  it('automatically fills both non-null timestamps on insert', async () => {
    const [row] = await database.db
      .insert(systemSetting)
      .values({ key: keys[0], value: 'initial' })
      .returning();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toEqual(row.createdAt);
    const result = await database.pool.query<{ invalid: string }>(`
      SELECT table_name || '.' || column_name AS invalid
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('createdAt', 'updatedAt')
        AND (is_nullable <> 'NO' OR column_default IS NULL)
    `);
    expect(result.rows).toEqual([]);
  });

  it('advances updatedAt without changing createdAt on an ordinary update', async () => {
    await database.db.insert(systemSetting).values({
      key: keys[1],
      value: 'initial',
      createdAt: oldTime,
      updatedAt: oldTime,
    });
    const [row] = await database.db
      .update(systemSetting)
      .set({ value: 'changed' })
      .where(eq(systemSetting.key, keys[1]))
      .returning();
    expect(row.createdAt).toEqual(oldTime);
    expect(row.updatedAt.getTime()).toBeGreaterThan(oldTime.getTime());
  });

  it('advances updatedAt on a conflict update without resetting createdAt', async () => {
    await database.db.insert(systemSetting).values({
      key: keys[2],
      value: 'initial',
      createdAt: oldTime,
      updatedAt: oldTime,
    });
    const [row] = await database.db
      .insert(systemSetting)
      .values({ key: keys[2], value: 'replacement' })
      .onConflictDoUpdate({
        target: systemSetting.key,
        set: { value: 'changed' },
      })
      .returning();
    expect(row.value).toBe('changed');
    expect(row.createdAt).toEqual(oldTime);
    expect(row.updatedAt.getTime()).toBeGreaterThan(oldTime.getTime());
  });

  it('rejects explicit null for either timestamp instead of substituting a default', async () => {
    for (const column of ['createdAt', 'updatedAt']) {
      await expect(
        database.pool.query(
          `INSERT INTO "SystemSetting" (key, value, "${column}") VALUES ($1, 'invalid', NULL)`,
          ['timestamp-null'],
        ),
      ).rejects.toMatchObject({ code: '23502', column });
    }
  });
});
