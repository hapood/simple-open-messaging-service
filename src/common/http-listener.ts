import { mkdir, lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

/** The Docker supervisor opts into a private Unix listener; standalone development retains TCP. */
export function backendSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const path = env.SOMS_BACKEND_SOCKET?.trim();
  if (!path) return undefined;
  if (
    !isAbsolute(path) ||
    Buffer.byteLength(path) > 100 ||
    /[\s\x00]/.test(path)
  ) {
    throw new Error(
      'SOMS_BACKEND_SOCKET must be an absolute Unix socket path of at most 100 bytes without whitespace',
    );
  }
  if (env.TLS_CERT || env.TLS_KEY)
    throw new Error('Unix backend sockets require plaintext HTTP behind Caddy');
  return path;
}

export async function prepareBackendSocket(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Never unlink another listener. The supervisor removes a stale socket only before starting Node.
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing) throw new Error(`Backend socket already exists: ${path}`);
}

/** Unix connections have no IP peer. Trust only the immediate hop, never forwarded chain entries. */
export function listenerProxyTrust(
  socketPath: string | undefined,
  trustedTcp: (address: string) => boolean,
) {
  return (address: string | undefined, hop: number): boolean =>
    socketPath
      ? hop === 0 && address === undefined
      : Boolean(address && trustedTcp(address));
}
