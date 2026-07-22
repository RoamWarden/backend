/** Payload of a signed access token. */
export interface AccessTokenPayload {
  /** User id (uuid). */
  sub: string;
  email: string;
  type: 'access';
  iat?: number;
  exp?: number;
}

/** Payload of a trip-scoped share token (trusted-contact live view). */
export interface TripShareTokenPayload {
  tripId: string;
  scope: 'trip:live';
  /** Trip's share_token_version at issue time; the live view rejects stale versions. */
  v: number;
  iat?: number;
  exp?: number;
}

/** What JwtAuthGuard attaches to request.user / socket.data.user. */
export interface AuthenticatedUser {
  id: string;
  email: string;
}
