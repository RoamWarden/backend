import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TripStatus } from '@prisma/client';
import type { Trip } from '@prisma/client';
import { TripShareTokenService } from '../auth/trip-share-token.service';
import { AuthenticatedUser } from '../../common/types/auth.types';
import { NotificationsService } from '../notification/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CHANNEL_SOS,
  channelTripLive,
} from '../../providers/redis/constant/redis.constants';
import { RedisService } from '../../providers/redis/redis.service';
import { TripsService } from '../trip/trips.service';
import { UsersService } from '../user/users.service';
import { RaiseSosDto } from './dto/raise-sos.dto';
import {
  NOTIFY_FAILED_WARNING,
  NO_CONTACTS_WARNING,
  NO_LINKED_CONTACTS_WARNING,
  SOS_NOT_FOUND_MSG,
  TRIP_NOT_FOUND_MSG,
} from './constant/sos.constants';
import type { RaiseSosResult, SosRaisedMessage } from './type/sos.types';

/**
 * SOS handling (build plan §14/§17).
 *
 * RoamWarden is not an emergency service — clients must always also surface
 * local emergency numbers (plan §17). Raising an SOS records the event and
 * alerts the user's trusted contacts; it never calls the authorities.
 *
 * The event row is the source of truth: once it is written, every downstream
 * step (share link, pub/sub fan-out, push) is best-effort and degrades to a
 * `warning` in the response instead of failing the request — an SOS must not
 * be lost to a notification hiccup.
 */
@Injectable()
export class SosService {
  private readonly logger = new Logger(SosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly trips: TripsService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly tripShareTokens: TripShareTokenService,
  ) {}

  async raise(
    user: AuthenticatedUser,
    dto: RaiseSosDto,
  ): Promise<RaiseSosResult> {
    if ((dto.lat === undefined) !== (dto.lng === undefined)) {
      throw new BadRequestException(
        'Provide both lat and lng together, or omit both — without coordinates the SOS falls back to your last known location.',
      );
    }

    // Resolve the trip this SOS belongs to: an explicit id (must be the
    // caller's own trip) or the caller's current active trip, if any.
    let trip: Trip | null = null;
    if (dto.tripId) {
      const found = await this.prisma.trip.findUnique({
        where: { id: dto.tripId },
      });
      // 404 (not 403) when missing OR someone else's — never leak existence.
      if (!found || found.userId !== user.id) {
        throw new NotFoundException(TRIP_NOT_FOUND_MSG);
      }
      trip = found;
    } else {
      trip = await this.trips.getActiveTripForUser(user.id);
    }

    const coords = await this.resolveCoordinates(user.id, dto, trip);
    const wasActive = trip?.status === TripStatus.ACTIVE;

    const event = await this.prisma.$transaction(async (tx) => {
      const created = await tx.sosEvent.create({
        data: {
          userId: user.id,
          tripId: trip?.id ?? null,
          lat: coords?.lat ?? null,
          lng: coords?.lng ?? null,
          message: dto.message ?? null,
        },
      });
      if (trip && wasActive) {
        await tx.trip.update({
          where: { id: trip.id },
          data: { status: TripStatus.SOS },
        });
      }
      return created;
    });

    this.logger.warn(
      `SOS ${event.id} raised by user ${user.id}${trip ? ` on trip ${trip.id}` : ' (no trip)'}`,
    );

    if (trip && wasActive) {
      await this.safePublish(channelTripLive(trip.id), {
        kind: 'status',
        tripId: trip.id,
        status: TripStatus.SOS,
      });
    }

    // Best-effort from here on: the SOS row exists, so failures degrade to a
    // warning in the response instead of a 5xx (never silently, always logged).
    let shareUrl: string | undefined;
    let notifiedContactCount = 0;
    let warning: string | undefined;
    try {
      if (trip) {
        const share = this.tripShareTokens.issue(
          trip.id,
          trip.shareTokenVersion,
        );
        shareUrl = this.buildShareUrl(trip.id, share.token);
      }

      const contacts = await this.users.getTrustedContacts(user.id);
      if (contacts.length === 0) {
        warning = NO_CONTACTS_WARNING;
      } else {
        const linkedIds = contacts
          .map((c) => c.contactUserId)
          .filter((id): id is string => id !== null);
        // Only push to accounts that consented by adding this user back —
        // an SOS must not surface a stranger's live location to someone who
        // merely got saved as a contact without reciprocating.
        const contactUserIds = await this.users.filterConsentingContactUserIds(
          user.id,
          linkedIds,
        );
        if (contactUserIds.length === 0) {
          warning = NO_LINKED_CONTACTS_WARNING;
        } else {
          const owner = await this.users.findById(user.id);
          const name = owner?.name ?? 'Your contact';

          const sosMessage: SosRaisedMessage = {
            sosId: event.id,
            user: { id: user.id, name },
            ...(trip ? { tripId: trip.id } : {}),
            ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
            ...(dto.message ? { message: dto.message } : {}),
            contactUserIds,
            raisedAt: event.createdAt.toISOString(),
          };
          await this.safePublish(CHANNEL_SOS, sosMessage);

          // NotificationsService never throws — push is best-effort by design.
          await this.notifications.sendToUsers(contactUserIds, {
            title: `🆘 ${name} needs help`,
            body:
              dto.message ??
              `${name} triggered SOS — tap to see their live location.`,
            data: {
              sosId: event.id,
              ...(trip ? { tripId: trip.id } : {}),
              ...(shareUrl ? { shareUrl } : {}),
            },
          });
          notifiedContactCount = contactUserIds.length;
        }
      }
    } catch (err) {
      this.logger.error(
        `SOS ${event.id} was recorded but notifying contacts failed`,
        err instanceof Error ? err.stack : String(err),
      );
      warning = NOTIFY_FAILED_WARNING;
    }

    return {
      sosId: event.id,
      notifiedContactCount,
      ...(shareUrl !== undefined ? { shareUrl } : {}),
      ...(warning !== undefined ? { warning } : {}),
    };
  }

