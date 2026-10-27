import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { profileTable } from '../src/database/schema.js';
import { writeProfileSnapshotInTx } from '../src/user/profile-store.js';
import { UserService } from '../src/user/user.service.js';

describe('immutable profile generation time', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  const snapshot = {
    account: 'generation-time',
    publisherNamespaceId: 0,
    profileNamespaceId: 0,
    profileRev: 1,
    displayName: 'Generation time',
    avatar: '',
    bio: '',
    generatedAt: 1_700_000_000_000,
  };

  beforeAll(async () => {
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = mod.get(DatabaseService);
  });
  afterAll(async () => {
    await mod?.close();
  });

  it('stores the full safe-integer range without converting to Date', async () => {
    for (const [index, generatedAt] of [0, Number.MAX_SAFE_INTEGER].entries()) {
      const [stored] = await database.db
        .insert(profileTable)
        .values({
          ...snapshot,
          profileRev: index + 10,
          generatedAt,
        })
        .returning();
      expect(stored.generatedAt).toBe(generatedAt);
    }
  });

  it.each([undefined, null, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects missing or out-of-range generation time %s at the database boundary',
    async (generatedAt) => {
      await expect(
        database.db.insert(profileTable).values({
          ...snapshot,
          profileRev: 20,
          generatedAt,
        } as typeof profileTable.$inferInsert),
      ).rejects.toThrow();
    },
  );

  it('accepts identical replays and rejects time conflicts without overwriting the snapshot', async () => {
    const store = (generatedAt: number) =>
      database.db.transaction((tx) =>
        writeProfileSnapshotInTx(tx, { ...snapshot, generatedAt }),
      );
    await store(snapshot.generatedAt);
    const read = () =>
      database.db.query.profileTable.findFirst({
        where: and(
          eq(profileTable.account, snapshot.account),
          eq(profileTable.profileRev, 1),
        ),
      });
    const original = await read();
    await store(snapshot.generatedAt);
    await expect(store(snapshot.generatedAt + 1)).rejects.toThrow(
      'conflicting immutable profile revision',
    );
    expect(await read()).toEqual(original);
    expect(original!.createdAt.getTime()).toBeGreaterThan(snapshot.generatedAt);
  });

  it('generates a time for every local revision and leaves the old revision unchanged', async () => {
    const users = mod.get(UserService);
    const created = await users.addUser({ account: 'generation-owner' });
    const before = Date.now();
    await users.updateProfile(created.data!.id, { name: 'First', bio: '' });
    const first = await database.db.query.profileTable.findFirst({
      where: eq(profileTable.account, 'generation-owner'),
    });
    expect(first!.generatedAt).toBeGreaterThanOrEqual(before);
    expect(first!.generatedAt).toBeLessThanOrEqual(Date.now());
    await users.updateProfile(created.data!.id, { name: 'Second', bio: '' });
    const revisions = await database.db.query.profileTable.findMany({
      where: eq(profileTable.account, 'generation-owner'),
      orderBy: profileTable.profileRev,
    });
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toEqual(first);
    expect(Number.isSafeInteger(revisions[1].generatedAt)).toBe(true);
  });
});
