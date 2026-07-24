/** Normalized profile extracted from a verified Google ID token. */
export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  avatarUrl?: string;
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
