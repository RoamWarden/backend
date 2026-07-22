import { Injectable, Logger } from '@nestjs/common';
import { AlertChannel, type Report } from '@prisma/client';
import {
  REPORT_ALERT_CORRIDOR_RADIUS_M,
  REPORT_ALERT_PRESENCE_RADIUS_M,
} from '../../common/constants';
import { toWktPoint } from '../../common/utils/geo.util';
import { NotificationsService } from '../notification/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CHANNEL_ALERT_INCIDENT } from '../../providers/redis/constant/redis.constants';
import { RedisService } from '../../providers/redis/redis.service';
import {
  PUSH_BODY_FALLBACK,
  PUSH_BODY_MAX_CHARS,
  REPORT_TYPE_ALERT_TITLE,
} from './constant/alerts.constants';
import type {
  AlertIncidentMessage,
  CorridorMatchRow,
} from './type/alerts.types';

/**
 * Corridor matching engine + alert fan-out (docs/CONTRACT.md — AlertsModule).
 *
 * For every new report: find users whose ACTIVE trip corridor passes near the
 * incident (PostGIS) plus users physically nearby (Redis GEO presence), write
 * audit rows, publish one AlertIncidentMessage for the realtime gateway, and
 * push (FCM) to users with no live socket. Delivery legs are independent — one
 * failing leg never blocks the others.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
  ) {}

  async handleNewReport(report: Report): Promise<{ alertedUserIds: string[] }> {
    const wkt = toWktPoint(report.lat, report.lng);

    // ── 1) corridor match: ACTIVE trips whose route passes near the incident ──
    const corridorRows = await this.prisma.$queryRaw<CorridorMatchRow[]>`
      SELECT t.id AS trip_id, t.user_id
      FROM trips t
      JOIN trip_routes tr ON tr.trip_id = t.id
      WHERE t.status = 'ACTIVE'::trip_status
        AND tr.path IS NOT NULL
        AND ST_DWithin(
          tr.path,
          ST_GeogFromText(${wkt}),
          ${REPORT_ALERT_CORRIDOR_RADIUS_M}
        )
    `;

    /** userId → threatened tripId (first corridor match wins). */
    const tripIdByUserId: Record<string, string> = {};
    for (const row of corridorRows) {
      if (!(row.user_id in tripIdByUserId)) {
        tripIdByUserId[row.user_id] = row.trip_id;
      }
    }

    // ── 2) presence match: users physically near the incident right now ──
    // Redis hiccups must not kill the alert — degrade to corridor matches only.
    let presenceUserIds: string[] = [];
    try {
      presenceUserIds = await this.redis.searchNearbyUserIds(
        report.lat,
        report.lng,
        REPORT_ALERT_PRESENCE_RADIUS_M,
      );
    } catch (err) {
      this.logger.error(
        `Presence lookup failed for report ${report.id} (lat=${report.lat}, lng=${report.lng}) — continuing with ${corridorRows.length} corridor match(es) only`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    // ── 3) union, excluding the reporter ──
    const alertedUserIds = [
      ...new Set([...Object.keys(tripIdByUserId), ...presenceUserIds]),
    ].filter((userId) => userId !== report.reporterId);

    if (alertedUserIds.length === 0) {
      this.logger.log(
        `Report ${report.id} (${report.type}): no users to alert (0 corridors, ${presenceUserIds.length} presence hits, reporter excluded)`,
      );
      return { alertedUserIds: [] };
    }

    // ── 4) split online/offline + write audit rows ──
    // If the online lookup fails, treat everyone as offline: push reaches
    // devices regardless of socket state, so nobody is silently dropped.
    let online: string[] = [];
    let offline: string[] = alertedUserIds;
    try {
      ({ online, offline } = await this.redis.partitionOnline(alertedUserIds));
    } catch (err) {
      this.logger.error(
        `Online/offline partition failed for report ${report.id} — treating all ${alertedUserIds.length} user(s) as offline (push fallback)`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    try {
      await this.prisma.alert.createMany({
        data: [
          ...online.map((userId) => ({
            reportId: report.id,
            userId,
            tripId: tripIdByUserId[userId] ?? null,
            channel: AlertChannel.WEBSOCKET,
          })),
          ...offline.map((userId) => ({
            reportId: report.id,
            userId,
            tripId: tripIdByUserId[userId] ?? null,
            channel: AlertChannel.PUSH,
          })),
        ],
        skipDuplicates: true,
      });
    } catch (err) {
      this.logger.error(
        `Failed to write alert audit rows for report ${report.id} (${alertedUserIds.length} user(s)) — continuing with delivery anyway`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    // ── 5) realtime fan-out (one message; gateways emit to hosted users) ──
    try {
      const message: AlertIncidentMessage = {
        report: {
          id: report.id,
          type: report.type,
          lat: report.lat,
          lng: report.lng,
          note: report.note,
          status: report.status,
          confirmCount: report.confirmCount,
          denyCount: report.denyCount,
          createdAt: report.createdAt.toISOString(),
          expiresAt: report.expiresAt.toISOString(),
        },
        userIds: alertedUserIds,
        ...(Object.keys(tripIdByUserId).length > 0 ? { tripIdByUserId } : {}),
      };
      await this.redis.publishJson(CHANNEL_ALERT_INCIDENT, message);
    } catch (err) {
      this.logger.error(
        `Failed to publish incident ${report.id} on ${CHANNEL_ALERT_INCIDENT} — websocket users will miss the live alert (push leg still runs)`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    // ── 6) push to offline users ──
    // sendToUsers never throws by contract, but this leg stays guarded so a
    // regression there can never block the return of alerted users.
    try {
      if (offline.length > 0) {
        await this.notifications.sendToUsers(offline, {
          title: REPORT_TYPE_ALERT_TITLE[report.type],
          body: this.buildPushBody(report.note),
          data: {
            reportId: report.id,
            type: report.type,
            lat: String(report.lat),
            lng: String(report.lng),
          },
        });
      }
    } catch (err) {
      this.logger.error(
        `Failed to push incident ${report.id} to ${offline.length} offline user(s)`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    this.logger.log(
      `Report ${report.id} (${report.type}): alerted ${alertedUserIds.length} user(s) — ${corridorRows.length} corridor match(es), ${presenceUserIds.length} presence hit(s); ${online.length} online, ${offline.length} offline`,
    );

    return { alertedUserIds };
  }

  /** Push body: the reporter's note (truncated) or a helpful fallback. */
  private buildPushBody(note: string | null): string {
    const trimmed = note?.trim();
    if (!trimmed) return PUSH_BODY_FALLBACK;
    if (trimmed.length <= PUSH_BODY_MAX_CHARS) return trimmed;
    return `${trimmed.slice(0, PUSH_BODY_MAX_CHARS - 1)}…`;
  }
}
