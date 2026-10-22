import type { ProfiledAddress } from '../../shared/profiled-address.js';
import type { OrdinarySystemMessageContent } from '../../shared/system-message-content.js';

export {
  SystemMessageType,
  parseSystemMessageContent,
  stringifySystemMessageContent,
} from '../../shared/system-message-content.js';
export type { OrdinarySystemMessageContent } from '../../shared/system-message-content.js';

/** Writers must capture participant identities and revisions at the event boundary. */
export type SystemMessageInput = OrdinarySystemMessageContent<ProfiledAddress>;
