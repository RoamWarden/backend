import {
  haversineMeters,
  isValidLat,
  isValidLng,
  toWktLineString,
  toWktPoint,
} from './geo.util';

describe('geo.util', () => {
  describe('haversineMeters', () => {
    it('is zero for the same point', () => {
      expect(haversineMeters(6.5244, 3.3792, 6.5244, 3.3792)).toBe(0);
      expect(haversineMeters(0, 0, 0, 0)).toBe(0);
    });

    it('is ~111km for one degree of latitude', () => {
      const d = haversineMeters(0, 0, 1, 0);
      // 1 deg latitude ≈ 111.19 km; allow generous tolerance
      expect(d).toBeGreaterThan(110_000);
      expect(d).toBeLessThan(112_000);
    });

    it('is ~111km for one degree of longitude at the equator', () => {
      const d = haversineMeters(0, 0, 0, 1);
      expect(d).toBeGreaterThan(110_000);
      expect(d).toBeLessThan(112_000);
    });

    it('is symmetric regardless of argument order', () => {
      const a = haversineMeters(51.5074, -0.1278, 48.8566, 2.3522);
      const b = haversineMeters(48.8566, 2.3522, 51.5074, -0.1278);
      expect(a).toBeCloseTo(b, 6);
    });

    it('matches the known London↔Paris great-circle distance (~343km)', () => {
      const d = haversineMeters(51.5074, -0.1278, 48.8566, 2.3522);
      expect(d).toBeGreaterThan(340_000);
      expect(d).toBeLessThan(346_000);
    });

    it('shrinks longitude distance toward the poles', () => {
      const atEquator = haversineMeters(0, 0, 0, 1);
      const atHighLat = haversineMeters(60, 0, 60, 1);
      // cos(60°) = 0.5, so a degree of longitude is roughly half as long
      expect(atHighLat).toBeLessThan(atEquator);
      expect(atHighLat).toBeCloseTo(
        atEquator * Math.cos((60 * Math.PI) / 180),
        -3,
      );
    });
  });

  describe('isValidLat', () => {
    it('accepts values within [-90, 90] including bounds', () => {
      expect(isValidLat(0)).toBe(true);
      expect(isValidLat(90)).toBe(true);
      expect(isValidLat(-90)).toBe(true);
      expect(isValidLat(45.123)).toBe(true);
    });

    it('rejects values outside the bounds', () => {
      expect(isValidLat(90.0001)).toBe(false);
      expect(isValidLat(-90.0001)).toBe(false);
      expect(isValidLat(180)).toBe(false);
    });

    it('rejects NaN and Infinity', () => {
      expect(isValidLat(NaN)).toBe(false);
      expect(isValidLat(Infinity)).toBe(false);
      expect(isValidLat(-Infinity)).toBe(false);
    });
  });

  describe('isValidLng', () => {
    it('accepts values within [-180, 180] including bounds', () => {
      expect(isValidLng(0)).toBe(true);
      expect(isValidLng(180)).toBe(true);
      expect(isValidLng(-180)).toBe(true);
      expect(isValidLng(-0.1278)).toBe(true);
    });

    it('rejects values outside the bounds', () => {
      expect(isValidLng(180.0001)).toBe(false);
      expect(isValidLng(-180.0001)).toBe(false);
      expect(isValidLng(360)).toBe(false);
    });

    it('rejects NaN and Infinity', () => {
      expect(isValidLng(NaN)).toBe(false);
      expect(isValidLng(Infinity)).toBe(false);
      expect(isValidLng(-Infinity)).toBe(false);
    });
  });

  describe('toWktPoint', () => {
    it('emits lng first, then lat (POINT(lng lat))', () => {
      // lat=6.5244, lng=3.3792 → WKT must be POINT(3.3792 6.5244)
      expect(toWktPoint(6.5244, 3.3792)).toBe('POINT(3.3792 6.5244)');
    });

    it('handles negative and zero coordinates preserving order', () => {
      expect(toWktPoint(51.5074, -0.1278)).toBe('POINT(-0.1278 51.5074)');
      expect(toWktPoint(0, 0)).toBe('POINT(0 0)');
    });

    it('accepts the extreme valid bounds', () => {
      expect(toWktPoint(90, 180)).toBe('POINT(180 90)');
      expect(toWktPoint(-90, -180)).toBe('POINT(-180 -90)');
    });

    it('throws on out-of-range latitude', () => {
      expect(() => toWktPoint(91, 0)).toThrow(
        'Invalid coordinates: lat=91, lng=0',
      );
    });

    it('throws on out-of-range longitude', () => {
      expect(() => toWktPoint(0, 181)).toThrow(
        'Invalid coordinates: lat=0, lng=181',
      );
    });

    it('throws on NaN coordinates', () => {
      expect(() => toWktPoint(NaN, 0)).toThrow('Invalid coordinates');
    });
  });

  describe('toWktLineString', () => {
    it('builds a linestring with lng-first ordering for 2 points', () => {
      const wkt = toWktLineString([
        { lat: 6.5244, lng: 3.3792 },
        { lat: 6.6, lng: 3.4 },
      ]);
      expect(wkt).toBe('LINESTRING(3.3792 6.5244, 3.4 6.6)');
    });

    it('builds a linestring for more than 2 points', () => {
      const wkt = toWktLineString([
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
        { lat: 2, lng: 2 },
      ]);
      expect(wkt).toBe('LINESTRING(0 0, 1 1, 2 2)');
    });

    it('throws when given fewer than 2 points', () => {
      expect(() => toWktLineString([])).toThrow(
        'A linestring needs at least 2 points',
      );
      expect(() => toWktLineString([{ lat: 0, lng: 0 }])).toThrow(
        'A linestring needs at least 2 points',
      );
    });

    it('throws on an invalid latitude within the points', () => {
      expect(() =>
        toWktLineString([
          { lat: 0, lng: 0 },
          { lat: 999, lng: 0 },
        ]),
      ).toThrow('Invalid coordinates in linestring: lat=999, lng=0');
    });

    it('throws on an invalid longitude within the points', () => {
      expect(() =>
        toWktLineString([
          { lat: 0, lng: 0 },
          { lat: 0, lng: -181 },
        ]),
      ).toThrow('Invalid coordinates in linestring: lat=0, lng=-181');
    });

    it('throws on NaN coordinates within the points', () => {
      expect(() =>
        toWktLineString([
          { lat: 0, lng: 0 },
          { lat: NaN, lng: 0 },
        ]),
      ).toThrow('Invalid coordinates in linestring');
    });
  });
});
