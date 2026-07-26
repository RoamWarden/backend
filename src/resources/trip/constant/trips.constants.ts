import { TripStatus } from '@prisma/client';

/**
 * The statuses in which a journey is STILL UNDER WAY.
 *
 * SOS IS A LIVE STATE. Raising an alarm does not end a trip — the phone keeps
 * tracking (the app's `isLiveStatus` says exactly this), watchers keep watching,
 * and the traveller is more dependent on the trip working, not less. Every
 * "is this trip still running?" guard must therefore test THIS SET and never
 * `status === ACTIVE`: an ACTIVE-only guard silently treats a person mid-alarm
 * as if their journey were already over, which is how ending a trip in SOS
 * became impossible (see `TripsService.completeTrip`).
 */
export const LIVE_TRIP_STATUSES = [TripStatus.ACTIVE, TripStatus.SOS] as const;

/** True while the journey is still running (ACTIVE or SOS). */
export function isLiveTripStatus(status: TripStatus): boolean {
  return (LIVE_TRIP_STATUSES as readonly TripStatus[]).includes(status);
}

/** Shown when a second journey is started while one is still running. */
export const ACTIVE_TRIP_CONFLICT_MSG =
  'You already have an active trip — stop or cancel it before starting a new one.';

/**
 * The same conflict when the running trip is in SOS. Named separately because
 * "active" would read as a contradiction to someone staring at a red SOS screen,
 * and the way out is different: end THAT trip (which is allowed) rather than
 * stand the alarm down.
 */
export const SOS_TRIP_CONFLICT_MSG =
  'You have a trip with an SOS alert on it — end that trip before starting a new one. Cancelling it will not stand the alarm down.';

/**
 * Refusing a check-in while an alarm is open. Check-in answers an "are you OK?"
 * nudge; it is NOT how an SOS is stood down, and pretending otherwise would let
 * someone believe they had called their contacts off when they had not.
 */
export const CHECKIN_DURING_SOS_MSG =
  'There is an SOS alert open on this trip — checking in will not stand it down. Mark yourself safe on the alert instead, or end the trip.';

/** Refusing a check-in on a journey that is over. Says what to do instead. */
export function checkinEndedMsg(status: TripStatus): string {
  return `This trip was already ${status.toLowerCase()} — there is nothing to check in on. Start a new trip when you next set off.`;
}

/** Refusing breadcrumbs for a journey that is over. Says what to do instead. */
export function pointsRejectedMsg(status: TripStatus): string {
  return `This trip was already ${status.toLowerCase()} — location updates are only recorded while a trip is running. Start a new trip to share your location again.`;
}

export const LIVE_VIEW_REPORT_RADIUS_M = 1000;
export const LIVE_VIEW_REPORT_LIMIT = 200;
export const TRIP_DETAIL_POINT_LIMIT = 100;
export const LIVE_VIEW_POINT_LIMIT = 50;
/** Max ACTIVE trips the no-arrival/stall monitor processes per cron sweep. */
export const TRIP_MONITOR_SWEEP_LIMIT = 500;
export const TRIP_NOT_FOUND_MSG =
  'Trip not found — check the trip id and make sure the trip belongs to you.';
export const LIVE_LINK_INVALID_MSG =
  'This live trip link is invalid or has expired.';

/**
 * How many routes / destinations GET /trips/stats returns. Three is a summary a
 * phone screen can actually read; a longer list is a report, not an insight.
 */
export const TRIP_STATS_TOP_LIMIT = 3;

/**
 * Decimal places used to group unlabelled origins/destinations by coordinate.
 * 3dp ≈ 110 m, so two departures from the same street corner count as the same
 * place while two genuinely different stops stay apart.
 */
export const TRIP_STATS_COORD_PRECISION = 3;

/**
 * Shown when the stats aggregation itself fails. The history list is unaffected,
 * so the copy points back at the thing that still works instead of implying the
 * user's trips are gone.
 */
export const TRIP_STATS_UNAVAILABLE_MSG =
  "We couldn't work out your trip insights just now. Your trips are safe — please try again in a moment.";
