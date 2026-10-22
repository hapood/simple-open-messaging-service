import { request } from '@/api/client';
import type {
  BreakerStatus,
  Breakers,
  ContinueQuotaInput,
  QuotaNode,
  QuotaOverrides,
} from '@/types/api';

/** List every federated peer with today's quota usage and limits. */
export function getQuotaNodes(): Promise<QuotaNode[]> {
  return request<QuotaNode[]>('/admin/quota/nodes');
}

/** Set a node's per-category overrides (a null field = use the global default). `domain` is a single
 *  path segment (dots are fine; never a slash). */
export function setQuotaNodeLimits(
  domain: string,
  overrides: QuotaOverrides,
): Promise<void> {
  return request<void>(
    `/admin/quota/nodes/${encodeURIComponent(domain)}`,
    overrides,
  );
}

/** All currently-tripped circuit breakers (federation peers + local users). */
export function getBreakers(): Promise<Breakers> {
  return request<Breakers>('/admin/quota/breakers');
}

/** Add today's additive quota to a tripped federated peer; clears its breaker if within limits. */
export function continuePeer(
  domain: string,
  input: ContinueQuotaInput,
): Promise<BreakerStatus> {
  return request<BreakerStatus>(
    `/admin/quota/nodes/${encodeURIComponent(domain)}/continue`,
    input,
  );
}

/** Add today's additive quota to a tripped local user; clears its breaker if within limits. */
export function continueUser(
  userId: number,
  input: ContinueQuotaInput,
): Promise<BreakerStatus> {
  return request<BreakerStatus>(
    `/admin/users/${userId}/quota/continue`,
    input,
  );
}
