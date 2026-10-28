/** Load status as a const object so it can be used as a VALUE in templates and as a TYPE.
 *  Standalone so pure projections (e.g. the playground mock) can consume it without
 *  pulling the thread-store service graph. */
export const ConversationLoadStatus = {
  LOADING: 'LOADING',
  READY: 'READY',
  ERROR: 'ERROR',
} as const;
export type ConversationLoadStatus =
  (typeof ConversationLoadStatus)[keyof typeof ConversationLoadStatus];
