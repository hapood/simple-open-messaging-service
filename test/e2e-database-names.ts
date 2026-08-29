const RUN_ID_ENV = 'SOMS_E2E_RUN_ID';

export function e2eRunId(): string {
  const runId = process.env[RUN_ID_ENV];
  if (!runId || !/^[a-z0-9]+$/.test(runId)) {
    throw new Error(
      `${RUN_ID_ENV} must be set to a non-empty lowercase alphanumeric value`,
    );
  }
  return runId;
}

export function e2eTemplateDatabaseName(): string {
  return `soms_test_${e2eRunId()}`;
}

export function e2eWorkerDatabaseName(
  poolId: string,
  node?: 'a' | 'b',
): string {
  const base = `${e2eTemplateDatabaseName()}_fork${poolId}`;
  return node ? `${base}_${node}` : base;
}
