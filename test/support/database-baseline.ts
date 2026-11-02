/** Restore the migration-owned identity after test-only account truncation.
 * RESTART IDENTITY followed by this insert preserves the seeded system ID before
 * any ordinary account is created, including for already-running app processes. */
export const RESTORE_SYSTEM_ACCOUNT_SQL = `
  INSERT INTO "Account" (account, "namespaceId", "disabledAt")
  VALUES ('$system', 0, CURRENT_TIMESTAMP)
  ON CONFLICT (account) DO NOTHING
`;
