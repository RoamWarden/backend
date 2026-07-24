import { ReportType } from '@prisma/client';

/** Radius around an incident used to match active trip corridors (metres). */
export const REPORT_ALERT_CORRIDOR_RADIUS_M = 500;

/** Radius around an incident used to alert nearby (possibly stationary) users via Redis GEO (metres). */
export const REPORT_ALERT_PRESENCE_RADIUS_M = 800;

/**
 * Geo-plausibility: a report must be dropped within this distance of the
 * reporter's last known position (when we have one). Build plan §16.
 */
export const REPORT_GEO_PLAUSIBILITY_M = 2000;

/** Arrival geofence: a breadcrumb within this distance of the destination auto-completes the trip. */
export const AUTO_ARRIVAL_RADIUS_M = 150;

/** Max breadcrumbs accepted per batch upload. */
export const TRIP_POINTS_MAX_BATCH = 200;

/** Confirm votes needed to mark a report VERIFIED. */
export const REPORT_VERIFY_THRESHOLD = 3;

/** Deny votes needed (and exceeding confirms) to mark a report REJECTED. */
export const REPORT_REJECT_THRESHOLD = 3;

/** Reporter reputation deltas. */
export const REPUTATION_REPORT_VERIFIED = 2;
export const REPUTATION_REPORT_REJECTED = -5;

/** How long each report type stays live before auto-expiry (seconds). Build plan §16 — expiry keeps the map "now". */
export const REPORT_TTL_S: Record<ReportType, number> = {
  ROBBERY: 4 * 3600,
  HOLD_UP: 4 * 3600,
  ACCIDENT: 4 * 3600,
  CHECKPOINT: 8 * 3600,
  UNREST: 12 * 3600,
  BAD_ROAD: 7 * 24 * 3600,
  LOST_ITEM: 24 * 3600,
  OTHER: 4 * 3600,
};

// ── report clustering auto-verification (build plan §16) ──────────────────

/** Same-type reports within this radius cluster together. */
export const REPORT_CLUSTER_RADIUS_M = 300;

/** Cluster size (incl. the new report) that auto-promotes the cluster to VERIFIED. */
export const REPORT_CLUSTER_VERIFY_THRESHOLD = 3;

// ── no-arrival / stall escalation (build plan §6, §13#4) ──────────────────

/** Grace after the expected arrival time before a trip is considered overdue. */
export const TRIP_OVERDUE_GRACE_S = 5 * 60;

/** Fallback max trip duration when the trip has no expectedDurationS. */
export const TRIP_MAX_DURATION_S = 6 * 3600;

/** No breadcrumb for this long (on a trip already moving) flags a possible stall. */
export const TRIP_STALL_TIMEOUT_S = 20 * 60;

/** A trip must have been active at least this long before a stall can flag it. */
export const TRIP_STALL_MIN_ACTIVE_S = 10 * 60;

/** After the "are you OK?" nudge, wait this long with no check-in before alerting contacts. */
export const TRIP_ESCALATE_AFTER_S = 10 * 60;

// ── password auth ─────────────────────────────────────────────────────────

/** bcrypt cost factor for password hashing. */
export const PASSWORD_BCRYPT_ROUNDS = 12;

/** Minimum password length (also enforced on the DTO). */
export const PASSWORD_MIN_LENGTH = 8;

/** How long a password-reset token stays valid. */
export const PASSWORD_RESET_TTL_S = 60 * 60;

// ── email verification (OTP) ────────────────────────────────────────────────

/** Number of digits in an email-verification code. */
export const EMAIL_OTP_LENGTH = 6;

/** How long a verification code stays valid (10 minutes). */
export const EMAIL_OTP_TTL_S = 10 * 60;

/** Wrong guesses allowed against a single code before it is burned. */
export const EMAIL_OTP_MAX_ATTEMPTS = 5;

/**
 * Minimum seconds between sends for the same account. Guards against email-bomb
 * abuse of resend / repeated unverified logins — a request inside the window is
 * accepted (neutral response) but does not send another code.
 */
export const EMAIL_OTP_RESEND_COOLDOWN_S = 60;

/**
 * Per-email verification-code send quota. Unlike per-IP throttling, this caps
 * how many codes any single address can receive per window regardless of how
 * many IPs a sender uses — the real defence against email-bombing one victim.
 */
export const EMAIL_OTP_MAX_SENDS_PER_WINDOW = 5;
export const EMAIL_OTP_SEND_WINDOW_S = 60 * 60;

/** Default TTLs when env vars are absent. */
export const DEFAULT_JWT_ACCESS_TTL = '15m';
export const DEFAULT_JWT_REFRESH_TTL = '30d';
export const DEFAULT_TRIP_SHARE_TOKEN_TTL = '24h';

/** Directions responses are cached this long (cost control, build plan §11). */
export const DIRECTIONS_CACHE_TTL_S = 3600;
