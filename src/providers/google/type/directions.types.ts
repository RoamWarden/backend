import type { TransportMode } from '@prisma/client';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface DirectionsRoute {
  points: LatLng[];
  durationS: number;
  distanceM: number;
}

export interface GetRouteParams {
  origin: LatLng;
  destination: LatLng;
  mode: TransportMode;
}

export interface GoogleDirectionsResponse {
  status?: string;
  error_message?: string;
  routes?: Array<{
    overview_polyline?: { points?: string };
    legs?: Array<{
      duration?: { value?: number };
      distance?: { value?: number };
    }>;
  }>;
}
