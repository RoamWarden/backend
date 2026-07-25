export const REFRESH_TOKEN_BYTES = 48;
export const SHARE_TOKEN_SCOPE = 'trip:live';

/** Random bytes behind a password-reset token (base64url-encoded in the link). */
export const PASSWORD_RESET_TOKEN_BYTES = 32;

/**
 * Random bytes behind an app→web hand-off token (base64url-encoded in the URL).
 * Same width as a refresh token — it buys a full session, so it must be just as
 * unguessable.
 */
export const HANDOFF_TOKEN_BYTES = 48;

/**
 * Upper bound on an accepted hand-off token string. A 48-byte base64url token is
 * 64 chars; the cap keeps absurd payloads out of the HMAC/Redis path.
 */
export const HANDOFF_TOKEN_MAX_LENGTH = 256;