  async resolve(
    user: AuthenticatedUser,
    sosId: string,
  ): Promise<{ sosId: string; resolvedAt: Date }> {
    const event = await this.prisma.sosEvent.findUnique({
      where: { id: sosId },
    });
    // 404 (not 403) when missing OR someone else's — never leak existence.
    if (!event || event.userId !== user.id) {
      throw new NotFoundException(SOS_NOT_FOUND_MSG);
    }
    if (event.resolvedAt) {
      // Already resolved — idempotent OK.
      return { sosId: event.id, resolvedAt: event.resolvedAt };
    }

    const resolvedAt = new Date();
    await this.prisma.sosEvent.update({
      where: { id: event.id },
      data: { resolvedAt },
    });
    this.logger.log(`SOS ${event.id} resolved by user ${user.id}`);
    return { sosId: event.id, resolvedAt };
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * Best position for the SOS: explicit dto coordinates, else the user's last
   * known presence, else the trip origin, else null (the event still stands).
   */
  private async resolveCoordinates(
    userId: string,
    dto: RaiseSosDto,
    trip: Trip | null,
  ): Promise<{ lat: number; lng: number } | null> {
    if (dto.lat !== undefined && dto.lng !== undefined) {
      return { lat: dto.lat, lng: dto.lng };
    }
    try {
      const presence = await this.redis.getPresence(userId);
      if (presence) return presence;
    } catch (err) {
      this.logger.error(
        `Failed to read presence for user ${userId} while raising SOS — falling back to trip origin`,
        err instanceof Error ? err.stack : String(err),
      );
    }
    if (trip) return { lat: trip.originLat, lng: trip.originLng };
    return null;
  }

  /** Mirrors TripsService.buildShareUrl — the public live-view link. */
  private buildShareUrl(tripId: string, token: string): string {
    const port = this.config.get<string | number>('PORT') ?? 3000;
    const base =
      this.config.get<string>('API_BASE_URL') ?? `http://localhost:${port}`;
    return `${base.replace(/\/+$/, '')}/trips/${tripId}/live?token=${encodeURIComponent(token)}`;
  }

  /** Publishes on a channel, logging (never throwing) on failure. */
  private async safePublish(channel: string, payload: unknown): Promise<void> {
    try {
      await this.redis.publishJson(channel, payload);
    } catch (err) {
      this.logger.error(
        `Failed to publish SOS message on ${channel}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
