import {
  validateTripLocationPayload,
  validateTripSubscribePayload,
  validateTripUnsubscribePayload,
} from './ws-validation';

const MAX_POINTS = 50;

describe('validateTripLocationPayload', () => {
  it('accepts a well-formed payload and returns the normalized value', () => {
    const result = validateTripLocationPayload(
      { tripId: 'trip-1', points: [{ lat: 6.5, lng: 3.3 }] },
      MAX_POINTS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tripId).toBe('trip-1');
      expect(result.value.points).toEqual([{ lat: 6.5, lng: 3.3 }]);
    }
  });

  it('accepts optional speed, heading and normalizes recordedAt to ISO-8601', () => {
    const result = validateTripLocationPayload(
      {
        tripId: 'trip-1',
        points: [
          {
            lat: 6.5,
            lng: 3.3,
            speed: 12,
            heading: 90,
            recordedAt: '2026-07-22T10:00:00.000Z',
          },
        ],
      },
      MAX_POINTS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.points[0]).toEqual({
        lat: 6.5,
        lng: 3.3,
        speed: 12,
        heading: 90,
        recordedAt: '2026-07-22T10:00:00.000Z',
      });
    }
  });

  it('accepts an epoch-ms recordedAt and normalizes it to an ISO string', () => {
    const epoch = Date.UTC(2026, 6, 22, 10, 0, 0);
    const result = validateTripLocationPayload(
      { tripId: 'trip-1', points: [{ lat: 6.5, lng: 3.3, recordedAt: epoch }] },
      MAX_POINTS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.points[0].recordedAt).toBe(
        new Date(epoch).toISOString(),
      );
    }
  });

  it('rejects a non-object payload with a clear error', () => {
    const result = validateTripLocationPayload('nope', MAX_POINTS);
    expect(result).toEqual({
      ok: false,
      error:
        'Invalid payload — send an object like { tripId, points: [{ lat, lng }] }.',
    });
  });

  it('rejects an array payload (not a plain object)', () => {
    const result = validateTripLocationPayload([], MAX_POINTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid payload');
    }
  });

  it('rejects a missing tripId', () => {
    const result = validateTripLocationPayload(
      { points: [{ lat: 6.5, lng: 3.3 }] },
      MAX_POINTS,
    );
    expect(result).toEqual({
      ok: false,
      error: 'tripId is required — send the id of your active trip.',
    });
  });

  it('rejects a blank/whitespace tripId', () => {
    const result = validateTripLocationPayload(
      { tripId: '   ', points: [{ lat: 6.5, lng: 3.3 }] },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        'tripId is required — send the id of your active trip.',
      );
    }
  });

  it('rejects a non-string tripId (typewrong field)', () => {
    const result = validateTripLocationPayload(
      { tripId: 123, points: [{ lat: 6.5, lng: 3.3 }] },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('tripId is required');
    }
  });

  it('rejects an empty points array', () => {
    const result = validateTripLocationPayload(
      { tripId: 'trip-1', points: [] },
      MAX_POINTS,
    );
    expect(result).toEqual({
      ok: false,
      error: 'points must be a non-empty array of { lat, lng } locations.',
    });
  });

  it('rejects points that is not an array', () => {
    const result = validateTripLocationPayload(
      { tripId: 'trip-1', points: 'here' },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('non-empty array');
    }
  });

  it('rejects an oversized point batch and names the limit', () => {
    const points = Array.from({ length: MAX_POINTS + 1 }, () => ({
      lat: 6.5,
      lng: 3.3,
    }));
    const result = validateTripLocationPayload(
      { tripId: 'trip-1', points },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(
        `Too many points in one message (${MAX_POINTS + 1})`,
      );
      expect(result.error).toContain(`at most ${MAX_POINTS}`);
    }
  });

  it('accepts a batch exactly at the max (boundary)', () => {
    const points = Array.from({ length: MAX_POINTS }, () => ({
      lat: 6.5,
      lng: 3.3,
    }));
    const result = validateTripLocationPayload(
      { tripId: 'trip-1', points },
      MAX_POINTS,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a non-object point element', () => {
    const result = validateTripLocationPayload(
      { tripId: 'trip-1', points: [42] },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('points[0] must be an object');
    }
  });

  it('rejects an out-of-range latitude', () => {
    const result = validateTripLocationPayload(
      { tripId: 'trip-1', points: [{ lat: 91, lng: 3.3 }] },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('points[0].lat is invalid');
    }
  });

  it('rejects a non-number latitude (typewrong field)', () => {
    const result = validateTripLocationPayload(
      { tripId: 'trip-1', points: [{ lat: '6.5', lng: 3.3 }] },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('points[0].lat is invalid');
    }
  });

  it('rejects an out-of-range longitude', () => {
    const result = validateTripLocationPayload(
      { tripId: 'trip-1', points: [{ lat: 6.5, lng: 181 }] },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('points[0].lng is invalid');
    }
  });

  it('rejects a non-finite speed', () => {
    const result = validateTripLocationPayload(
      { tripId: 'trip-1', points: [{ lat: 6.5, lng: 3.3, speed: Infinity }] },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('points[0].speed is invalid');
    }
  });

  it('rejects a non-finite heading', () => {
    const result = validateTripLocationPayload(
      { tripId: 'trip-1', points: [{ lat: 6.5, lng: 3.3, heading: NaN }] },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('points[0].heading is invalid');
    }
  });

  it('rejects an unparseable recordedAt string', () => {
    const result = validateTripLocationPayload(
      {
        tripId: 'trip-1',
        points: [{ lat: 6.5, lng: 3.3, recordedAt: 'not-a-date' }],
      },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(
        'points[0].recordedAt is not a valid timestamp',
      );
    }
  });

  it('rejects a recordedAt of the wrong type (boolean)', () => {
    const result = validateTripLocationPayload(
      {
        tripId: 'trip-1',
        points: [{ lat: 6.5, lng: 3.3, recordedAt: true }],
      },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('points[0].recordedAt is invalid');
    }
  });

  it('treats null optional fields as omitted (does not include them)', () => {
    const result = validateTripLocationPayload(
      {
        tripId: 'trip-1',
        points: [
          { lat: 6.5, lng: 3.3, speed: null, heading: null, recordedAt: null },
        ],
      },
      MAX_POINTS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.points[0]).toEqual({ lat: 6.5, lng: 3.3 });
    }
  });

  it('reports the index of the first invalid point in a multi-point batch', () => {
    const result = validateTripLocationPayload(
      {
        tripId: 'trip-1',
        points: [
          { lat: 6.5, lng: 3.3 },
          { lat: 999, lng: 3.3 },
        ],
      },
      MAX_POINTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('points[1].lat is invalid');
    }
  });
});

