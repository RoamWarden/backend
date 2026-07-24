import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, Report, ReportStatus, ReportType } from '@prisma/client';
import { AlertsService } from '../alert/alerts.service';
import {
  REPORT_CLUSTER_RADIUS_M,
  REPORT_CLUSTER_VERIFY_THRESHOLD,
  REPORT_GEO_PLAUSIBILITY_M,
  REPORT_REJECT_THRESHOLD,
  REPORT_TTL_S,
  REPORT_VERIFY_THRESHOLD,
  REPUTATION_REPORT_REJECTED,
  REPUTATION_REPORT_VERIFIED,
} from '../../common/constants';
import {
  haversineMeters,
  isValidLat,
  isValidLng,
  toWktPoint,
} from '../../common/utils/geo.util';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../providers/redis/redis.service';
import {
  BBOX_FORMAT_HINT,
  REPORT_NEAR_MAX_RADIUS_M,
  REPORT_QUERY_LIMIT,
} from './constant/reports.constants';
import type {
  CreateReportInput,
  ReportRow,
  ReportView,
} from './type/reports.types';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly alertsService: AlertsService,
  ) {}

  // ── create ────────────────────────────────────────────────────────────

  async createReport(
    userId: string,
    input: CreateReportInput,
  ): Promise<ReportView> {
    const { type, lat, lng } = input;
    const note = input.note?.trim() ? input.note.trim() : null;

    if (!isValidLat(lat) || !isValidLng(lng)) {
      throw new BadRequestException(
        `Invalid coordinates (lat=${lat}, lng=${lng}). Latitude must be between -90 and 90 and longitude between -180 and 180.`,
      );
    }

    // Geo-plausibility (build plan §16): if we know where the user is, the
    // report must be dropped nearby. If Redis is unavailable we log and skip
    // the check rather than blocking report creation.
    let presence: { lat: number; lng: number } | null = null;
    try {
      presence = await this.redis.getPresence(userId);
    } catch (err) {
      this.logger.error(
        `Could not read presence for geo-plausibility check (userId=${userId}); skipping the check`,
        err instanceof Error ? err.stack : String(err),
      );
    }
    if (
      presence &&
      haversineMeters(presence.lat, presence.lng, lat, lng) >
        REPORT_GEO_PLAUSIBILITY_M
    ) {
      throw new UnprocessableEntityException(
        'Reports must be dropped near your current location — you appear to be too far from this spot.',
      );
    }

    const expiresAt = new Date(Date.now() + REPORT_TTL_S[type] * 1000);
    const wkt = toWktPoint(lat, lng);

    const report = await this.prisma.$transaction(async (tx) => {
      const created = await tx.report.create({
        data: { reporterId: userId, type, lat, lng, note, expiresAt },
      });
      await tx.$executeRaw`
        UPDATE reports
        SET geog = ST_GeogFromText(${wkt})
        WHERE id = ${created.id}::uuid
      `;
      return created;
    });

    // Fan-out must never fail report creation: alerting is best-effort here.
    try {
      await this.alertsService.handleNewReport(report);
    } catch (err) {
      this.logger.error(
        `Alert fan-out failed for report ${report.id} (type=${report.type}, lat=${report.lat}, lng=${report.lng}) — the report was still created`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    // Clustering auto-verify is also best-effort and runs after the alert
    // fan-out: a failure here must never fail report creation.
    try {
      await this.clusterVerifyNearby(report);
    } catch (err) {
      this.logger.error(
        `Cluster auto-verify failed for report ${report.id} (type=${report.type}, lat=${report.lat}, lng=${report.lng}) — the report was still created`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    return this.toView(report);
  }

  // ── clustering auto-verify ────────────────────────────────────────────

  /**
   * Report clustering auto-verification (build plan §16): when enough active
   * same-type reports pile up near a fresh drop, the whole cluster is trusted
   * enough to promote to VERIFIED without waiting for individual confirm votes.
   *
   * Finds active (UNCONFIRMED|VERIFIED, unexpired) reports of the same type
   * within REPORT_CLUSTER_RADIUS_M of the new report (the new one included).
   * If the cluster is large enough, every still-UNCONFIRMED member is promoted
   * with a guarded updateMany so a concurrent voter/cluster pass cannot promote
   * (and reward) the same report twice.
   */
  async clusterVerifyNearby(report: Report): Promise<void> {
    const wkt = toWktPoint(report.lat, report.lng);

    const members = await this.prisma.$queryRaw<
      { id: string; reporterId: string; status: ReportStatus }[]
    >(Prisma.sql`
      SELECT id,
             reporter_id AS "reporterId",
             status
      FROM reports
      WHERE type = ${report.type}::report_type
        AND status IN ('UNCONFIRMED', 'VERIFIED')
        AND expires_at > now()
        AND ST_DWithin(geog, ST_GeogFromText(${wkt}), ${REPORT_CLUSTER_RADIUS_M})
    `);

    if (members.length < REPORT_CLUSTER_VERIFY_THRESHOLD) {
      return;
    }

    let promoted = 0;
    for (const member of members) {
      if (member.status !== ReportStatus.UNCONFIRMED) continue;

      // Guard the promotion on the UNCONFIRMED status so the reputation reward
      // is applied exactly once, mirroring the vote path.
      const transitioned = await this.prisma.report.updateMany({
        where: { id: member.id, status: ReportStatus.UNCONFIRMED },
        data: { status: ReportStatus.VERIFIED },
      });
      if (transitioned.count === 1) {
        promoted += 1;
        await this.prisma.user.update({
          where: { id: member.reporterId },
          data: { reputation: { increment: REPUTATION_REPORT_VERIFIED } },
        });
      }
    }

    if (promoted > 0) {
      this.logger.log(
        `Cluster-verified ${promoted} reports near (${report.lat},${report.lng})`,
      );
    }
  }

  // ── moderation / takedown ─────────────────────────────────────────────

  /**
   * Admin takedown (build plan §16/§17). Marks a report REMOVED with an audit
   * trail (who/why/when). Removed reports are already excluded from the map,
   * near, and bbox queries (they filter status IN ('UNCONFIRMED','VERIFIED')).
   * Returns the anonymized view — reporter identity is never exposed.
   */
  async removeReport(
    adminId: string,
    reportId: string,
    reason?: string,
  ): Promise<ReportView> {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });
    if (!report) {
      throw new NotFoundException(
        'Report not found — it may have already been removed or expired.',
      );
    }

    const removed = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        status: ReportStatus.REMOVED,
        removedById: adminId,
        removedReason: reason ?? null,
        removedAt: new Date(),
      },
    });

    this.logger.log(
      `Admin ${adminId} removed report ${reportId}: ${reason ?? '(no reason given)'}`,
    );

    return this.toView(removed);
  }

  // ── vote ──────────────────────────────────────────────────────────────

  async vote(
    userId: string,
    reportId: string,
    vote: 1 | -1,
  ): Promise<ReportView> {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });
    if (!report) {
      throw new NotFoundException(
        'Report not found — it may have been removed. Refresh the map and try again.',
      );
    }
    if (
      report.status !== ReportStatus.UNCONFIRMED &&
      report.status !== ReportStatus.VERIFIED
    ) {
      throw new ConflictException('This report is no longer active.');
    }
    if (report.reporterId === userId) {
      throw new ForbiddenException('You cannot vote on your own report.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent voters on this report. Their vote upserts touch
      // different (reportId,userId) PK rows and never block each other, so
      // without this lock two voters can both recount under READ COMMITTED
      // before either commits and persist an undercount. Holding a row lock on
      // the report until commit forces the recounts to run one at a time.
      await tx.$queryRaw`SELECT id FROM reports WHERE id = ${reportId}::uuid FOR UPDATE`;

      await tx.reportVote.upsert({
        where: { reportId_userId: { reportId, userId } },
        create: { reportId, userId, vote },
        update: { vote },
      });

      // Recount from the votes table (not increments) so vote changes and
      // retries stay idempotent.
      const [confirmCount, denyCount] = await Promise.all([
        tx.reportVote.count({ where: { reportId, vote: 1 } }),
        tx.reportVote.count({ where: { reportId, vote: -1 } }),
      ]);

      const fresh = await tx.report.findUniqueOrThrow({
        where: { id: reportId },
        select: { status: true, reporterId: true },
      });

      let nextStatus: ReportStatus = fresh.status;
      let reputationDelta = 0;
      if (
        denyCount >= REPORT_REJECT_THRESHOLD &&
        denyCount > confirmCount &&
        fresh.status !== ReportStatus.REJECTED
      ) {
        nextStatus = ReportStatus.REJECTED;
        reputationDelta = REPUTATION_REPORT_REJECTED;
      } else if (
        confirmCount >= REPORT_VERIFY_THRESHOLD &&
        fresh.status === ReportStatus.UNCONFIRMED
      ) {
        nextStatus = ReportStatus.VERIFIED;
        reputationDelta = REPUTATION_REPORT_VERIFIED;
      }

      if (nextStatus !== fresh.status) {
        // Guard the reputation delta on the status transition itself: the
        // conditional update only matches if the status is still what we read,
        // so a concurrent voter cannot apply the same delta twice.
        const transitioned = await tx.report.updateMany({
          where: { id: reportId, status: fresh.status },
          data: { status: nextStatus, confirmCount, denyCount },
        });
        if (transitioned.count === 1 && reputationDelta !== 0) {
          await tx.user.update({
            where: { id: fresh.reporterId },
            data: { reputation: { increment: reputationDelta } },
          });
        } else if (transitioned.count === 0) {
          // Lost the transition race — still persist the fresh recount.
          await tx.report.update({
            where: { id: reportId },
            data: { confirmCount, denyCount },
          });
        }
      } else {
        await tx.report.update({
          where: { id: reportId },
          data: { confirmCount, denyCount },
        });
      }

      return tx.report.findUniqueOrThrow({ where: { id: reportId } });
    });

    return this.toView(updated);
  }

  // ── queries ───────────────────────────────────────────────────────────

  async findByBbox(bbox: string, types?: string): Promise<ReportView[]> {
    const { minLng, minLat, maxLng, maxLat } = this.parseBbox(bbox);
    const typeList = this.parseTypes(types);
    const typeFilter =
      typeList && typeList.length > 0
        ? Prisma.sql`AND type::text IN (${Prisma.join(typeList)})`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<ReportRow[]>(Prisma.sql`
      SELECT id, type, status, lat, lng, note,
             confirm_count AS "confirmCount",
             deny_count    AS "denyCount",
             created_at    AS "createdAt",
             expires_at    AS "expiresAt"
      FROM reports
      WHERE status IN ('UNCONFIRMED', 'VERIFIED')
        AND expires_at > now()
        AND geog && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)::geography
        ${typeFilter}
      ORDER BY created_at DESC
      LIMIT ${REPORT_QUERY_LIMIT}
    `);
    return rows.map((row) => this.rowToView(row));
  }

  async findNear(
    lat: number,
    lng: number,
    radiusM: number,
    types?: string,
  ): Promise<ReportView[]> {
    if (!isValidLat(lat) || !isValidLng(lng)) {
      throw new BadRequestException(
        `Invalid coordinates (lat=${lat}, lng=${lng}). Latitude must be between -90 and 90 and longitude between -180 and 180.`,
      );
    }
    if (
      !Number.isFinite(radiusM) ||
      radiusM <= 0 ||
      radiusM > REPORT_NEAR_MAX_RADIUS_M
    ) {
      throw new BadRequestException(
        `radiusM must be between 1 and ${REPORT_NEAR_MAX_RADIUS_M} metres — got ${radiusM}.`,
      );
    }

    const typeList = this.parseTypes(types);
    const typeFilter =
      typeList && typeList.length > 0
        ? Prisma.sql`AND type::text IN (${Prisma.join(typeList)})`
        : Prisma.empty;

    const wkt = toWktPoint(lat, lng);
    const rows = await this.prisma.$queryRaw<ReportRow[]>(Prisma.sql`
      SELECT id, type, status, lat, lng, note,
             confirm_count AS "confirmCount",
             deny_count    AS "denyCount",
             created_at    AS "createdAt",
             expires_at    AS "expiresAt"
      FROM reports
      WHERE status IN ('UNCONFIRMED', 'VERIFIED')
        AND expires_at > now()
        AND ST_DWithin(geog, ST_GeogFromText(${wkt}), ${radiusM})
        ${typeFilter}
      ORDER BY created_at DESC
      LIMIT ${REPORT_QUERY_LIMIT}
    `);
    return rows.map((row) => this.rowToView(row));
  }

  async getById(reportId: string): Promise<ReportView> {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });
    if (!report) {
      throw new NotFoundException(
        'Report not found — it may have been removed. Refresh the map and try again.',
      );
    }
    return this.toView(report);
  }

  // ── expiry cron ───────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_5_MINUTES)
  async expireStale(): Promise<void> {
    try {
      const { count } = await this.prisma.report.updateMany({
        where: {
          status: { in: [ReportStatus.UNCONFIRMED, ReportStatus.VERIFIED] },
          expiresAt: { lt: new Date() },
        },
        data: { status: ReportStatus.EXPIRED },
      });
      if (count > 0) {
        this.logger.log(`Expired ${count} stale reports`);
      }
    } catch (err) {
      this.logger.error(
        'Report expiry cron failed — stale reports will be retried on the next run',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private parseBbox(bbox: string): {
    minLng: number;
    minLat: number;
    maxLng: number;
    maxLat: number;
  } {
    const parts = bbox.split(',').map((p) => Number(p.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw new BadRequestException(
        `Invalid bbox "${bbox}". ${BBOX_FORMAT_HINT}`,
      );
    }
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (
      !isValidLng(minLng) ||
      !isValidLng(maxLng) ||
      !isValidLat(minLat) ||
      !isValidLat(maxLat) ||
      minLng > maxLng ||
      minLat > maxLat
    ) {
      throw new BadRequestException(
        `Invalid bbox "${bbox}": coordinates out of range or min greater than max. ${BBOX_FORMAT_HINT}`,
      );
    }
    return { minLng, minLat, maxLng, maxLat };
  }

  private parseTypes(types?: string): ReportType[] | undefined {
    if (!types || types.trim() === '') return undefined;
    const validTypes = Object.values(ReportType);
    const parsed = types
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t !== '');
    const invalid = parsed.filter((t) => !validTypes.includes(t as ReportType));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Unknown report type(s): ${invalid.join(', ')}. Valid types: ${validTypes.join(', ')}.`,
      );
    }
    return parsed as ReportType[];
  }

  /** Strips the reporter's identity — never expose reporterId (privacy §17). */
  private toView(report: Report): ReportView {
    return {
      id: report.id,
      type: report.type,
      status: report.status,
      lat: report.lat,
      lng: report.lng,
      note: report.note,
      confirmCount: report.confirmCount,
      denyCount: report.denyCount,
      createdAt: report.createdAt,
      expiresAt: report.expiresAt,
    };
  }

  private rowToView(row: ReportRow): ReportView {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      lat: row.lat,
      lng: row.lng,
      note: row.note,
      confirmCount: row.confirmCount,
      denyCount: row.denyCount,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }
}
