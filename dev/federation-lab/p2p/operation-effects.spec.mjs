import assert from 'node:assert/strict';
import test from 'node:test';
import { compareOperationEffects } from './operation-effects.mjs';

test('rejects a converged but ineffective ownership transfer', () => {
  const group = '!group@alpha.test';
  const operations = [
    {
      id: 'op-1',
      type: 'TRANSFER_GROUP_OWNERSHIP',
      status: 'SUCCEEDED',
      group,
      actor: 'alice@alpha.test',
      target: { address: 'bob@alpha.test' },
    },
  ];
  const roster = [
    { address: 'alice@alpha.test', role: 'OWNER' },
    { address: 'bob@alpha.test', role: 'MEMBER' },
  ];
  const snapshot = {
    groups: { alpha: { groups: new Map([[group, { roster }]]) } },
  };
  assert.equal(compareOperationEffects(operations, snapshot).passed, false);
  roster[0].role = 'MEMBER';
  roster[1].role = 'OWNER';
  assert.equal(compareOperationEffects(operations, snapshot).passed, true);
});
