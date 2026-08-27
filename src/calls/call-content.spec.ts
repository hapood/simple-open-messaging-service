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
        outcome: 'completed',
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
      mediaType: 'VIDEO',
      outcome: 'completed',
      startedAt: 1_000,
      endedAt: 1_500,
    });
  });

  it('rejects local ids and unknown fields on the federation wire', () => {
    expect(
      parseFederatedCallContent(
        JSON.stringify({
          callType: 'AUDIO',
          outcome: 'missed',
          endedAt: 1_000,
        }),
      ),
    ).toBeNull();
    expect(
      parseFederatedCallContent(
        JSON.stringify({
          mediaType: 'AUDIO',
          outcome: 'missed',
          callerId: 1,
          calleeId: 2,
          endedAt: 1_000,
        }),
      ),
    ).toBeNull();
    expect(
      parseFederatedCallContent(
        JSON.stringify({
          mediaType: 'AUDIO',
          outcome: 'missed',
          endedAt: 1_000,
          displayOnly: true,
        }),
      ),
    ).toBeNull();
  });

  it('rejects the retired status field', () => {
    expect(
      parseFederatedCallContent(
        JSON.stringify({
          mediaType: 'AUDIO',
          status: 'missed',
          endedAt: 1_000,
        }),
      ),
    ).toBeNull();
  });

  it('normalizes the retired local status field without accepting it on the federation wire', () => {
    const legacy = JSON.stringify({
      type: 'CALL',
      callType: 'AUDIO',
      status: 'missed',
      callerId: 41,
      calleeId: 92,
      endedAt: 1_000,
    });

    expect(parseCallContent(legacy)).toEqual({
      type: 'CALL',
      callType: 'AUDIO',
      outcome: 'missed',
      callerId: 41,
      calleeId: 92,
      endedAt: 1_000,
    });
    expect(parseFederatedCallContent(legacy)).toBeNull();
  });

  it('rejects ambiguous local CALL content carrying both outcome and status', () => {
    expect(
      parseCallContent(
        JSON.stringify({
          type: 'CALL',
          callType: 'AUDIO',
          outcome: 'missed',
          status: 'missed',
          callerId: 41,
          calleeId: 92,
          endedAt: 1_000,
        }),
      ),
    ).toBeNull();
  });
});
