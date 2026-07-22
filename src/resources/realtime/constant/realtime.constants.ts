/** Per-user room every authenticated socket joins (alert / SOS / status fan-out). */
export const userRoom = (userId: string): string => `user:${userId}`;

/** Per-trip room joined by authorized live watchers. */
export const tripRoom = (tripId: string): string => `trip:${tripId}`;

/**
 * Max breadcrumbs accepted in a single `trip:location` WS message. The socket
 * stream is a low-latency side channel — larger batches belong on
 * `POST /trips/:id/points` (see TRIP_POINTS_MAX_BATCH in common/constants).
 */
export const WS_TRIP_LOCATION_MAX_POINTS = 50;
