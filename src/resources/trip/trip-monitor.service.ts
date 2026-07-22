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
 * walks every ACTIVE trip and runs a two-stage escalation ladder:
 *
 *  1. The trip is overdue (past its expected arrival + grace) OR has stalled
 *     (no fresh breadcrumb on a trip that was clearly moving) → nudge the
 *     traveller with an "Are you OK?" push and flag the live view `overdue`.
 *  2. If that nudge went unanswered (no check-in) for TRIP_ESCALATE_AFTER_S →
 *     alert the traveller's consented linked contacts with a live-share link.
 *
 * IMPORTANT: RoamWarden is NOT an emergency service. Messaging stays calm and
 * non-alarmist; the traveller and their contacts must still call local
 * emergency services themselves. The cron never throws — each trip is handled
 * in isolation so one failure can't abort the sweep.
 */
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
