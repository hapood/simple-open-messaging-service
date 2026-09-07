import test from 'node:test';
import assert from 'node:assert/strict';
import { readNodeProfileAudit } from './final-audit.mjs';

test('uses only native versions for locally authoritative accounts, never foreign self copies', async () => {
  const rows = [
    {
      account: 'self',
      domain: 'local',
      profileRev: 1,
      displayName: 'Historical local',
      bio: '',
      avatar: '',
    },
    {
      account: 'self',
      domain: 'bravo.test',
      profileRev: 1,
      displayName: 'Wrong foreign copy',
      bio: '',
      avatar: '',
    },
    {
      account: 'self',
      domain: 'bravo.test',
      profileRev: 3,
      displayName: 'Foreign-only revision',
      bio: '',
      avatar: '',
    },
    {
      account: 'other',
      domain: 'charlie.test',
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
    'Historical local',
  );
  assert.equal(result.versions.has('self@bravo.test#3'), false);
  assert.equal(
    result.versions.get('other@charlie.test#1').displayName,
    'Remote',
  );
});
