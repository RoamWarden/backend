export interface TripPointView {
  lat: number;
  lng: number;
  speed: number | null;
  heading: number | null;
  accuracy: number | null;
  recordedAt: Date;
}

/** Anonymized report shape for the live view. */
export interface LiveViewReport {
  id: string;
  type: string;
  status: string;
  lat: number;
  lng: number;
  note: string | null;
  confirmCount: number;
  denyCount: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface RouteGeoJsonRow {
  source: string | null;
  geojson: string | null;
}

/** ACTIVE-trip row the no-arrival/stall monitor evaluates each sweep. */
export interface MonitoredTrip {
  id: string;
  userId: string;
  startedAt: Date;
  expectedDurationS: number | null;
  lastPointAt: Date | null;
  checkinAt: Date | null;
  overdueNotifiedAt: Date | null;
  escalatedAt: Date | null;
  destLabel: string | null;
  shareTokenVersion: number;
  user: { name: string };
}
