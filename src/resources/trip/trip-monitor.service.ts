import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TripStatus } from '@prisma/client';
import {
  TRIP_ESCALATE_AFTER_S,
  TRIP_MAX_DURATION_S,
  TRIP_OVERDUE_GRACE_S,
  TRIP_STALL_MIN_ACTIVE_S,
  TRIP_STALL_TIMEOUT_S,
} from '../../common/constants';
import { PrismaService } from '../../prisma/prisma.service';
import { channelTripLive } from '../../providers/redis/constant/redis.constants';
import { RedisService } from '../../providers/redis/redis.service';
import { NotificationsService } from '../notification/notifications.service';
import { TRIP_MONITOR_SWEEP_LIMIT } from './constant/trips.constants';
import type { MonitoredTrip } from './type/trips.types';
import { TripsService } from './trips.service';

/**
 * No-arrival / stall escalation (build plan §6, §13#4). A once-a-minute sweep
 * walks every ACTIVE trip and runs an escalation ladder:
 *
 *  0. FIRST, the opposite question: has this silent trip already arrived? A
 *     stored breadcrumb inside the destination geofence closes it as COMPLETED
 *     before any of the rungs below can raise an alarm about a finished
 *     journey. See `TripsService.completeIfArrived`.
 *  1. The trip is overdue (past its expected arrival + grace) OR has stalled
 *     (no fresh breadcrumb on a trip that was clearly moving) → nudge the
 *     traveller with an "Are you OK?" push and flag the live view `overdue`.
 *  2. If that nudge went unanswered (no check-in) for TRIP_ESCALATE_AFTER_S →
 *     alert the traveller's consented linked contacts with a live-share link.
 *  3. If the trip is STILL silent long after that, close it as CANCELLED and
 *     say so. See TRIP_AUTO_CLOSE_SILENCE_S — the ladder used to have no last
 *     rung, so a trip whose feed simply died stayed ACTIVE for ever.
 *
 * IMPORTANT: RoamWarden is NOT an emergency service. Messaging stays calm and
 * non-alarmist; the traveller and their contacts must still call local
 * emergency services themselves. The cron never throws — each trip is handled
 * in isolation so one failure can't abort the sweep.
 */

/**
 * How long an already-escalated trip may stay silent before the monitor closes
 * it as CANCELLED.
 *
 * DELIBERATELY LONG, and deliberately CANCELLED. Closing someone's trip ends the
 * monitoring they started it for, so this must never be a plausible gap in a
 * real journey. It exists for the trips whose feed died for good — the app killed
 * mid-arrival with breadcrumbs still queued on the phone, a flat battery, a
 * sign-out (which stops tracking without telling the server). Those trips are
 * ACTIVE for ever: the sweep re-reads them every minute doing nothing, they sit
 * at the head of every `startedAt asc` page, and `ACTIVE_TRIP_CONFLICT_MSG`
 * locks the traveller out of their next journey with no way to clear it.
 *
 * 6h matches TRIP_MAX_DURATION_S, so the earliest a trip can close this way is
 * the full nudge + escalate ladder plus a whole trip's worth of silence on top.
 * The clock also restarts at escalation, so the traveller always gets the entire
 * window AFTER being asked whether they are OK.
 */
