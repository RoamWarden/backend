/** FCM hard limit on tokens per multicast request. */
export const FCM_MULTICAST_MAX_TOKENS = 500;

/** FCM error codes that mean the token is dead and must be pruned. */
export const DEAD_TOKEN_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
]);
