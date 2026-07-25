import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Trip, TripStatus } from '@prisma/client';
import { TokensService } from '../auth/tokens.service';
import { TripShareTokenService } from '../auth/trip-share-token.service';
import {
  AUTO_ARRIVAL_RADIUS_M,
  TRIP_POINTS_MAX_BATCH,
} from '../../common/constants';
import { EntitlementsService } from '../../common/entitlements';
import { AuthenticatedUser } from '../../common/types/auth.types';
import {
  haversineMeters,
  toWktLineString,
  toWktPoint,
} from '../../common/utils/geo.util';
import { DirectionsService } from '../../providers/google/directions.service';
import { NotificationsService } from '../notification/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { channelTripLive } from '../../providers/redis/constant/redis.constants';
import { RedisService } from '../../providers/redis/redis.service';
import { UsersService } from '../user/users.service';
import { AddPointsDto, TripPointDto } from './dto/add-points.dto';
import { CreateTripDto } from './dto/create-trip.dto';
import { ListTripsQueryDto } from './dto/list-trips.query.dto';
import { StopTripDto } from './dto/stop-trip.dto';
import {
  LIVE_LINK_INVALID_MSG,
  LIVE_VIEW_POINT_LIMIT,
  LIVE_VIEW_REPORT_LIMIT,
  LIVE_VIEW_REPORT_RADIUS_M,
  TRIP_DETAIL_POINT_LIMIT,
  TRIP_NOT_FOUND_MSG,
} from './constant/trips.constants';
import type {
  LiveViewReport,
  RouteGeoJsonRow,
  TripHistoryWindow,
  TripPointView,
} from './type/trips.types';

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly directions: DirectionsService,
    private readonly tokens: TokensService,
    private readonly tripShareTokens: TripShareTokenService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ── contract exports (used by realtime + sos) ─────────────────────────

  async getActiveTripForUser(userId: string): Promise<Trip | null> {
    return this.prisma.trip.findFirst({
      where: { userId, status: TripStatus.ACTIVE },
    });
  }

  /**
   * userIds of watcher contacts that are linked app users AND have consented
   * (added the trip owner back as their own trusted contact). Gating here keeps
   * unsolicited live-trip pushes/room access off a stranger's account; the
   * share-token link remains the owner's explicit opt-in channel for anyone.
   */
  async getWatcherUserIds(tripId: string): Promise<string[]> {
    const watchers = await this.prisma.tripWatcher.findMany({
      where: { tripId, contact: { contactUserId: { not: null } } },
      select: {
        trip: { select: { userId: true } },
        contact: { select: { contactUserId: true } },
      },
    });
    if (watchers.length === 0) return [];
    const ownerId = watchers[0].trip.userId;
    const candidates = watchers
      .map((w) => w.contact.contactUserId)
      .filter((id): id is string => id !== null);
    return this.users.filterConsentingContactUserIds(ownerId, candidates);
  }

  /**
   * Issues a fresh share token for the trip's current version and returns the
   * live-view URL — the same link watchers get on trip start. Exposed for the
   * trip-monitor cron's no-arrival contact alert.
   */
  buildLiveShareUrl(tripId: string, shareTokenVersion: number): string {
    const share = this.tripShareTokens.issue(tripId, shareTokenVersion);
    return this.buildShareUrl(tripId, share.token);
  }

  async getTripOwnerId(tripId: string): Promise<string | null> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { userId: true },
    });
    return trip?.userId ?? null;
  }

  /**
   * True when the share token is valid for this trip AND its embedded version
   * matches the trip's current one (a reissue revokes older links). Used by the
   * realtime gateway to gate live-room access the same way the HTTP live view
   * does.
   */
  async isValidShareToken(
    tripId: string,
    shareToken: string,
  ): Promise<boolean> {
    let version: number;
    try {
      const payload = this.tripShareTokens.verify(shareToken);
      if (payload.tripId !== tripId) return false;
      version = payload.v;
    } catch {
      return false;
    }
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { shareTokenVersion: true },
    });
    return trip !== null && trip.shareTokenVersion === version;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  async createTrip(
    user: AuthenticatedUser,
    dto: CreateTripDto,
  ): Promise<{
    trip: Trip;
    shareToken: string;
    shareTokenExpiresAt: Date;
    shareUrl: string;
  }> {
    const active = await this.getActiveTripForUser(user.id);
    if (active) {
      throw new ConflictException(
        'You already have an active trip — stop or cancel it before starting a new one.',
      );
    }

    // Validate watcher contacts belong to the caller.
    const watcherContactIds = [...new Set(dto.watcherContactIds ?? [])];
    const contacts =
      watcherContactIds.length > 0
        ? await this.prisma.trustedContact.findMany({
            where: { id: { in: watcherContactIds }, userId: user.id },
            select: { id: true, contactUserId: true },
          })
        : [];
    const foundIds = new Set(contacts.map((c) => c.id));
    const badIds = watcherContactIds.filter((id) => !foundIds.has(id));
    if (badIds.length > 0) {
      throw new BadRequestException(
        `These watcher contact ids are not in your trusted contacts: ${badIds.join(', ')}. Remove them or add the contacts first.`,
      );
    }

    // Corridor: Google Directions with straight-line fallback (never throws).
    const route = await this.directions.getRoute({
      origin: { lat: dto.origin.lat, lng: dto.origin.lng },
      destination: { lat: dto.destination.lat, lng: dto.destination.lng },
      mode: dto.mode,
    });
    const pathPoints =
      route && route.points.length >= 2
        ? route.points
        : [
            { lat: dto.origin.lat, lng: dto.origin.lng },
            { lat: dto.destination.lat, lng: dto.destination.lng },
          ];
    const routeSource = route ? 'directions' : 'straight_line';
    const expectedDurationS = dto.expectedDurationS ?? route?.durationS ?? null;

    const originWkt = toWktPoint(dto.origin.lat, dto.origin.lng);
    const destWkt = toWktPoint(dto.destination.lat, dto.destination.lng);
    const pathWkt = toWktLineString(pathPoints);

    let trip: Trip;
    try {
      trip = await this.prisma.$transaction(async (tx) => {
        const created = await tx.trip.create({
          data: {
            userId: user.id,
            mode: dto.mode,
            originLabel: dto.origin.label ?? null,
            destLabel: dto.destination.label ?? null,
            originLat: dto.origin.lat,
            originLng: dto.origin.lng,
            destLat: dto.destination.lat,
            destLng: dto.destination.lng,
            expectedDurationS,
          },
        });

        await tx.$executeRaw`
        UPDATE trips
        SET origin = ST_GeogFromText(${originWkt}),
            destination = ST_GeogFromText(${destWkt})
        WHERE id = ${created.id}::uuid`;

        if (watcherContactIds.length > 0) {
          await tx.tripWatcher.createMany({
            data: watcherContactIds.map((contactId) => ({
              tripId: created.id,
              contactId,
            })),
          });
        }

        await tx.tripRoute.create({
          data: { tripId: created.id, source: routeSource },
        });
        await tx.$executeRaw`
        UPDATE trip_routes
        SET path = ST_GeogFromText(${pathWkt})
        WHERE trip_id = ${created.id}::uuid`;

        return created;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // The partial unique index caught a second ACTIVE trip created in the
        // TOCTOU window after the pre-check above — surface the same 409.
        throw new ConflictException(
          'You already have an active trip — stop or cancel it before starting a new one.',
        );
      }
      throw err;
    }

    const share = this.tripShareTokens.issue(trip.id, trip.shareTokenVersion);
    const shareUrl = this.buildShareUrl(trip.id, share.token);

    await this.safePublish(channelTripLive(trip.id), {
      kind: 'status',
      tripId: trip.id,
      status: TripStatus.ACTIVE,
    });

    // Notify linked watcher users (best effort — never fails the request).
    const watcherUserIds = [
      ...new Set(
        contacts
          .map((c) => c.contactUserId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (watcherUserIds.length > 0) {
      try {
        const owner = await this.users.findById(user.id);
        const ownerName = owner?.name ?? 'Someone you know';
        const destination = trip.destLabel ?? 'their destination';
        await this.notifications.sendToUsers(watcherUserIds, {
          title: 'Trip started',
          body: `${ownerName} started a trip to ${destination} — follow along live.`,
          data: { tripId: trip.id, shareUrl },
        });
      } catch (err) {
        this.logger.error(
          `Failed to send trip-started notifications for trip ${trip.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return {
      trip,
      shareToken: share.token,
      shareTokenExpiresAt: share.expiresAt,
      shareUrl,
    };
  }

  async addPoints(
    user: AuthenticatedUser,
    tripId: string,
    dto: AddPointsDto,
  ): Promise<{ accepted: number; autoCompleted: boolean }> {
    const trip = await this.getOwnedTrip(user.id, tripId);
    if (trip.status !== TripStatus.ACTIVE) {
      throw new ConflictException(
        `This trip is ${trip.status.toLowerCase()} — location points can only be added to an active trip.`,
      );
    }
    if (dto.points.length > TRIP_POINTS_MAX_BATCH) {
      throw new BadRequestException(
        `Too many points in one batch (${dto.points.length}) — send at most ${TRIP_POINTS_MAX_BATCH} per request.`,
      );
    }

    await this.insertPoints(tripId, dto.points);

    const latest = [...dto.points].sort(
      (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime(),
    )[dto.points.length - 1];

    // Track the freshest breadcrumb so the stall detector (trip-monitor cron)
    // can tell a moving trip from one that has gone silent. Clamp future
    // timestamps to now so a bad client clock can't push lastPointAt ahead.
    const newestAt = latest.recordedAt;
    const lastPointAt = newestAt.getTime() > Date.now() ? new Date() : newestAt;
    await this.prisma.trip.update({
      where: { id: tripId },
      data: { lastPointAt },
    });

    try {
      await this.redis.updatePresence(user.id, latest.lat, latest.lng);
    } catch (err) {
      this.logger.error(
        `Failed to update presence for user ${user.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    await this.safePublish(channelTripLive(tripId), {
      kind: 'position',
      tripId,
      point: {
        lat: latest.lat,
        lng: latest.lng,
        speed: latest.speed,
        heading: latest.heading,
        recordedAt: latest.recordedAt.toISOString(),
      },
    });

    // Auto-arrival: latest breadcrumb inside the destination geofence.
    const distanceToDest = haversineMeters(
      latest.lat,
      latest.lng,
      trip.destLat,
      trip.destLng,
    );
    if (distanceToDest <= AUTO_ARRIVAL_RADIUS_M) {
      await this.completeTrip(trip, TripStatus.COMPLETED);
      return { accepted: dto.points.length, autoCompleted: true };
    }

    return { accepted: dto.points.length, autoCompleted: false };
  }

  async stopTrip(
    user: AuthenticatedUser,
    tripId: string,
    dto: StopTripDto,
  ): Promise<{ trip: Trip }> {
    const trip = await this.getOwnedTrip(user.id, tripId);
    this.assertStoppable(trip, 'stop');

    // Record the final position when the client provides one.
    if (dto.lat !== undefined && dto.lng !== undefined) {
      await this.insertPoints(tripId, [
        { lat: dto.lat, lng: dto.lng, recordedAt: new Date() },
      ]);
      try {
        await this.redis.updatePresence(user.id, dto.lat, dto.lng);
      } catch (err) {
        this.logger.error(
          `Failed to update presence for user ${user.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    const updated = await this.completeTrip(trip, TripStatus.COMPLETED);
    return { trip: updated };
  }

  async cancelTrip(
    user: AuthenticatedUser,
    tripId: string,
  ): Promise<{ trip: Trip }> {
    const trip = await this.getOwnedTrip(user.id, tripId);
    this.assertStoppable(trip, 'cancel');
    const updated = await this.completeTrip(trip, TripStatus.CANCELLED);
    return { trip: updated };
  }

  /**
   * "I'm OK" response to an overdue/stall nudge: records the check-in and
   * resets the escalation ladder (clears overdueNotifiedAt/escalatedAt) so the
   * trip-monitor cron starts fresh and won't alert contacts on stale state.
   */
  async checkin(
    user: AuthenticatedUser,
    tripId: string,
  ): Promise<{ ok: true; checkinAt: Date }> {
    const trip = await this.getOwnedTrip(user.id, tripId);
    if (trip.status !== TripStatus.ACTIVE) {
      throw new ConflictException('This trip is not active.');
    }

    const checkinAt = new Date();
    await this.prisma.trip.update({
      where: { id: trip.id },
      data: {
        checkinAt,
        overdueNotifiedAt: null,
        escalatedAt: null,
      },
    });

    await this.safePublish(channelTripLive(trip.id), {
      kind: 'status',
      tripId: trip.id,
      status: TripStatus.ACTIVE,
      checkedIn: true,
    });

    return { ok: true, checkinAt };
  }

  /**
   * GDPR "delete trip history" action: permanently removes the trip and its
   * children (points, route, watchers cascade; alerts have tripId set null).
   * Owner-only, and refused while the trip is still ACTIVE so a live trip
   * can't be deleted out from under its watchers — stop or cancel it first.
   */
  async deleteTrip(user: AuthenticatedUser, tripId: string): Promise<void> {
    const trip = await this.getOwnedTrip(user.id, tripId);
    if (trip.status === TripStatus.ACTIVE) {
      throw new ConflictException(
        'Stop or cancel this trip before deleting it.',
      );
    }
    await this.prisma.trip.delete({ where: { id: trip.id } });
  }

  // ── queries ───────────────────────────────────────────────────────────

  /**
   * The paginated history.
   *
   * PLAN RETENTION (build plan §20, `tripHistoryDays`): the plan's window is
   * reported on every response as `retention`, and applied via `window.since` —
   * which EntitlementsService returns as null whenever ENFORCE_PLAN_LIMITS is
   * off. That is the shipping state, so the `where` below is identical to the
   * one that existed before plans did, and no user loses a single trip. When the
   * switch is flipped, `since` becomes a date and this same line narrows the
   * window; there is no second code path to keep in sync.
   *
   * Only the LIST and the STATS are narrowed. `GET /trips/:id` is deliberately
   * not — refusing to open a trip the user already has a link to would take away
   * more than the plan promises, and it is their own data either way.
   */
  async listTrips(
    userId: string,
    query: ListTripsQueryDto,
  ): Promise<{
    trips: Trip[];
    total: number;
    page: number;
    limit: number;
    retention: TripHistoryWindow;
  }> {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const window = await this.entitlements.getWindow(userId, 'tripHistoryDays');
    const where: Prisma.TripWhereInput = {
      userId,
      ...(query.status ? { status: query.status } : {}),
      // `since` is null unless enforcement is on ⇒ no filter at all today.
      ...(window.since ? { startedAt: { gte: window.since } } : {}),
    };
    const [trips, total] = await this.prisma.$transaction([
      this.prisma.trip.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.trip.count({ where }),
    ]);
    return {
      trips,
      total,
      page,
      limit,
      retention: {
        planCode: window.planCode,
        enforced: window.enforced,
        windowDays: window.windowDays,
        since: window.since,
        wouldApplySince: window.wouldApplySince,
        coversEverything: window.since === null,
      },
    };
  }

  async getTrip(
    userId: string,
    tripId: string,
  ): Promise<{
    trip: Trip;
    route: { source: string | null; geojson: unknown } | null;
    points: TripPointView[];
  }> {
    const trip = await this.getOwnedTrip(userId, tripId);

    const routeRows = await this.prisma.$queryRaw<RouteGeoJsonRow[]>`
      SELECT source, ST_AsGeoJSON(path) AS geojson
      FROM trip_routes
      WHERE trip_id = ${tripId}::uuid`;
    const routeRow = routeRows[0];
    const route = routeRow
      ? {
          source: routeRow.source,
          geojson: routeRow.geojson
            ? (JSON.parse(routeRow.geojson) as unknown)
            : null,
        }
      : null;

    const points = await this.lastPoints(tripId, TRIP_DETAIL_POINT_LIMIT);
    return { trip, route, points };
  }

  async getLiveView(
    tripId: string,
    shareToken?: string,
    authorizationHeader?: string,
  ): Promise<{
    trip: {
      id: string;
      mode: string;
      status: string;
      originLabel: string | null;
      destLabel: string | null;
      originLat: number;
      originLng: number;
      destLat: number;
      destLng: number;
      startedAt: Date;
      endedAt: Date | null;
      durationS: number | null;
      expectedDurationS: number | null;
      owner: { name: string };
    };
    lastPoints: TripPointView[];
    activeReports: LiveViewReport[];
  }> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: { user: { select: { name: true } } },
    });
    // A missing trip gets the same 401 as a bad token — never leak existence
    // to unauthenticated callers.
    if (!trip) throw new UnauthorizedException(LIVE_LINK_INVALID_MSG);

    let authorized = false;

    if (shareToken) {
      try {
        const payload = this.tripShareTokens.verify(shareToken);
        // Version must match the trip's current one — a reissue bumps it and
        // instantly invalidates every older link.
        if (payload.tripId === tripId && payload.v === trip.shareTokenVersion) {
          authorized = true;
        }
      } catch {
        // Invalid share token — a valid bearer may still grant access below.
      }
    }

    if (!authorized && authorizationHeader) {
      const bearer = /^Bearer\s+(.+)$/i.exec(authorizationHeader)?.[1];
      if (bearer) {
        try {
          const payload = this.tokens.verifyAccessToken(bearer);
          if (payload.sub === trip.userId) {
            authorized = true;
          } else {
            const watcherIds = await this.getWatcherUserIds(tripId);
            authorized = watcherIds.includes(payload.sub);
          }
        } catch {
          // Invalid bearer — fall through to the 401 below.
        }
      }
    }

    if (!authorized) throw new UnauthorizedException(LIVE_LINK_INVALID_MSG);

    const [lastPoints, activeReports] = await Promise.all([
      this.lastPoints(tripId, LIVE_VIEW_POINT_LIMIT),
      this.activeReportsNearCorridor(tripId, trip.destLat, trip.destLng),
    ]);

    return {
      trip: {
        id: trip.id,
        mode: trip.mode,
        status: trip.status,
        originLabel: trip.originLabel,
        destLabel: trip.destLabel,
        originLat: trip.originLat,
        originLng: trip.originLng,
        destLat: trip.destLat,
        destLng: trip.destLng,
        startedAt: trip.startedAt,
        endedAt: trip.endedAt,
        durationS: trip.durationS,
        expectedDurationS: trip.expectedDurationS,
        owner: { name: trip.user.name },
      },
      lastPoints,
      activeReports,
    };
  }

  async reissueShareToken(
    user: AuthenticatedUser,
    tripId: string,
  ): Promise<{
    shareToken: string;
    shareTokenExpiresAt: Date;
    shareUrl: string;
  }> {
    const trip = await this.getOwnedTrip(user.id, tripId);
    // Bump the version so every previously-issued share link stops working —
    // this is how a leaked link is revoked.
    const updated = await this.prisma.trip.update({
      where: { id: trip.id },
      data: { shareTokenVersion: { increment: 1 } },
      select: { shareTokenVersion: true },
    });
    const share = this.tripShareTokens.issue(
      trip.id,
      updated.shareTokenVersion,
    );
    return {
      shareToken: share.token,
      shareTokenExpiresAt: share.expiresAt,
      shareUrl: this.buildShareUrl(trip.id, share.token),
    };
  }

  // ── internals ─────────────────────────────────────────────────────────

  /** 404 (not 403) when the trip is missing OR owned by someone else — no leaks. */
  private async getOwnedTrip(userId: string, tripId: string): Promise<Trip> {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip || trip.userId !== userId) {
      throw new NotFoundException(TRIP_NOT_FOUND_MSG);
    }
    return trip;
  }

  private assertStoppable(trip: Trip, action: 'stop' | 'cancel'): void {
    if (trip.status !== TripStatus.ACTIVE && trip.status !== TripStatus.SOS) {
      throw new ConflictException(
        `This trip is already ${trip.status.toLowerCase()} — there is nothing to ${action}.`,
      );
    }
  }

  /**
   * Shared completion routine (stop, cancel, auto-arrival): sets endedAt +
   * durationS, publishes the status message, and — on COMPLETED only — sends
   * the safe-arrival push to linked watchers.
   */
  private async completeTrip(
    trip: Trip,
    status: typeof TripStatus.COMPLETED | typeof TripStatus.CANCELLED,
  ): Promise<Trip> {
    const endedAt = new Date();
    const durationS = Math.max(
      0,
      Math.floor((endedAt.getTime() - trip.startedAt.getTime()) / 1000),
    );

    // Conditional transition: only the request that actually flips ACTIVE→ended
    // wins. Guards a double stop, or stop racing an auto-arrival, from
    // double-firing the status publish and the safe-arrival push.
    const { count } = await this.prisma.trip.updateMany({
      where: { id: trip.id, status: TripStatus.ACTIVE },
      data: { status, endedAt, durationS },
    });
    const updated = await this.prisma.trip.findUniqueOrThrow({
      where: { id: trip.id },
    });
    if (count === 0) {
      // Lost the race — another request already ended this trip. Do not
      // re-publish or re-notify; just return the current state.
      return updated;
    }

    // The trip is over — the owner's last position should not linger in the
    // shared presence set (data minimisation, plan §17).
    await this.redis.clearPresence(trip.userId).catch((err: unknown) => {
      this.logger.error(
        `Failed to clear presence after completing trip ${trip.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    });

    await this.safePublish(channelTripLive(trip.id), {
      kind: 'status',
      tripId: trip.id,
      status,
      endedAt: endedAt.toISOString(),
      durationS,
    });

    if (status === TripStatus.COMPLETED) {
      try {
        const watcherUserIds = await this.getWatcherUserIds(trip.id);
        if (watcherUserIds.length > 0) {
          const owner = await this.users.findById(trip.userId);
          const ownerName = owner?.name ?? 'Your contact';
          const destination = trip.destLabel ?? 'their destination';
          await this.notifications.sendToUsers(watcherUserIds, {
            title: 'Safe arrival',
            body: `${ownerName} arrived safely at ${destination}.`,
            data: { tripId: trip.id },
          });
        }
      } catch (err) {
        this.logger.error(
          `Failed to send safe-arrival notifications for trip ${trip.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return updated;
  }

  /** Single multi-row INSERT of breadcrumbs with geography set per row. */
  private async insertPoints(
    tripId: string,
    points: Array<
      Pick<TripPointDto, 'lat' | 'lng' | 'recordedAt'> &
        Partial<Pick<TripPointDto, 'speed' | 'heading' | 'accuracy'>>
    >,
  ): Promise<void> {
    const rows = points.map(
      (p) =>
        Prisma.sql`(${tripId}::uuid, ${p.lat}, ${p.lng}, ${p.speed ?? null}, ${p.heading ?? null}, ${p.accuracy ?? null}, ${p.recordedAt}, ST_GeogFromText(${toWktPoint(p.lat, p.lng)}))`,
    );
    await this.prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO trip_points (trip_id, lat, lng, speed, heading, accuracy, recorded_at, geog)
        VALUES ${Prisma.join(rows)}`,
    );
  }

  /** Last N breadcrumbs in chronological order, without BigInt row ids. */
  private async lastPoints(
    tripId: string,
    limit: number,
  ): Promise<TripPointView[]> {
    const points = await this.prisma.tripPoint.findMany({
      where: { tripId },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return points.reverse().map((p) => ({
      lat: p.lat,
      lng: p.lng,
      speed: p.speed,
      heading: p.heading,
      accuracy: p.accuracy,
      recordedAt: p.recordedAt,
    }));
  }

  /**
   * Active (UNCONFIRMED|VERIFIED, unexpired) reports within
   * LIVE_VIEW_REPORT_RADIUS_M of the trip corridor; falls back to the
   * destination point when no corridor path exists. Anonymized — no reporter.
   * Degrades to an empty list on failure (the live position stream is the
   * core of this view).
   */
  private async activeReportsNearCorridor(
    tripId: string,
    destLat: number,
    destLng: number,
  ): Promise<LiveViewReport[]> {
    try {
      const destWkt = toWktPoint(destLat, destLng);
      const rows = await this.prisma.$queryRaw<LiveViewReport[]>(
        Prisma.sql`
          SELECT r.id,
                 r.type::text   AS type,
                 r.status::text AS status,
                 r.lat,
                 r.lng,
                 r.note,
                 r.confirm_count AS "confirmCount",
                 r.deny_count    AS "denyCount",
                 r.created_at    AS "createdAt",
                 r.expires_at    AS "expiresAt"
          FROM reports r
          LEFT JOIN trip_routes tr
            ON tr.trip_id = ${tripId}::uuid AND tr.path IS NOT NULL
          WHERE r.status::text IN ('UNCONFIRMED', 'VERIFIED')
            AND r.expires_at > now()
            AND r.geog IS NOT NULL
            AND ST_DWithin(
              r.geog,
              COALESCE(tr.path, ST_GeogFromText(${destWkt})),
              ${LIVE_VIEW_REPORT_RADIUS_M}
            )
          ORDER BY r.created_at DESC
          LIMIT ${LIVE_VIEW_REPORT_LIMIT}`,
      );
      return rows;
    } catch (err) {
      this.logger.error(
        `Failed to load active reports for trip ${tripId} live view — returning none`,
        err instanceof Error ? err.stack : String(err),
      );
      return [];
    }
  }

  private buildShareUrl(tripId: string, token: string): string {
    const port = this.config.get<string | number>('PORT') ?? 3000;
    const base =
      this.config.get<string>('API_BASE_URL') ?? `http://localhost:${port}`;
    return `${base.replace(/\/+$/, '')}/trips/${tripId}/live?token=${encodeURIComponent(token)}`;
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