describe('validateTripSubscribePayload', () => {
  it('accepts a payload with only tripId', () => {
    const result = validateTripSubscribePayload({ tripId: 'trip-1' });
    expect(result).toEqual({ ok: true, value: { tripId: 'trip-1' } });
  });

  it('accepts a payload with a valid shareToken', () => {
    const result = validateTripSubscribePayload({
      tripId: 'trip-1',
      shareToken: 'share-abc',
    });
    expect(result).toEqual({
      ok: true,
      value: { tripId: 'trip-1', shareToken: 'share-abc' },
    });
  });

  it('treats a null shareToken as omitted', () => {
    const result = validateTripSubscribePayload({
      tripId: 'trip-1',
      shareToken: null,
    });
    expect(result).toEqual({ ok: true, value: { tripId: 'trip-1' } });
  });

  it('rejects a non-object payload', () => {
    const result = validateTripSubscribePayload(null);
    expect(result).toEqual({
      ok: false,
      error: 'Invalid payload — send an object like { tripId, shareToken? }.',
    });
  });

  it('rejects a missing tripId', () => {
    const result = validateTripSubscribePayload({ shareToken: 'x' });
    expect(result).toEqual({
      ok: false,
      error: 'tripId is required — send the id of the trip to watch.',
    });
  });

  it('rejects a blank shareToken when provided', () => {
    const result = validateTripSubscribePayload({
      tripId: 'trip-1',
      shareToken: '   ',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('shareToken must be a non-empty string');
    }
  });

  it('rejects a non-string shareToken (typewrong field)', () => {
    const result = validateTripSubscribePayload({
      tripId: 'trip-1',
      shareToken: 12345,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('shareToken must be a non-empty string');
    }
  });
});

describe('validateTripUnsubscribePayload', () => {
  it('accepts a payload with tripId', () => {
    const result = validateTripUnsubscribePayload({ tripId: 'trip-1' });
    expect(result).toEqual({ ok: true, value: { tripId: 'trip-1' } });
  });

  it('rejects a non-object payload', () => {
    const result = validateTripUnsubscribePayload(undefined);
    expect(result).toEqual({
      ok: false,
      error: 'Invalid payload — send an object like { tripId }.',
    });
  });

  it('rejects a missing tripId', () => {
    const result = validateTripUnsubscribePayload({});
    expect(result).toEqual({
      ok: false,
      error: 'tripId is required — send the id of the trip to stop watching.',
    });
  });
});
