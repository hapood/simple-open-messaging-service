import { describe, expect, it } from 'vitest';
import {
  buildCallContent,
  buildFederatedCallContent,
  parseCallContent,
  parseFederatedCallContent,
} from './call-content.js';

describe('CALL content federation projection', () => {
  it('omits identities derived from the outer P2P message', () => {
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
    const wire = buildFederatedCallContent(local!);
    expect(wire).not.toContain('callerId');
    expect(wire).not.toContain('calleeId');
    expect(parseFederatedCallContent(wire)).toEqual({
      callType: 'VIDEO',
      status: 'completed',
      startedAt: 1_000,
      endedAt: 1_500,
    });
  });

  it('rejects local ids and unknown fields on the federation wire', () => {
    expect(
      parseFederatedCallContent(
        JSON.stringify({
          callType: 'AUDIO',
          status: 'missed',
          callerId: 1,
          calleeId: 2,
          endedAt: 1_000,
        }),
      ),
    ).toBeNull();
    expect(
      parseFederatedCallContent(
        JSON.stringify({
          callType: 'AUDIO',
          status: 'missed',
          endedAt: 1_000,
          displayOnly: true,
        }),
      ),
    ).toBeNull();
  });
});
