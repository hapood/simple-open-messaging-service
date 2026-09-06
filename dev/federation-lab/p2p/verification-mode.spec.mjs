import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertVerificationMode,
  finishWorkloadBatch,
  verifyMidpointProfiles,
} from './verification-mode.mjs';

const options = () => ({
  connections: new Map(),
  log: { operations: [{ id: 'old' }, { id: 'new' }] },
  batch: [{ id: 'new' }],
  timeoutMs: 1000,
});

test('final midpoint does not query stale profile viewers after a successful leave', async () => {
  await verifyMidpointProfiles('final', async () => {
    assert.fail('the old snapshot still selects a user who has left the group');
  });
});

test('round midpoint retains strict profile failures', async () => {
  await assert.rejects(
    verifyMidpointProfiles('round', async () => {
      throw new Error('profile failed');
    }),
    /profile failed/,
  );
});

test('final mode observes without invoking convergence or transient effect assertions', async () => {
  const input = options();
  const snapshot = { stillDivergent: true };
  const result = await finishWorkloadBatch(
    { ...input, verifyMode: 'final' },
    {
      observe: async (connections, log, config) => {
        assert.equal(connections, input.connections);
        assert.equal(log, input.log);
        assert.deepEqual(config, { readMediaBytes: false });
        return snapshot;
      },
      converge: () => assert.fail('must not run a round oracle'),
      compareEffects: () =>
        assert.fail('must not assert non-converged effects'),
    },
  );
  assert.equal(result, snapshot);
});

test('round is the default and verifies only this batch after convergence', async () => {
  const snapshot = { converged: true };
  const result = await finishWorkloadBatch(options(), {
    observe: () => assert.fail('round mode uses the converged snapshot'),
    converge: async (config) => {
      assert.equal(config.stableSamples, 2);
      assert.equal(config.enforceCoverage, false);
      return { snapshot };
    },
    compareEffects: (operations, actual) => {
      assert.deepEqual(operations, [{ id: 'new' }]);
      assert.equal(actual, snapshot);
      return { passed: true };
    },
  });
  assert.equal(result, snapshot);
});

test('round mode preserves divergence evidence on effect failure', async () => {
  const snapshot = {};
  const comparison = { passed: false, failures: [{ kind: 'MISSING' }] };
  await assert.rejects(
    finishWorkloadBatch(options(), {
      converge: async () => ({ snapshot }),
      compareEffects: () => comparison,
    }),
    (error) => error.snapshot === snapshot && error.comparison === comparison,
  );
});

test('invalid verification modes are rejected', () => {
  for (const mode of ['', 'off', 'none', 'FINAL'])
    assert.throws(() => assertVerificationMode(mode), /round or final/);
});
