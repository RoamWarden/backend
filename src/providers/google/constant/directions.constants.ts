import { TransportMode } from '@prisma/client';

export const GOOGLE_TRAVEL_MODE: Record<TransportMode, string> = {
  [TransportMode.CAR]: 'driving',
  [TransportMode.MOTORBIKE]: 'driving',
  [TransportMode.OTHER]: 'driving',
  [TransportMode.BUS]: 'transit',
  [TransportMode.TRAIN]: 'transit',
  [TransportMode.WALK]: 'walking',
  [TransportMode.BICYCLE]: 'bicycling',
};

export const DIRECTIONS_API_URL =
  'https://maps.googleapis.com/maps/api/directions/json';
