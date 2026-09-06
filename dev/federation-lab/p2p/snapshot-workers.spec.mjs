import assert from 'node:assert/strict';
import test from 'node:test';
import { readFederationAuditSnapshot } from './final-audit.mjs';
import { federationLabNodes } from '../topology.mjs';

test('uses three concurrent workers, each with sequential queries in a repeatable-read snapshot', async () => {
  const events = [];
  const connections = new Map(
    federationLabNodes.map((node) => {
      let busy = false;
      return [
        node.name,
        {
          node,
          client: {
            async query(sql) {
              assert.equal(busy, false);
              busy = true;
              events.push({ node: node.name, sql });
              await new Promise((resolve) => setImmediate(resolve));
              busy = false;
              return { rows: [] };
            },
          },
        },
      ];
    }),
  );
  const result = await readFederationAuditSnapshot(connections, {
    users: [],
    groups: [],
    operations: [],
  });
  assert.equal(Object.keys(result.p2pMessages).length, 3);
  assert.ok(
    events
      .slice(0, 3)
      .every(
        ({ sql }) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      ),
  );
  for (const node of federationLabNodes)
    assert.equal(
      events.filter((event) => event.node === node.name).at(-1).sql,
      'COMMIT',
    );
});
