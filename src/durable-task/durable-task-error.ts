export function safeUnexpectedTaskError(error: unknown): string {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
      ? error.name
      : 'UnknownError';
  const code = readSafeErrorCode(error);
  return code
    ? `Unexpected task error (${name}, code ${code})`
    : `Unexpected task error (${name})`;
}

export interface UnexpectedTaskDatabaseDiagnostics {
  code: string;
  severity?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
  routine?: string;
  detail?: string;
  hint?: string;
  where?: string;
}

export interface UnexpectedTaskErrorCauseDiagnostics {
  name: string;
  message: string;
  code?: string;
}

export interface UnexpectedTaskDiagnostics {
  causes: UnexpectedTaskErrorCauseDiagnostics[];
  database?: UnexpectedTaskDatabaseDiagnostics;
}

/** Build bounded structured diagnostics for the server log. The durable task's client-visible
 * lastError continues to use safeUnexpectedTaskError and never receives these details. */
export function unexpectedTaskDiagnostics(
  error: unknown,
): UnexpectedTaskDiagnostics {
  const causes = causalObjects(error).map((cause) => {
    const code = safeErrorCode(cause.code);
    return {
      name: safeErrorName(cause),
      message: safeDiagnosticText(cause.message) ?? '',
      ...(code ? { code } : {}),
    };
  });
  if (causes.length === 0) {
    causes.push({
      name: 'UnknownError',
      message: safeDiagnosticText(String(error)) ?? '',
    });
  }
  const databaseError = findCausalError(error, (candidate) =>
    /^[0-9A-Z]{5}$/.test(candidate.code),
  );
  return {
    causes,
    ...(databaseError ? { database: databaseDiagnostics(databaseError) } : {}),
  };
}

function databaseDiagnostics(
  databaseError: Record<string, unknown> & { code: string },
): UnexpectedTaskDatabaseDiagnostics {
  const code = databaseError.code;
  const diagnostics: UnexpectedTaskDatabaseDiagnostics = { code };
  for (const field of [
    'severity',
    'schema',
    'table',
    'column',
    'dataType',
    'constraint',
    'routine',
  ] as const) {
    const value = safeDiagnosticText(databaseError[field]);
    if (value !== undefined) diagnostics[field] = value;
  }
  if (['08', '40', '53', '55', '57', '58'].includes(code.slice(0, 2))) {
    for (const field of ['detail', 'hint', 'where'] as const) {
      const value = safeDiagnosticText(databaseError[field]);
      if (value !== undefined) diagnostics[field] = value;
    }
  }
  return diagnostics;
}

function readSafeErrorCode(error: unknown): string | undefined {
  return findCausalError(error, () => true)?.code;
}

function findCausalError(
  error: unknown,
  accepted: (candidate: Record<string, unknown> & { code: string }) => boolean,
): (Record<string, unknown> & { code: string }) | undefined {
  for (const current of causalObjects(error)) {
    const code = safeErrorCode(current.code);
    if (code) {
      const candidate = { ...current, code };
      if (accepted(candidate)) return candidate;
    }
  }
  return undefined;
}

function causalObjects(error: unknown): Record<string, unknown>[] {
  const causes: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current = error;
  while (
    current !== null &&
    typeof current === 'object' &&
    causes.length < 8 &&
    !seen.has(current)
  ) {
    seen.add(current);
    causes.push(current as Record<string, unknown>);
    current = 'cause' in current ? current.cause : undefined;
  }
  return causes;
}

function safeErrorName(error: Record<string, unknown>): string {
  return typeof error.name === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
    ? error.name
    : 'UnknownError';
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value)
    ? value
    : undefined;
}

function safeDiagnosticText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, 4096);
}
