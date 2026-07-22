/**
 * Redis pub/sub payload shapes relayed by the gateway. They mirror the
 * message contracts in docs/CONTRACT.md (published by the alerts, sos and
 * trips modules) — if a shape must change, change the contract first.
 *
 * The guards below are deliberately lenient: they verify only the fields the
 * gateway needs to route a message. A malformed payload is logged and skipped
 * by the caller (never thrown), so one bad publisher cannot take the bridge
 * down.
 */

/** Anonymized report embedded in an incident alert — NEVER carries a reporter id. */
export interface AlertIncidentReport {
  id: string;
  type: string;
  lat: number;
  lng: number;
  note: string | null;
  status: string;
  confirmCount: number;
  denyCount: number;
  createdAt: string;
  expiresAt: string;
}

/** Published by the alerts module on CHANNEL_ALERT_INCIDENT. */
export interface AlertIncidentMessage {
  report: AlertIncidentReport;
  /** All affected users — each gateway instance emits to the rooms it hosts. */
  userIds: string[];
  tripIdByUserId?: Record<string, string>;
}

/** Published by the sos module on CHANNEL_SOS. */
export interface SosRaisedMessage {
  sosId: string;
  user: { id: string; name: string };
  tripId?: string;
  lat?: number;
  lng?: number;
  message?: string;
  contactUserIds: string[];
  /** ISO-8601. */
  raisedAt: string;
}

/** Published by the trips module on channelTripLive(tripId). */
export interface TripLivePositionMessage {
  kind: 'position';
  tripId: string;
  point: {
    lat: number;
    lng: number;
    speed?: number | null;
    heading?: number | null;
    recordedAt?: string;
  };
}

/** Published by the trips/sos modules on channelTripLive(tripId). */
export interface TripLiveStatusMessage {
  kind: 'status';
  tripId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'SOS';
  endedAt?: string;
  durationS?: number;
  /** Optional — when present the status is also emitted to the owner's room. */
  ownerId?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAlertIncidentMessage(
  value: unknown,
): value is AlertIncidentMessage {
  if (!isRecord(value)) return false;
  return (
    isRecord(value.report) &&
    typeof value.report.id === 'string' &&
    Array.isArray(value.userIds) &&
    value.userIds.every((id) => typeof id === 'string') &&
    (value.tripIdByUserId === undefined || isRecord(value.tripIdByUserId))
  );
}

export function isSosRaisedMessage(value: unknown): value is SosRaisedMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.sosId === 'string' &&
    isRecord(value.user) &&
    typeof value.user.id === 'string' &&
    Array.isArray(value.contactUserIds) &&
    value.contactUserIds.every((id) => typeof id === 'string')
  );
}
