export const PLACES_NEARBY_API_URL =
  'https://maps.googleapis.com/maps/api/place/nearbysearch/json';

export const PLACES_TEXT_SEARCH_API_URL =
  'https://maps.googleapis.com/maps/api/place/textsearch/json';

/** "What is at/near this pin" — tight radius around the tapped coordinate (metres). */
export const PLACES_NEARBY_RADIUS_M = 250;

/** Text-search location bias radius (metres) — roughly a city. */
export const PLACES_TEXT_SEARCH_RADIUS_M = 30000;

/** Hard cap on places returned to the app per lookup. */
export const PLACES_MAX_RESULTS = 12;

/** Places responses are cached this long (cost control, mirrors directions). */
export const PLACES_CACHE_TTL_S = 10 * 60;
