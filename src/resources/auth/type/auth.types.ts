/** Normalized profile extracted from a verified Google ID token. */
export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  avatarUrl?: string;
  /**
   * Google's `email_verified` claim, carried verbatim from the ID token.
   * UsersService refuses to link this identity onto a pre-existing account
   * unless it is true, so this must never be hardcoded.
   */
  emailVerified: boolean;
}

/** Public user summary returned alongside a fresh token pair. */
export interface AuthUserSummary {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  reputation: number;
}

/** Token pair + user summary returned by register/login. */
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  user: AuthUserSummary;
}

/** Token pair with no user summary — returned by changePassword. */
export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Returned by register: no session is issued until the emailed OTP is verified.
 * The client uses `email` to drive the verify-code screen.
 */
export interface PendingVerification {
  verificationRequired: true;
  email: string;
}

/**
 * A freshly minted app→web hand-off token. The raw token is returned exactly
 * once (only its keyed hash is stored); callers embed it in the account URL and
 * must never log it.
 */
export interface HandoffToken {
  token: string;
  expiresAt: Date;
}
