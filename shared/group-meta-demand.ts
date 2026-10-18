/** Closed client demand for one visible group's Meta feed. Either coordinate
 * form is complete on its own; optional-field mixes are invalid demands. The
 * server parses this shape at the query boundary and clients construct it
 * from the same shared type, so the two ends cannot drift apart. */
export type GroupMetaFeedDemand =
  | { threadId: number }
  | { account: string; namespaceId: number };

export class GroupMetaDemandParseError extends Error {
  constructor(message = 'invalid group meta feed demand') {
    super(message);
    this.name = 'GroupMetaDemandParseError';
  }
}

/** Parse the closed group-meta demand at an untrusted boundary. Values may
 * arrive as numbers (JSON) or decimal strings (query parameters); every other
 * shape, including a mix of both coordinate forms, is rejected. */
export function parseGroupMetaFeedDemand(
  value: unknown,
): GroupMetaFeedDemand {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GroupMetaDemandParseError('demand must be an object');
  const demand = value as Record<string, unknown>;
  const keys = Object.keys(demand).sort();
  const has = (key: string) => Object.hasOwn(demand, key);

  if (keys.join(',') === 'threadId') {
    return { threadId: positiveInteger(demand['threadId'], 'threadId') };
  }
  if (keys.join(',') === 'account,namespaceId') {
    const account = demand['account'];
    if (typeof account !== 'string' || account.length === 0)
      throw new GroupMetaDemandParseError('account must be a nonempty string');
    return {
      account,
      namespaceId: nonnegativeInteger(
        demand['namespaceId'],
        'namespaceId',
      ),
    };
  }
  throw new GroupMetaDemandParseError(
    'exactly one demand is required: threadId, or account with namespaceId',
  );
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = coordinate(value, name);
  if (parsed < 1)
    throw new GroupMetaDemandParseError(`${name} must be positive`);
  return parsed;
}

function nonnegativeInteger(value: unknown, name: string): number {
  const parsed = coordinate(value, name);
  if (parsed > 2_147_483_647)
    throw new GroupMetaDemandParseError(
      `${name} exceeds the supported range`,
    );
  return parsed;
}

function coordinate(value: unknown, name: string): number {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))
    value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new GroupMetaDemandParseError(
      `${name} must be a non-negative integer`,
    );
  return value;
}