export const TRIP_AUTO_CLOSE_SILENCE_S = 6 * 3600;
@Injectable()
export class TripMonitorService {
  private readonly logger = new Logger(TripMonitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
    private readonly trips: TripsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async escalateOverdueTrips(): Promise<void> {
    let trips: MonitoredTrip[];
    try {
      trips = await this.prisma.trip.findMany({
        where: { status: TripStatus.ACTIVE },
        select: {
          id: true,
          userId: true,
          startedAt: true,
          expectedDurationS: true,
          lastPointAt: true,
          checkinAt: true,
          overdueNotifiedAt: true,
          escalatedAt: true,
          destLabel: true,
          shareTokenVersion: true,
          user: { select: { name: true } },
        },
        orderBy: { startedAt: 'asc' },
        take: TRIP_MONITOR_SWEEP_LIMIT,
      });
    } catch (err) {
      this.logger.error(
        'Trip-monitor sweep failed to load active trips — will retry next run',
        err instanceof Error ? err.stack : String(err),
      );
      return;
    }

    for (const trip of trips) {
      try {
        await this.handleTrip(trip);
      } catch (err) {
        // Isolate per-trip failures so one bad trip can't abort the sweep.
        this.logger.error(
          `Trip-monitor failed to process trip ${trip.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  private async handleTrip(trip: MonitoredTrip): Promise<void> {
    const now = Date.now();

    const dueAt =
      trip.startedAt.getTime() +
      (trip.expectedDurationS ?? TRIP_MAX_DURATION_S) * 1000 +
      TRIP_OVERDUE_GRACE_S * 1000;

    const stalled =
      trip.lastPointAt !== null &&
      now - trip.lastPointAt.getTime() > TRIP_STALL_TIMEOUT_S * 1000 &&
      now - trip.startedAt.getTime() > TRIP_STALL_MIN_ACTIVE_S * 1000;

    // ── STAGE 0: they got there, we just never noticed it live ──────────
    //
    // Runs BEFORE the ladder on purpose. A trip whose STORED breadcrumbs put the
    // traveller inside the destination geofence is not a trip in trouble, and
    // the ladder would tell them so three times over: "Are you OK?", then their
    // contacts "may need help", then the journey filed as CANCELLED six hours
    // later. Closing it as COMPLETED is the honest answer, and the one that
    // unblocks the next trip (ACTIVE_TRIP_CONFLICT_MSG).
    //
    // Gated on `stalled`, so the spatial lookup only runs for trips already 20
    // minutes silent: a journey still sending its location is never touched and
    // the query stays off the sweep's hot path. `completeIfArrived` re-reads the
    // trip, refuses anything not ACTIVE (an open SOS is never closed behind the
    // traveller), and returns true only when IT made the change — so a real stop
    // that won the race is neither announced nor skipped over here.
    if (stalled && (await this.trips.completeIfArrived(trip.id))) return;

    // ── STAGE 1: nudge the traveller ────────────────────────────────────
    if (
      trip.overdueNotifiedAt === null &&
      (now > dueAt || stalled) &&
      (trip.checkinAt === null || trip.checkinAt.getTime() < now)
    ) {
      // Guarded transition: only the sweep that actually flips
      // overdueNotifiedAt from null wins, so overlapping runs never
      // double-notify.
      const { count } = await this.prisma.trip.updateMany({
        where: {
          id: trip.id,
          status: TripStatus.ACTIVE,
          overdueNotifiedAt: null,
        },
        data: { overdueNotifiedAt: new Date() },
      });
      if (count === 0) return;

      await this.notifications.sendToUsers([trip.userId], {
        title: 'Are you OK?',
        body: 'Your RoamWarden trip is taking longer than expected. Tap to check in, or raise SOS if you need help.',
        data: { tripId: trip.id, kind: 'overdue' },
      });

      await this.safePublish(channelTripLive(trip.id), {
        kind: 'status',
        tripId: trip.id,
        status: TripStatus.ACTIVE,
        overdue: true,
      });
      return;
    }

    // ── STAGE 2: alert the traveller's contacts ─────────────────────────
    if (
      trip.overdueNotifiedAt !== null &&
      trip.escalatedAt === null &&
      now - trip.overdueNotifiedAt.getTime() > TRIP_ESCALATE_AFTER_S * 1000 &&
      (trip.checkinAt === null ||
        trip.checkinAt.getTime() <= trip.overdueNotifiedAt.getTime())
    ) {
      const contactUserIds = await this.trips.getWatcherUserIds(trip.id);
      if (contactUserIds.length === 0) {
        // No one to escalate to — still mark it escalated so we don't keep
        // re-evaluating this trip every minute.
        await this.markEscalated(trip.id);
        return;
      }

      // Guarded transition mirrors stage 1: only one sweep escalates.
      if (!(await this.markEscalated(trip.id))) return;

      const ownerName = trip.user.name || 'Your contact';
      const shareUrl = this.trips.buildLiveShareUrl(
        trip.id,
        trip.shareTokenVersion,
      );

      // Non-alarmist: contacts are asked to check in / view live location, not
      // to treat this as an emergency dispatch. They should call local
      // emergency services if they believe there is real danger.
      await this.notifications.sendToUsers(contactUserIds, {
        title: `⚠️ ${ownerName} may need help`,
        body: `${ownerName}'s trip is overdue and they have not checked in. Tap to see their live location.`,
        data: { tripId: trip.id, kind: 'no_arrival', shareUrl },
      });

      await this.safePublish(channelTripLive(trip.id), {
        kind: 'status',
        tripId: trip.id,
        status: TripStatus.ACTIVE,
        escalated: true,
      });
      return;
    }

    // ── STAGE 3: close a trip whose feed died for good ──────────────────
    //
    // Reachable only once stage 2 has run (contacts alerted) AND nothing has
    // been heard since — no breadcrumb, no check-in — for the whole silence
    // window. Everything monitoring can do has been done; leaving the row ACTIVE
    // past this point helps nobody and actively blocks the traveller's next trip.
    if (trip.escalatedAt === null) return;

    const lastSignOfLife = Math.max(
      (trip.lastPointAt ?? trip.startedAt).getTime(),
      trip.checkinAt?.getTime() ?? 0,
      // Restart the clock at escalation so the traveller always gets the full
      // window after being asked whether they are OK.
      trip.escalatedAt.getTime(),
    );
    if (now - lastSignOfLife <= TRIP_AUTO_CLOSE_SILENCE_S * 1000) return;

    // CANCELLED, and `autoCloseTrip` enforces that — never COMPLETED. We have no
    // evidence this person arrived, and the contacts we alerted must not be told
    // otherwise. Returns null if a real stop won the race; announce nothing then.
    const closed = await this.trips.autoCloseTrip(trip.id);
    if (closed === null) return;

    const destination = trip.destLabel ?? 'your destination';
    const silentHours = Math.floor(
      (now - lastSignOfLife) / (3600 * 1000),
    ).toString();

    // The traveller first, and never silently: their trip ending on its own,
    // with no arrival recorded, is something they have to be told plainly —
    // not least because it is what unblocks starting the next one.
    await this.notifications.sendToUsers([trip.userId], {
      title: 'We closed your trip',
      body: `Your trip to ${destination} stopped sending your location about ${silentHours} hours ago, so we've closed it. It was NOT recorded as an arrival. Start a new trip whenever you next set off.`,
      data: { tripId: trip.id, kind: 'auto_closed' },
    });

    // These contacts were told this person "may need help" hours ago. Closing
    // the trip in silence would leave that hanging; saying "closed" without
    // saying "this is not an arrival" would answer it wrongly.
    const contactUserIds = await this.trips.getWatcherUserIds(trip.id);
    if (contactUserIds.length > 0) {
      const ownerName = trip.user.name || 'Your contact';
      await this.notifications.sendToUsers(contactUserIds, {
        title: 'Trip closed automatically',
        body: `${ownerName}'s trip to ${trip.destLabel ?? 'their destination'} stopped updating, so RoamWarden closed it. This does NOT mean they arrived safely — check in with them if you haven't already.`,
        data: { tripId: trip.id, kind: 'auto_closed' },
      });
    }
  }

  /**
   * Guarded escalatedAt transition — returns true only for the sweep that
   * actually flipped it from null, keeping the escalation idempotent under
   * overlapping cron runs.
   */
  private async markEscalated(tripId: string): Promise<boolean> {
    const { count } = await this.prisma.trip.updateMany({
      where: {
        id: tripId,
        status: TripStatus.ACTIVE,
        escalatedAt: null,
      },
      data: { escalatedAt: new Date() },
    });
    return count > 0;
  }

  /** Publishes on the live channel, logging (never throwing) on failure. */
  private async safePublish(channel: string, payload: unknown): Promise<void> {
    try {
      await this.redis.publishJson(channel, payload);
    } catch (err) {
      this.logger.error(
        `Failed to publish live message on ${channel}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
