/**
 * Redis key & channel names shared across modules. Change here, never inline.
 *
 * Fan-out design (build plan §13.3/§14): alert delivery is O(affected users).
 * The alerts engine computes the affected user set (PostGIS corridor match +
 * Redis GEO presence), persists the audit rows, then publishes ONE message on
 * CHANNEL_ALERT_INCIDENT listing the target userIds. Gateway instances emit to
 * the per-user rooms they host; a geo-cell channel partition is the documented
 * scale-up path once multiple corridors are live.
 */

/** GEO set of every user's last known position. Member = userId. */
export const KEY_GEO_PRESENCE = 'geo:presence';

/** Hash userId → number of live sockets. >0 means "online right now". */
export const KEY_ONLINE_SOCKETS = 'online:sockets';

/** Incident fan-out. Payload: AlertIncidentMessage (docs/CONTRACT.md). */
export const CHANNEL_ALERT_INCIDENT = 'alerts:incident';

/** SOS fan-out to trusted contacts. Payload: SosRaisedMessage. */
export const CHANNEL_SOS = 'sos:raised';

/** Per-trip live stream (positions + status changes) relayed to watcher rooms. */
export const channelTripLive = (tripId: string): string =>
  `trip:live:${tripId}`;

/** Pattern matching every per-trip live channel (psubscribe). */
export const PATTERN_TRIP_LIVE = 'trip:live:*';

/** Directions response cache (cost control). */
export const keyDirectionsCache = (hash: string): string =>
  `cache:directions:${hash}`;
