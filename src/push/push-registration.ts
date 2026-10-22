import { sessionToken } from '../database/schema.js';

/** A projection, never a separate registration store. IDs are session IDs. */
export const pushRegistrationFields = {
  id: sessionToken.id,
  sessionId: sessionToken.id,
  userId: sessionToken.userId,
  pushSubscriptionRev: sessionToken.pushSubscriptionRev,
  token: sessionToken.pushToken,
  platform: sessionToken.pushPlatform,
  deviceId: sessionToken.pushDeviceId,
  webP256dh: sessionToken.pushP256dh,
  webAuth: sessionToken.pushAuth,
  createdAt: sessionToken.createdAt,
  lastSeenAt: sessionToken.pushRegisteredAt,
  expiresAt: sessionToken.expiresAt,
  revokedAt: sessionToken.revokedAt,
};

export const clearPushRegistration = {
  pushToken: null,
  pushPlatform: null,
  pushDeviceId: null,
  pushP256dh: null,
  pushAuth: null,
  pushRegisteredAt: null,
} as const;
