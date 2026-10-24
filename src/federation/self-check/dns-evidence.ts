import { resolveCname, resolve4, resolve6 } from 'node:dns/promises';

/**
 * CNAME chains are followed explicitly so diagnostics can display them.
 * The DNS protocol sets no hard limit on chain length; resolver
 * implementations commonly cap chains at 8-16 hops to break loops, and this
 * walker uses the same order of magnitude.
 */
export const MAX_CNAME_DEPTH = 8;

interface CnameHop {
  name: string;
  targets: string[];
}

export interface ResolvedDnsView {
  /** The name the A/AAAA queries were sent for, after following the chain. */
  host: string;
  v4: string[];
  v6: string[];
  cnameChain: CnameHop[];
  /** Raw resolver failure codes, reported verbatim instead of being masked. */
  errors: { chain?: string; v4?: string; v6?: string };
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && code) return code;
  return error instanceof Error ? error.message : 'UNKNOWN';
}

function isTerminalCnameAnswer(code: string): boolean {
  // ENODATA: the name exists but has no CNAME record.
  // ENOTFOUND: the name does not exist; the subsequent A/AAAA queries will
  // surface the same verdict, so the chain walk itself stays silent.
  return code === 'ENODATA' || code === 'ENOTFOUND';
}

/**
 * Resolves a federation endpoint the way a raw DNS client sees it. The CNAME
 * chain is walked hop by hop (resolveCname only ever exposes the next hop)
 * and the final name is resolved for both address families. Terminal CNAME
 * answers end the walk; every other failure code is preserved verbatim.
 */
export async function resolveDnsEvidence(
  host: string,
): Promise<ResolvedDnsView> {
  const cnameChain: CnameHop[] = [];
  const errors: ResolvedDnsView['errors'] = {};
  const seen = new Set([host.toLowerCase()]);
  let current = host;
  for (let depth = 0; depth < MAX_CNAME_DEPTH; depth += 1) {
    let targets: string[];
    try {
      targets = await resolveCname(current);
    } catch (error) {
      const code = errorCode(error);
      if (!isTerminalCnameAnswer(code)) errors.chain = code;
      break;
    }
    if (!targets.length) break;
    cnameChain.push({ name: current, targets });
    const next = targets[0];
    if (seen.has(next.toLowerCase())) {
      errors.chain = 'CNAME_LOOP';
      break;
    }
    seen.add(next.toLowerCase());
    current = next;
  }
  if (cnameChain.length === MAX_CNAME_DEPTH && !errors.chain)
    errors.chain = 'CNAME_DEPTH_EXCEEDED';
  const [v4, v6] = await Promise.all([
    resolve4(current).catch((error: unknown) => {
      errors.v4 = errorCode(error);
      return [] as string[];
    }),
    resolve6(current).catch((error: unknown) => {
      errors.v6 = errorCode(error);
      return [] as string[];
    }),
  ]);
  return { host: current, v4, v6, cnameChain, errors };
}
