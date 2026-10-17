const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;

/** JSON cannot encode bigint. Private snapshot references use exact decimal strings. */
export function forwardBundleStorageReference(id: bigint): string {
  if (id < 1n || id > MAX_DATABASE_ID)
    throw new Error('invalid local forward bundle id');
  return id.toString();
}

/** This is a private storage coordinate, never a client or federation bundle identity. */
export function parseForwardBundleStorageReference(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(value))
    throw new Error('invalid local forward bundle reference');
  const id = BigInt(value);
  if (id > MAX_DATABASE_ID)
    throw new Error('invalid local forward bundle reference');
  return id;
}
