import type { ReportStatus, ReportType } from '@prisma/client';

/** Shape of one row from the corridor-match raw query. */
export interface CorridorMatchRow {
  trip_id: string;
  user_id: string;
}

/**
 * Fan-out payload published on CHANNEL_ALERT_INCIDENT (docs/CONTRACT.md —
 * AlertsModule). The gateway emits `alert:incident` to the per-user rooms it
 * hosts. The reporter's identity is NEVER included (privacy §17).
 */
export interface AlertIncidentMessage {
  report: {
    id: string;
    type: ReportType;
    lat: number;
    lng: number;
    note: string | null;
    status: ReportStatus;
    confirmCount: number;
    denyCount: number;
    /** ISO 8601. */
    createdAt: string;
    /** ISO 8601. */
    expiresAt: string;
  };
  /** All affected userIds (gateway emits to those it hosts). */
  userIds: string[];
  /** For corridor-matched users: which of their trips the incident threatens. */
  tripIdByUserId?: Record<string, string>;
}
