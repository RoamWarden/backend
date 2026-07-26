import {
  BadRequestException,
  ConflictException,
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
import { RetractSosDto } from './dto/retract-sos.dto';
import {
  NOTIFY_FAILED_WARNING,
  NO_CONTACTS_WARNING,
  NO_LINKED_CONTACTS_WARNING,
  REPUTATION_SOS_RETRACTED,
  SOS_ALREADY_RESOLVED_MSG,
  SOS_NOT_FOUND_MSG,
  SOS_RETRACTED_NOTICE,
  SOS_RETRACTION_REPUTATION_FLOOR,
  SOS_RETRACT_NOBODY_REACHED,
  SOS_RETRACT_REPUTATION_UNRECORDED,
  TRIP_NOT_FOUND_MSG,
  retractionReputationNote,
} from './constant/sos.constants';
import { SosEscalationService } from './sos-escalation.service';
import type {
  RaiseSosResult,
  RetractSosResult,
  SosAckResult,
  SosPriorityInfo,
  SosRaisedMessage,
  SosRetractionReputation,
  SosTrailView,
} from './type/sos.types';
import { buildTripShareUrl } from './util/share-url';

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
 *
 * PRIORITY SOS (Premium `prioritySos`) is bolted on STRICTLY AFTER all of that,
 * in `SosEscalationService`. The path below — every consenting contact alerted
 * at once, immediately — is the standard SOS every user gets, and it is
 * unchanged: nothing about the plan check runs before the fan-out, and nothing
 * the follow-up does can shrink, delay or fail it. SOS is a Free-tier promise.
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
    private readonly escalation: SosEscalationService,
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
    // Captured for the priority follow-up, which runs only after this block.
    let notifiedContactIds: string[] = [];
    let ownerName = 'Your contact';
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
          ownerName = name;

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
          notifiedContactIds = contactUserIds;
        }
      }
    } catch (err) {
      this.logger.error(
        `SOS ${event.id} was recorded but notifying contacts failed`,
        err instanceof Error ? err.stack : String(err),
      );
      warning = NOTIFY_FAILED_WARNING;
    }

    // ── priority follow-up ──────────────────────────────────────────────
    // Everything the standard SOS does is DONE by this point: the row is
    // committed and every consenting contact has already been alerted. What
    // follows only schedules retries and escalation for plans that include
    // Priority SOS, and it is deliberately outside the try above so a failure
    // here can never be mistaken for "we could not notify your contacts".
    // It is skipped entirely when nobody was notified, so a Free user's path
    // costs not one extra query.
    let priority: SosPriorityInfo | undefined;
    if (notifiedContactIds.length > 0) {
      try {
        priority = await this.escalation.start({
          sosId: event.id,
          userId: user.id,
          ownerName,
          contactUserIds: notifiedContactIds,
          ...(dto.message !== undefined
            ? { travellerMessage: dto.message }
            : {}),
        });
      } catch (err) {
        // `start` is contractually non-throwing; this is the belt to its
        // braces. A follow-up that cannot be scheduled must never turn an
        // SOS that WAS delivered into a failed request.
        this.logger.error(
          `SOS ${event.id}: contacts were alerted but the priority follow-up could not be armed`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return {
      sosId: event.id,
      notifiedContactCount,
      ...(shareUrl !== undefined ? { shareUrl } : {}),
      ...(warning !== undefined ? { warning } : {}),
      ...(priority !== undefined ? { priority } : {}),
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
    // The traveller is safe — stop paging their contacts. Best-effort by
    // design (the ladder also re-checks `resolvedAt` on every tick), so a
    // failure here can never stop someone marking themselves safe.
    try {
      await this.escalation.stopOnResolve(event.id);
    } catch (err) {
      this.logger.error(
        `SOS ${event.id} was resolved but the escalation could not be closed — the next sweep will stop it`,
        err instanceof Error ? err.stack : String(err),
      );
    }
    this.logger.log(`SOS ${event.id} resolved by user ${user.id}`);
    return { sosId: event.id, resolvedAt };
  }

  /**
   * WITHDRAWS an SOS: a false alarm, a pocket dial, a scare that passed.
   *
   * Not the same act as `resolve`. Resolving says "I am safe now" about an SOS
   * that really happened. Retracting says "that should not have gone out", and
   * it owes two things resolving does not:
   *
   *   1. STOP THE ALARM. The escalation ladder is halted so nobody else is
   *      paged, and a trip pinned to SOS is handed back to ACTIVE — a trip stuck
   *      in SOS is an alarm still showing on every watcher's live map, and it
   *      also locks the traveller out of their own "active trip".
   *   2. TELL THE PEOPLE WE ALREADY ALARMED. This is the part that matters. A
   *      contact who got the SOS and never hears it was withdrawn keeps
   *      worrying, or keeps driving. The delivery trail knows exactly who was
   *      reached, and every one of them gets a stand-down through the same push
   *      path that raised the alert.
   *
   * OWNER ONLY (404 for anyone else, never 403 — the id must not be a probe),
   * only while the SOS is still LIVE, and IDEMPOTENT: retracting twice returns
   * the same answer without re-alerting anyone or charging reputation twice.
   *
   * The reputation dent is the least important part and is treated as such: it
   * happens last, it is bounded, and if it fails the retraction still stands.
   */
  async retract(
    user: AuthenticatedUser,
    sosId: string,
    dto: RetractSosDto,
  ): Promise<RetractSosResult> {
    const event = await this.prisma.sosEvent.findUnique({
      where: { id: sosId },
      select: {
        id: true,
        userId: true,
        tripId: true,
        resolvedAt: true,
        retractedAt: true,
      },
    });
    // 404 (not 403) when missing OR someone else's — never leak existence.
    if (!event || event.userId !== user.id) {
      throw new NotFoundException(SOS_NOT_FOUND_MSG);
    }
    // Already withdrawn — idempotent OK. No second stand-down (the contacts
    // have had one and a repeat is just noise) and no second penalty.
    if (event.retractedAt) {
      return this.alreadyRetractedResult(event.id, event.retractedAt);
    }
    if (event.resolvedAt) {
      throw new ConflictException(SOS_ALREADY_RESOLVED_MSG);
    }

    const reason = dto.reason?.trim() ? dto.reason.trim() : undefined;
    const retractedAt = new Date();

    // THE IDEMPOTENCY GUARD. Winning this conditional update — and only winning
    // it — authorises everything below, including the one reputation charge.
    // Two simultaneous taps, or a client retry, produce exactly one winner; the
    // loser falls through to the idempotent answer.
    const claimed = await this.prisma.sosEvent.updateMany({
      where: {
        id: event.id,
        userId: user.id,
        retractedAt: null,
        resolvedAt: null,
      },
      data: { retractedAt, retractReason: reason ?? null },
    });
    if (claimed.count !== 1) {
      return this.raceLostResult(event.id);
    }

    this.logger.warn(
      `SOS ${event.id} withdrawn by user ${user.id}${reason ? ` (“${reason}”)` : ''}`,
    );

    // ── 1) stop the alarm ────────────────────────────────────────────────
    let escalationStopped = false;
    try {
      escalationStopped = await this.escalation.stopOnRetract(event.id);
    } catch (err) {
      // The sweep re-checks the SOS row every tick and will stop on its own;
      // this must never block a withdrawal.
      this.logger.error(
        `SOS ${event.id} was withdrawn but the escalation could not be closed — the next sweep will stop it`,
        err instanceof Error ? err.stack : String(err),
      );
    }
    await this.restoreTripAfterRetraction(event.id, event.tripId, user.id);

    // ── 2) tell the people we already alarmed ────────────────────────────
    const ownerName = await this.ownerName(user.id);
    const notified = await this.escalation.notifyRetraction({
      sosId: event.id,
      userId: user.id,
      ownerName,
      retractedAt,
      ...(reason !== undefined ? { reason } : {}),
    });

    // ── 3) reputation, last and least ────────────────────────────────────
    const reputation = await this.applyRetractionPenalty(event.id, user.id);

    return {
      sosId: event.id,
      retractedAt: retractedAt.toISOString(),
      alreadyRetracted: false,
      escalationStopped,
      notifiedContactCount: notified.notifiedContactCount,
      reputation,
      ...(notified.warning !== undefined ? { warning: notified.warning } : {}),
      notice:
        notified.notifiedContactCount > 0
          ? SOS_RETRACTED_NOTICE
          : SOS_RETRACT_NOBODY_REACHED,
    };
  }

  /**
   * A trusted contact confirms they have seen the SOS, which stops the priority
   * ladder from paging the rest of the list. It does NOT mark the traveller
   * safe — only they can do that, with `resolve`.
   */
  async acknowledge(
    contact: AuthenticatedUser,
    sosId: string,
  ): Promise<SosAckResult> {
    let name = 'A trusted contact';
    try {
      const profile = await this.users.findById(contact.id);
      if (profile?.name) name = profile.name;
    } catch (err) {
      // A missing display name must not stop an acknowledgement.
      this.logger.warn(
        `Could not read the name of contact ${contact.id} acknowledging SOS ${sosId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return this.escalation.acknowledge(contact.id, sosId, name);
  }

  /**
   * The auditable record of what actually happened: every attempt to reach
   * every contact, in order. Owner-only — 404 for anyone else, so the trail
   * cannot be used to probe whether someone else's SOS exists.
   */
  async getTrail(
    user: AuthenticatedUser,
    sosId: string,
  ): Promise<SosTrailView> {
    const event = await this.prisma.sosEvent.findUnique({
      where: { id: sosId },
      select: {
        id: true,
        userId: true,
        createdAt: true,
        resolvedAt: true,
        retractedAt: true,
        retractReason: true,
      },
    });
    if (!event || event.userId !== user.id) {
      throw new NotFoundException(SOS_NOT_FOUND_MSG);
    }
    return this.escalation.getTrail(event);
  }

  // ── retraction internals ──────────────────────────────────────────────

  /**
   * The answer to "I already withdrew this". Deliberately NOT an error: a user
   * tapping twice, or a client retrying a request whose response was lost,
   * deserves the same calm answer as the first caller — not a red banner
   * suggesting their withdrawal did not work.
   *
   * `penalty: 0` because THIS call charged nothing. `reputationPenalty` on the
   * row is the receipt from the call that did.
   */
  private alreadyRetractedResult(
    sosId: string,
    retractedAt: Date,
  ): RetractSosResult {
    return {
      sosId,
      retractedAt: retractedAt.toISOString(),
      alreadyRetracted: true,
      escalationStopped: false,
      notifiedContactCount: 0,
      reputation: {
        penalty: 0,
        value: null,
        note: retractionReputationNote(0, null),
      },
      notice: SOS_RETRACTED_NOTICE,
    };
  }

  /**
   * Lost the guarded transition: somebody else changed this SOS between our read
   * and our write. Re-read to find out which, and answer honestly rather than
   * guessing — the two outcomes mean very different things to the traveller.
   */
  private async raceLostResult(sosId: string): Promise<RetractSosResult> {
    const fresh = await this.prisma.sosEvent.findUnique({
      where: { id: sosId },
      select: { id: true, retractedAt: true },
    });
    if (fresh?.retractedAt) {
      // A concurrent retraction won. That one did the stand-down and paid the
      // penalty; this one reports success and charges nothing.
      return this.alreadyRetractedResult(fresh.id, fresh.retractedAt);
    }
    // The only other way to lose the guard is a concurrent resolve.
    throw new ConflictException(SOS_ALREADY_RESOLVED_MSG);
  }

  /**
   * Hands a trip that this SOS pinned to SOS status back to ACTIVE.
   *
   * Part of "stop the alarm", not housekeeping: a trip left in SOS keeps showing
   * an emergency on every watcher's live view, drops out of `getActiveTripForUser`
   * (so the traveller's next SOS cannot find their own trip) and is skipped by
   * the trip monitor, which silently ends overdue/stall watching for the rest of
   * the journey.
   *
   * Guarded three ways, and best-effort throughout — a trip status must never
   * cost someone their withdrawal:
   *  - only a trip still in SOS is touched (never one since completed);
   *  - only when NO other live SOS exists on that trip, so retracting one of two
   *    alarms cannot clear the other;
   *  - a P2002 from the one-ACTIVE-trip-per-user index (they started another
   *    trip meanwhile) leaves it in SOS and is logged, not thrown.
   */
  private async restoreTripAfterRetraction(
    sosId: string,
    tripId: string | null,
    userId: string,
  ): Promise<void> {
    if (!tripId) return;
    try {
      const otherLive = await this.prisma.sosEvent.count({
        where: {
          tripId,
          id: { not: sosId },
          resolvedAt: null,
          retractedAt: null,
        },
      });
      if (otherLive > 0) {
        this.logger.log(
          `SOS ${sosId} withdrawn but trip ${tripId} stays in SOS — ${otherLive} other live SOS event(s) on it`,
        );
        return;
      }

      const restored = await this.prisma.trip.updateMany({
        where: { id: tripId, userId, status: TripStatus.SOS },
        data: { status: TripStatus.ACTIVE },
      });
      if (restored.count !== 1) return;

      await this.safePublish(channelTripLive(tripId), {
        kind: 'status',
        tripId,
        status: TripStatus.ACTIVE,
      });
      this.logger.log(
        `SOS ${sosId} withdrawn — trip ${tripId} returned to ACTIVE`,
      );
    } catch (err) {
      this.logger.error(
        `SOS ${sosId} was withdrawn but trip ${tripId} could not be returned to ACTIVE — it stays flagged SOS`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * The dent. Bounded by `SOS_RETRACTION_REPUTATION_FLOOR`, charged exactly once
   * (the caller has already won the guarded transition), and incapable of
   * failing the retraction: the alert is withdrawn and the contacts are told
   * whatever happens here.
   *
   * IT CANNOT AFFECT A FUTURE SOS. Nothing in `raise` reads reputation — not the
   * entitlement check, not the fan-out, not the ladder. Someone at the floor
   * raises an SOS identically to anyone else, and that must stay true: safety is
   * never rate-limited by a score.
   */
  private async applyRetractionPenalty(
    sosId: string,
    userId: string,
  ): Promise<SosRetractionReputation> {
    let value: number | null;
    try {
      value = await this.users.applyBoundedReputationPenalty(
        userId,
        REPUTATION_SOS_RETRACTED,
        SOS_RETRACTION_REPUTATION_FLOOR,
      );
    } catch (err) {
      this.logger.error(
        `SOS ${sosId} was withdrawn but the reputation penalty could not be applied to user ${userId}`,
        err instanceof Error ? err.stack : String(err),
      );
      // No receipt is stamped, so the row keeps telling the truth: nothing was
      // charged. Said out loud rather than swallowed.
      return {
        penalty: 0,
        value: null,
        note: SOS_RETRACT_REPUTATION_UNRECORDED,
      };
    }

    // Receipt, stamped only after the charge really landed. Guarded on NULL so
    // it records the first charge and can never be overwritten by a later one.
    try {
      await this.prisma.sosEvent.updateMany({
        where: { id: sosId, reputationPenalty: null },
        data: { reputationPenalty: REPUTATION_SOS_RETRACTED },
      });
    } catch (err) {
      this.logger.error(
        `SOS ${sosId}: reputation was adjusted by ${REPUTATION_SOS_RETRACTED} but the receipt could not be written`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    return {
      penalty: REPUTATION_SOS_RETRACTED,
      value,
      note: retractionReputationNote(REPUTATION_SOS_RETRACTED, value),
    };
  }

  /** The traveller's display name, never a reason to fail a withdrawal. */
  private async ownerName(userId: string): Promise<string> {
    try {
      const owner = await this.users.findById(userId);
      if (owner?.name) return owner.name;
    } catch (err) {
      this.logger.warn(
        `Could not read the name of user ${userId} withdrawing an SOS: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return 'Your contact';
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
    return buildTripShareUrl(this.config, tripId, token);
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
