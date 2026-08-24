export interface DirectTlsPaths {
  cert: string;
  key: string;
}

/**
 * Resolve TLS files for deployments where Fastify itself is the public edge.
 * A partial pair is always a configuration error: silently falling back to
 * plaintext would make an operator believe TLS is enabled when it is not.
 */
export function resolveDirectTlsPaths(env: {
  TLS_CERT?: string;
  TLS_KEY?: string;
}): DirectTlsPaths | undefined {
  const cert = env.TLS_CERT;
  const key = env.TLS_KEY;

  if (!cert && !key) return undefined;

  if (!cert || !key) {
    throw new Error(
      'TLS_CERT and TLS_KEY must be configured together, or both left unset',
    );
  }

  return { cert, key };
}
