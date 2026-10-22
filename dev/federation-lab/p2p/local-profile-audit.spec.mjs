import test from 'node:test';
import assert from 'node:assert/strict';
import { readNodeProfileAudit } from './final-audit.mjs';

function remoteCopies() {
  const snapshot = {
    account: 'remote',
    domain: 'bravo.test',
    namespaceId: 91,
    profileRev: 1,
    displayName: 'Remote',
    bio: 'Immutable bio',
    avatar: '',
  };
  return [
    { ...snapshot, publisherNamespaceId: 91, profileNamespaceId: 0 },
    { ...snapshot, publisherNamespaceId: 92, profileNamespaceId: 7 },
  ];
}

function auditCopies(rows) {
  return readNodeProfileAudit(
    {
      query: async (sql) => ({
        rows: sql.includes('FROM "Profile"') ? rows : [],
      }),
    },
    { name: 'alpha', domain: 'alpha.test' },
  );
}

for (const reverse of [false, true]) {
  test(`deduplicates identical direct and relayed revisions without replacement (reverse=${reverse})`, async () => {
    const rows = remoteCopies();
    if (reverse) rows.reverse();
    const result = await auditCopies(rows);
    assert.deepEqual([...result.versions], [
      [
        'remote@bravo.test#1@91',
        {
          address: 'remote@bravo.test',
          profileRev: 1,
          displayName: 'Remote',
          bio: 'Immutable bio',
          avatarDigest: null,
        },
      ],
    ]);
  });

  for (const [field, value] of [
    ['displayName', 'Conflicting name'],
    ['bio', 'Conflicting bio'],
    ['avatar', 'invalid-avatar'],
  ]) {
    test(`rejects conflicting ${field} instead of replacing a revision (reverse=${reverse})`, async () => {
      const rows = remoteCopies();
      rows[1][field] = value;
      if (reverse) rows.reverse();
      await assert.rejects(
        auditCopies(rows),
        /conflicting immutable profile revision: remote@bravo\.test#1@91/,
      );
    });
  }
}


test('uses only native versions for locally authoritative accounts, never foreign self copies', async () => {
  const rows = [
    {
      account: 'self',
      domain: 'bravo.test',
      namespaceId: 0,
      publisherNamespaceId: 0,
      profileRev: 1,
      displayName: 'Native exact',
      bio: '',
      avatar: '',
    },
    {
      account: 'self',
      domain: 'bravo.test',
      namespaceId: 0,
      publisherNamespaceId: 1,
      profileRev: 1,
      displayName: 'Wrong foreign self copy',
      bio: '',
      avatar: '',
    },
    {
      account: 'self',
      domain: 'bravo.test',
      namespaceId: 0,
      publisherNamespaceId: 1,
      profileRev: 3,
      displayName: 'Foreign-only revision',
      bio: '',
      avatar: '',
    },
    {
      account: 'other',
      domain: 'charlie.test',
      namespaceId: 1,
      publisherNamespaceId: 1,
      profileRev: 1,
      displayName: 'Remote',
      bio: '',
      avatar: '',
    },
  ];
  const client = {
    query: async (sql) => ({
      rows: sql.includes('FROM "Profile"') ? rows : [],
    }),
  };
  const result = await readNodeProfileAudit(client, {
    name: 'bravo',
    domain: 'bravo.test',
  });
  assert.equal(
    result.versions.get('self@bravo.test#1').displayName,
    'Native exact',
  );
  assert.equal(result.versions.has('self@bravo.test#3'), false);
  assert.equal(
    result.versions.get('other@charlie.test#1@1').displayName,
    'Remote',
  );
});
