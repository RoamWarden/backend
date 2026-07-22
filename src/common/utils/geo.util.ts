const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance between two WGS84 points, in metres. */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export function isValidLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

export function isValidLng(lng: number): boolean {
  return Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

/**
 * Builds a PostGIS WKT point ("POINT(lng lat)") after validating bounds.
 * Use with ST_GeogFromText in parameterized raw SQL.
 */
export function toWktPoint(lat: number, lng: number): string {
  if (!isValidLat(lat) || !isValidLng(lng)) {
    throw new Error(`Invalid coordinates: lat=${lat}, lng=${lng}`);
  }
  return `POINT(${lng} ${lat})`;
}

/** Builds a PostGIS WKT linestring from [lat, lng] pairs (min 2 points). */
export function toWktLineString(
  points: Array<{ lat: number; lng: number }>,
): string {
  if (points.length < 2) {
    throw new Error('A linestring needs at least 2 points');
  }
  for (const p of points) {
    if (!isValidLat(p.lat) || !isValidLng(p.lng)) {
      throw new Error(
        `Invalid coordinates in linestring: lat=${p.lat}, lng=${p.lng}`,
      );
    }
  }
  return `LINESTRING(${points.map((p) => `${p.lng} ${p.lat}`).join(', ')})`;
}
