import { isValidLat, isValidLng } from '../../common/utils/geo.util';

/**
 * Manual WS payload validation. The global HTTP ValidationPipe does not run
 * for gateway messages, so every client→server event payload is checked here
 * and rejected with a human-readable, actionable error string returned in the
 * ack (never a silent drop, never a crash on garbage input).
 */

export type WsValidation<T> =
  { ok: true; value: T } | { ok: false; error: string };

export interface WsTripPoint {
  lat: number;
  lng: number;
  speed?: number;
  heading?: number;
  /** Normalized to ISO-8601 when the client provided a timestamp. */
  recordedAt?: string;
}

export interface WsTripLocationPayload {
  tripId: string;
  points: WsTripPoint[];
}

export interface WsTripSubscribePayload {
  tripId: string;
  shareToken?: string;
}

export interface WsTripUnsubscribePayload {
  tripId: string;
}

const fail = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTripId(payload: Record<string, unknown>): string | null {
  const tripId = payload.tripId;
  return typeof tripId === 'string' && tripId.trim().length > 0 ? tripId : null;
}

export function validateTripLocationPayload(
  payload: unknown,
  maxPoints: number,
): WsValidation<WsTripLocationPayload> {
  if (!isRecord(payload)) {
    return fail(
      'Invalid payload — send an object like { tripId, points: [{ lat, lng }] }.',
    );
  }
  const tripId = readTripId(payload);
  if (!tripId) {
    return fail('tripId is required — send the id of your active trip.');
  }
  const rawPoints = payload.points;
  if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
    return fail('points must be a non-empty array of { lat, lng } locations.');
  }
  if (rawPoints.length > maxPoints) {
    return fail(
      `Too many points in one message (${rawPoints.length}) — send at most ${maxPoints} here, or use POST /trips/:id/points for larger batches.`,
    );
  }

  const points: WsTripPoint[] = [];
  for (let i = 0; i < rawPoints.length; i++) {
    const raw: unknown = rawPoints[i];
    if (!isRecord(raw)) {
      return fail(
        `points[${i}] must be an object like { lat, lng, speed?, heading?, recordedAt? }.`,
      );
    }
    const { lat, lng, speed, heading, recordedAt } = raw;
    if (typeof lat !== 'number' || !isValidLat(lat)) {
      return fail(
        `points[${i}].lat is invalid — latitude must be a number between -90 and 90.`,
      );
    }
    if (typeof lng !== 'number' || !isValidLng(lng)) {
      return fail(
        `points[${i}].lng is invalid — longitude must be a number between -180 and 180.`,
      );
    }
    const point: WsTripPoint = { lat, lng };
    if (speed !== undefined && speed !== null) {
      if (typeof speed !== 'number' || !Number.isFinite(speed)) {
        return fail(
          `points[${i}].speed is invalid — send a finite number (m/s) or omit it.`,
        );
      }
      point.speed = speed;
    }
    if (heading !== undefined && heading !== null) {
      if (typeof heading !== 'number' || !Number.isFinite(heading)) {
        return fail(
          `points[${i}].heading is invalid — send a finite number (degrees) or omit it.`,
        );
      }
      point.heading = heading;
    }
    if (recordedAt !== undefined && recordedAt !== null) {
      if (typeof recordedAt !== 'string' && typeof recordedAt !== 'number') {
        return fail(
          `points[${i}].recordedAt is invalid — send an ISO-8601 string (or epoch ms) or omit it.`,
        );
      }
      const parsed = new Date(recordedAt);
      if (Number.isNaN(parsed.getTime())) {
        return fail(
          `points[${i}].recordedAt is not a valid timestamp — send an ISO-8601 string (or epoch ms) or omit it.`,
        );
      }
      point.recordedAt = parsed.toISOString();
    }
    points.push(point);
  }

  return { ok: true, value: { tripId, points } };
}

export function validateTripSubscribePayload(
  payload: unknown,
): WsValidation<WsTripSubscribePayload> {
  if (!isRecord(payload)) {
    return fail(
      'Invalid payload — send an object like { tripId, shareToken? }.',
    );
  }
  const tripId = readTripId(payload);
  if (!tripId) {
    return fail('tripId is required — send the id of the trip to watch.');
  }
  const { shareToken } = payload;
  if (shareToken === undefined || shareToken === null) {
    return { ok: true, value: { tripId } };
  }
  if (typeof shareToken !== 'string' || shareToken.trim().length === 0) {
    return fail(
      'shareToken must be a non-empty string when provided — omit it to rely on your own access.',
    );
  }
  return { ok: true, value: { tripId, shareToken } };
}

export function validateTripUnsubscribePayload(
  payload: unknown,
): WsValidation<WsTripUnsubscribePayload> {
  if (!isRecord(payload)) {
    return fail('Invalid payload — send an object like { tripId }.');
  }
  const tripId = readTripId(payload);
  if (!tripId) {
    return fail(
      'tripId is required — send the id of the trip to stop watching.',
    );
  }
  return { ok: true, value: { tripId } };
}
