import { Logger } from '@nestjs/common';
import type { FederationMessageQueryPage } from './federation-message-feed.service.js';
import type { FederationReverseThreadSource } from './federation-reverse-thread-source.js';

const logger = new Logger('FederationMirrorMessageFilter');

// Reject unexpected mirror authors before any FORWARD closure or media is fetched.
// The validated page boundary remains unchanged, so skipped copies are scannable holes.
export function filterMirrorMessagePage(
  source: FederationReverseThreadSource,
  page: FederationMessageQueryPage,
): FederationMessageQueryPage {
  if (source.kind !== 'GROUP' || !source.localGroupAuthority) return page;
  return {
    ...page,
    messages: page.messages.filter((item) => {
      if (
        'author' in item &&
        (item.author?.domain === source.peerDomain ||
          item.author?.domain === 'local')
      )
        return true;
      logger.warn(
        `ignored mirror message (FEDERATION_MALFORMED): ${JSON.stringify({
          peerDomain: source.peerDomain,
          threadId: source.threadId,
          seq: item.seq,
          reason: 'group mirror may only submit its locally managed authors',
        })}`,
      );
      return false;
    }),
  };
}
