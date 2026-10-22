/**
 * Raw SQL executed through Drizzle does not apply schema column mappers. Keep
 * driver-value conversion explicit at that boundary for queries that cannot
 * reasonably be expressed with the schema-aware query builder.
 */
export function rawDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new TypeError(`${field} is not a valid database timestamp`);
  return parsed;
}

export function rawBigInt(value: string, field: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new TypeError(`${field} is not a valid database bigint`);
  }
}
