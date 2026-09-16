import { Injectable } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { RemoteGroupMetaCursorUnavailableError } from './federation-feed-cursor-error.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationHttpScheduler } from './federation-http-scheduler.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';
import type { GroupMetaFeedPage } from './group-meta-feed.service.js';

const PAGE_TAKE = 100;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface FederationGroupMetaPageRequest {
  account: string;
  mode: 'full' | 'delta';
  after: number;
  through: number;
}

/** Fetches and validates one bounded Group Meta page. Durable progress and
 * page application belong to the caller's round transaction. */
@Injectable()
export class FederationGroupMetaClient {
  constructor(
    private readonly trustedPeers: FederationTrustedPeerClient,
    private readonly httpScheduler: FederationHttpScheduler,
  ) {}

  async fetchPage(
    peerDomain: string,
    request: FederationGroupMetaPageRequest,
  ): Promise<GroupMetaFeedPage> {
    if (
      !Number.isSafeInteger(request.after) ||
      !Number.isSafeInteger(request.through) ||
      request.after < 0 ||
      request.through < request.after
    )
      throw new Error('invalid bounded group-meta request');
    const query = new URLSearchParams({
      account: request.account,
      mode: request.mode,
      after: request.after.toString(),
      take: PAGE_TAKE.toString(),
      through: request.through.toString(),
    });
    let page: GroupMetaFeedPage;
    try {
      page = await this.httpScheduler.runWithRetry(
        peerDomain,
        `group-meta ${request.account}`,
        () =>
          this.trustedPeers.get<GroupMetaFeedPage>(
            `/s2s/v1/group-meta?${query.toString()}`,
            peerDomain,
            MAX_RESPONSE_BYTES,
          ),
      );
    } catch (error) {
      throw mapCursorUnavailable(error);
    }
    validatePage(request, page);
    return page;
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}

function validatePage(
  request: FederationGroupMetaPageRequest,
  page: GroupMetaFeedPage,
): void {
  if (
    page === null ||
    typeof page !== 'object' ||
    page.account !== request.account ||
    page.mode !== request.mode ||
    !Array.isArray(page.items) ||
    typeof page.hasMore !== 'boolean' ||
    !isNonNegativeSafeInteger(page.scannedThrough) ||
    !isNonNegativeSafeInteger(page.groupMetaFeedEndId)
  )
    throw new Error('invalid group-meta page envelope');
  const scannedThrough = page.scannedThrough;
  const sourceEnd = page.groupMetaFeedEndId;
  const scanEnd = sourceEnd < request.through ? sourceEnd : request.through;
  if (
    scannedThrough < request.after ||
    scannedThrough > scanEnd ||
    (page.hasMore && scannedThrough === request.after) ||
    page.hasMore !== scannedThrough < scanEnd
  )
    throw new Error('invalid group-meta page boundary');
  let previous = request.after;
  for (const item of page.items) {
    if (
      !Number.isSafeInteger(item.feedId) ||
      item.feedId <= 0 ||
      item.feedId <= previous ||
      item.feedId > scannedThrough
    )
      throw new Error('unordered group-meta page items');
    previous = item.feedId;
  }
}

function mapCursorUnavailable(error: unknown): Error {
  if (
    !(error instanceof S2sResponseError) ||
    error.code !== BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE
  )
    return error instanceof Error ? error : new Error(String(error));
  const data = error.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return new Error('invalid group-meta recovery window');
  const resumeAfter = (data as Record<string, unknown>)['resumeAfter'];
  const resumeBefore = (data as Record<string, unknown>)['resumeBefore'];
  if (
    !isNonNegativeSafeInteger(resumeAfter) ||
    !isNonNegativeSafeInteger(resumeBefore) ||
    resumeBefore <= resumeAfter
  )
    return new Error('invalid group-meta recovery window');
  return new RemoteGroupMetaCursorUnavailableError(
    resumeAfter,
    resumeBefore,
  );
}
