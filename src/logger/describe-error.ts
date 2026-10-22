/** Bounded diagnostic projection: never copy request, response, headers or arbitrary
 * properties from transport errors. Redact credentials embedded in diagnostic text. */
export function describeError(value: unknown): Record<string, unknown> {
  const seen = new Set<unknown>();
  let remaining = 16;
  const text = (s: string) =>
    s
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/([?&][^\s=&#]+)=([^\s&#]*)/g, '$1=[REDACTED]')
      .replace(
        /\b(authorization|cookie|password|secret|token)\s*[:=]\s*[^\r\n]*/gi,
        '$1=[REDACTED]',
      )
      .slice(0, 4096);
  const visit = (error: unknown, depth: number): Record<string, unknown> => {
    if (depth >= 5 || remaining-- <= 0) return { truncated: true };
    if (seen.has(error)) return { circular: true };
    if (!(error instanceof Error))
      return {
        name: 'NonErrorThrown',
        message:
          typeof error === 'string' ? text(error) : 'Non-error value thrown',
      };
    seen.add(error);
    const result: Record<string, unknown> = {
      name: text(error.name),
      message: text(error.message),
      stack: error.stack ? text(error.stack) : undefined,
    };
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number')
      result.code = typeof code === 'string' ? text(code) : code;
    if (error.cause !== undefined) result.cause = visit(error.cause, depth + 1);
    if (error instanceof AggregateError)
      result.errors = error.errors
        .slice(0, 5)
        .map((child: unknown) => visit(child, depth + 1));
    return result;
  };
  return visit(value, 0);
}
