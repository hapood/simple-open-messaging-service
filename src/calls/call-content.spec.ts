import { describe, expect, it } from 'vitest';
import {
  buildCallContent,
  buildFederatedCallContent,
  parseCallContent,
  parseFederatedCallContent,
} from './call-content.js';

describe('CALL content federation projection', () => {
  it('replaces local numeric ids with stable addresses', () => {
    const local = parseCallContent(
      buildCallContent({
        callType: 'VIDEO',
        status: 'completed',
        callerId: 41,
        calleeId: 92,
        startedAt: 1_000,
        endedAt: 1_500,
        durationMs: 500,
      }),
    );
    expect(local).not.toBeNull();
    const wire = buildFederatedCallContent(
      local!,
      { account: 'alice', domain: 'a.example' },
      { account: 'bob', domain: 'b.example' },
    );
    expect(wire).not.toContain('callerId');
    expect(wire).not.toContain('calleeId');
    expect(parseFederatedCallContent(wire)).toEqual({
      type: 'CALL',
      callType: 'VIDEO',
      status: 'completed',
      caller: { account: 'alice', domain: 'a.example' },
      callee: { account: 'bob', domain: 'b.example' },
      startedAt: 1_000,
      endedAt: 1_500,
      durationMs: 500,
    });
  });

  it('rejects local ids and unknown fields on the federation wire', () => {
    expect(
      parseFederatedCallContent(
        JSON.stringify({
          type: 'CALL',
          callType: 'AUDIO',
          status: 'missed',
          callerId: 1,
          calleeId: 2,
        }),
      ),
    ).toBeNull();
    expect(
      parseFederatedCallContent(
        JSON.stringify({
          type: 'CALL',
          callType: 'AUDIO',
          status: 'missed',
          caller: { account: 'alice', domain: 'a.example' },
          callee: { account: 'bob', domain: 'b.example' },
          displayOnly: true,
        }),
      ),
    ).toBeNull();
  });
});
