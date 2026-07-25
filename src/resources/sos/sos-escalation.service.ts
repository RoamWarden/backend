import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  SosDeliveryChannel,
  SosDeliveryStatus,
  SosEscalationStatus,
} from '@prisma/client';
import type { SosEscalation } from '@prisma/client';
import { EntitlementsService } from '../../common/entitlements';
import { PrismaService } from '../../prisma/prisma.service';
import { CHANNEL_SOS } from '../../providers/redis/constant/redis.constants';
import { RedisService } from '../../providers/redis/redis.service';
import { TripShareTokenService } from '../auth/trip-share-token.service';
import { NotificationsService } from '../notification/notifications.service';
import { UsersService } from '../user/users.service';
import {
  ESCALATION_EXHAUSTED_BODY,
  ESCALATION_EXHAUSTED_TITLE,
  PRIORITY_SOS_CAPABILITY,
  SOS_ACK_NOT_FOUND_MSG,
  SOS_BROADCAST_ROUND,
  SOS_ESCALATION_ADVANCE_DELAY_MS,
  SOS_ESCALATION_FIRST_DELAY_MS,
  SOS_ESCALATION_LEASE_MS,
  SOS_ESCALATION_MAX_ATTEMPTS,
  SOS_ESCALATION_MAX_ATTEMPTS_PER_CONTACT,
  SOS_ESCALATION_MAX_DURATION_MS,
  SOS_ESCALATION_RETRY_BACKOFF_MS,
  SOS_ESCALATION_ROUND_DELAY_MS,
  SOS_ESCALATION_SWEEP_LIMIT,
  SOS_NOT_EMERGENCY_SERVICE_NOTICE,
  ackPushBody,
  escalationPushBody,
  escalationPushTitle,
} from './constant/sos.constants';
import type {
  SosAckResult,
  SosPriorityInfo,
  SosRaisedMessage,
  SosTrailView,
  StartEscalationInput,
} from './type/sos.types';
import { buildTripShareUrl } from './util/share-url';

/** The SOS fields the ladder needs to re-page a contact. */
interface EscalatingSos {
  id: string;
  userId: string;
  message: string | null;
  lat: number | null;
  lng: number | null;
  createdAt: Date;
  resolvedAt: Date | null;
  user: { name: string };
  trip: { id: string; shareTokenVersion: number } | null;
}

/** The outcome of one attempt, before it is written to the trail. */
interface AttemptOutcome {
  status: SosDeliveryStatus;
  channel: SosDeliveryChannel;
  detail: string | null;
  /** Did we actually hand the alert to a device? Drives retry vs. escalate. */
  delivered: boolean;
}

/**
 * PRIORITY SOS — the Premium capability `prioritySos` (build plan §20).
 *
 * ───────────────────────── WHAT THIS IS, AND IS NOT ─────────────────────────
 * RoamWarden is NOT an emergency service and this file does not change that.
 * There is no integration with any police, ambulance or rescue service, and
 * none is implied anywhere: every message this service sends says plainly that
 * RoamWarden can only reach the traveller's OWN trusted contacts and that
 * someone must call local emergency services themselves.
 *
 * What Priority SOS adds is RELIABILITY, and nothing else:
 *   1. failed deliveries are RETRIED with a backoff instead of one best-effort
 *      shot that nobody ever hears about;
 *   2. an unanswered alert ESCALATES down the trusted-contact list, one contact
 *      at a time, instead of a single fan-out into silence;
 *   3. every attempt is written to an append-only TRAIL, so "did anyone
 *      actually get my SOS?" has a real answer afterwards.
 *
 * ───────────────────── IT NEVER DEGRADES THE STANDARD SOS ─────────────────────
 * SOS is on the FREE tier's list of promises, and it stays whole. The standard
 * broadcast — every consenting contact alerted at once, immediately — has
 * ALREADY happened by the time anything here runs; `start()` is invoked after
 * SosService has finished its fan-out, and a failure here can only cost the
 * follow-up, never the alert. Nothing in this file can delay, shrink or block
 * the alert a Free user gets today.
 *
 * ─────────────────────────── WHO GETS IT, AND WHEN ───────────────────────────
 * `EntitlementsService.checkCapability('prioritySos')` decides — never a
 * hardcoded plan test. It returns `allowed: true` for EVERYONE while
 * ENFORCE_PLAN_LIMITS is off, which is today's shipping state, so today every
 * user gets the ladder. Flipping that one flag when billing exists is what
 * narrows it to entitled subscribers; no code here changes.
 *
 * Durability: the ladder's state lives in `sos_escalations`, drained by a cron
 * sweep, NOT in an in-process timer — an escalation must survive a redeploy.
 * The sweep claims each row with a conditional UPDATE, so two API instances can
 * never page the same contact twice.
 */
@Injectable()
export class SosEscalationService {
  private readonly logger = new Logger(SosEscalationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly tripShareTokens: TripShareTokenService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ── raise-time entry point ────────────────────────────────────────────

  /**
   * Records the broadcast trail and opens the escalation ladder, if this user's
   * plan includes Priority SOS.
   *
   * NEVER THROWS and never rejects: it runs after the contacts have already
   * been alerted, so nothing it does may turn a delivered SOS into an error.
   * The returned info is descriptive only — `enabled: false` means "no
   * follow-up ladder", never "fewer people were told".
   */
  async start(input: StartEscalationInput): Promise<SosPriorityInfo> {
    // checkCapability never throws and fails OPEN, so a billing hiccup cannot
    // cost a traveller their follow-up.
    const check = await this.entitlements.checkCapability(
      input.userId,
      PRIORITY_SOS_CAPABILITY,
    );
    const info: SosPriorityInfo = {
      enabled: false,
      planCode: check.planCode,
      enforced: check.enforced,
      contactsInLadder: 0,
      reason: null,
    };

    // `allowed` — not `granted`. While enforcement is off this is true for
    // everyone; when it is turned on it narrows to entitled subscribers, with
    // no change here.
    if (!check.allowed) {
      info.reason =
        check.message ??
        'Priority SOS is part of Premium. Your contacts were still alerted.';
      return info;
    }

    if (input.contactUserIds.length === 0) {
      info.reason =
        'There were no linked trusted contacts to follow up with. Add contacts so SOS can keep trying to reach someone.';
      return info;
    }

    // The ladder is written FIRST and on its own: it is the functional half,
    // and it must not be lost to a failure in the audit half below.
    try {
      await this.prisma.sosEscalation.create({
        data: {
          sosId: input.sosId,
          userId: input.userId,
          planCode: check.planCode,
          enforced: check.enforced,
          contactOrder: input.contactUserIds,
          nextAttemptAt: new Date(Date.now() + SOS_ESCALATION_FIRST_DELAY_MS),
        },
      });
      info.enabled = true;
      info.contactsInLadder = input.contactUserIds.length;
      this.logger.log(
        `SOS ${input.sosId}: priority follow-up armed over ${input.contactUserIds.length} contact(s) (plan "${check.planCode}", enforcement ${check.enforced ? 'on' : 'off'})`,
      );
    } catch (err) {
      // Loud, but harmless: the contacts have already been alerted.
      this.logger.error(
        `SOS ${input.sosId} was raised and contacts were alerted, but the priority follow-up could not be scheduled`,
        err instanceof Error ? err.stack : String(err),
      );
      info.reason =
        'Your contacts were alerted, but we could not schedule the follow-up reminders. If you are in danger, contact local emergency services now.';
    }

    await this.recordBroadcast(input.sosId, input.contactUserIds);
    return info;
  }

  /** Halts the ladder because the traveller marked themselves safe. */
  async stopOnResolve(sosId: string): Promise<void> {
    await this.finish(
      { sosId },
      SosEscalationStatus.RESOLVED,
      'The traveller marked themselves safe.',
    );
  }

  // ── acknowledgement ───────────────────────────────────────────────────

  /**
   * A trusted contact confirms they have seen the SOS. This is the humane stop
   * condition: once a real person is on it, paging the rest of the list only
   * adds noise. It does NOT resolve the SOS — only the traveller can say they
   * are safe.
   */
  async acknowledge(
    contactUserId: string,
    sosId: string,
    contactName: string,
  ): Promise<SosAckResult> {
    const sos = await this.prisma.sosEvent.findUnique({
      where: { id: sosId },
      select: { id: true, userId: true },
    });
    // 404 (not 403) when missing OR not the caller's business — never leak
    // whether someone else's SOS exists.
    if (!sos || sos.userId === contactUserId) {
      throw new NotFoundException(SOS_ACK_NOT_FOUND_MSG);
    }

    // Same mutual-consent gate the fan-out uses: only someone the traveller
    // trusts, and who trusts them back, may act on their SOS. This one FAILS
    // CLOSED — an authorization check that cannot run must not be waved through
    // — but it says so in words a person can act on.
    let consenting: string[];
    try {
      consenting = await this.users.filterConsentingContactUserIds(sos.userId, [
        contactUserId,
      ]);
    } catch (err) {
      this.logger.error(
        `Could not verify that ${contactUserId} may acknowledge SOS ${sosId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException(
        'We could not check your access to this SOS just now. Please try again — and if someone is in danger, call local emergency services.',
      );
    }
    if (consenting.length === 0) {
      throw new NotFoundException(SOS_ACK_NOT_FOUND_MSG);
    }

    const escalation = await this.prisma.sosEscalation.findUnique({
      where: { sosId },
    });
    const rank = Math.max(
      0,
      escalation?.contactOrder.indexOf(contactUserId) ?? 0,
    );
    const acknowledgedAt = new Date();

    await this.recordAttempt({
      sosId,
      contactUserId,
      rank,
      round: escalation?.totalAttempts ?? SOS_BROADCAST_ROUND,
      attempt: 1,
      channel: SosDeliveryChannel.REALTIME,
      status: SosDeliveryStatus.ACKNOWLEDGED,
      priority: escalation !== null,
      detail: `${contactName} confirmed they have seen this SOS.`,
    });

    // updateMany, not update: acknowledging twice, or after the ladder already
    // finished, is a no-op rather than an error.
    const stopped = await this.prisma.sosEscalation.updateMany({
      where: { sosId, status: SosEscalationStatus.RUNNING },
      data: {
        status: SosEscalationStatus.ACKNOWLEDGED,
        acknowledgedBy: contactUserId,
        detail: `${contactName} acknowledged the SOS.`,
        nextAttemptAt: null,
        finishedAt: acknowledgedAt,
      },
    });

    // Best-effort: telling the traveller someone is coming must not fail the ack.
    await this.notifySafely(
      [sos.userId],
      'A contact has seen your SOS',
      ackPushBody(contactName),
      { sosId },
    );

    this.logger.log(
      `SOS ${sosId} acknowledged by contact ${contactUserId}${stopped.count === 1 ? ' — escalation stopped' : ''}`,
    );

    return {
      sosId,
      acknowledgedAt: acknowledgedAt.toISOString(),
      escalationStopped: stopped.count === 1,
      notice: SOS_NOT_EMERGENCY_SERVICE_NOTICE,
    };
  }

  // ── the trail ─────────────────────────────────────────────────────────

  /** Every recorded attempt for one SOS, oldest first. */
  async getTrail(sos: {
    id: string;
    createdAt: Date;
    resolvedAt: Date | null;
  }): Promise<SosTrailView> {
    const [escalation, attempts] = await Promise.all([
      this.prisma.sosEscalation.findUnique({ where: { sosId: sos.id } }),
      this.prisma.sosDelivery.findMany({
        where: { sosId: sos.id },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      sosId: sos.id,
      raisedAt: sos.createdAt.toISOString(),
      resolvedAt: sos.resolvedAt ? sos.resolvedAt.toISOString() : null,
      escalation: escalation
        ? {
            status: escalation.status,
            planCode: escalation.planCode,
            enforced: escalation.enforced,
            contactsInLadder: escalation.contactOrder.length,
            rank: escalation.rank,
            totalAttempts: escalation.totalAttempts,
            nextAttemptAt: escalation.nextAttemptAt
              ? escalation.nextAttemptAt.toISOString()
              : null,
            acknowledgedBy: escalation.acknowledgedBy,
            finishedAt: escalation.finishedAt
              ? escalation.finishedAt.toISOString()
              : null,
            detail: escalation.detail,
          }
        : null,
      attempts: attempts.map((row) => ({
        contactUserId: row.contactUserId,
        rank: row.rank,
        round: row.round,
        attempt: row.attempt,
        channel: row.channel,
        status: row.status,
        priority: row.priority,
        detail: row.detail,
        at: row.createdAt.toISOString(),
      })),
      notice: SOS_NOT_EMERGENCY_SERVICE_NOTICE,
    };
  }

  // ── the sweep ─────────────────────────────────────────────────────────

  /**
   * Drains due escalations. Every 30s because a minute of extra silence is a
   * long time when someone has hit SOS, and the query is a single indexed read.
   * Never throws: one bad escalation must not abort the sweep.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(): Promise<void> {
    let due: SosEscalation[];
    try {
      due = await this.prisma.sosEscalation.findMany({
        where: {
          status: SosEscalationStatus.RUNNING,
          nextAttemptAt: { lte: new Date() },
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: SOS_ESCALATION_SWEEP_LIMIT,
      });
    } catch (err) {
      this.logger.error(
        'SOS escalation sweep could not load due escalations — will retry next run',
        err instanceof Error ? err.stack : String(err),
      );
      return;
    }

    for (const row of due) {
      try {
        await this.tick(row);
      } catch (err) {
        this.logger.error(
          `SOS escalation ${row.id} (sos ${row.sosId}) failed to process — will retry next run`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  /** One step of one ladder. Exposed for tests; the sweep is its only caller. */
  async tick(row: SosEscalation): Promise<void> {
    const now = new Date();

    // Claim: push `nextAttemptAt` out by a lease in the SAME conditional update
    // that checks it is still due. A second instance sweeping this second sees
    // 0 rows updated and leaves it alone, so no contact is ever paged twice.
    const claimed = await this.prisma.sosEscalation.updateMany({
      where: {
        id: row.id,
        status: SosEscalationStatus.RUNNING,
        nextAttemptAt: { lte: now },
      },
      data: {
        nextAttemptAt: new Date(now.getTime() + SOS_ESCALATION_LEASE_MS),
      },
    });
    if (claimed.count !== 1) return;

    const sos = await this.prisma.sosEvent.findUnique({
      where: { id: row.sosId },
      select: {
        id: true,
        userId: true,
        message: true,
        lat: true,
        lng: true,
        createdAt: true,
        resolvedAt: true,
        user: { select: { name: true } },
        trip: { select: { id: true, shareTokenVersion: true } },
      },
    });

    if (!sos) {
      await this.finish(
        { id: row.id },
        SosEscalationStatus.STOPPED,
        'The SOS record no longer exists.',
      );
      return;
    }

    // The traveller is safe — stop paging immediately. This is checked first,
    // every tick, because it is the outcome everyone wants.
    if (sos.resolvedAt) {
      await this.finish(
        { id: row.id },
        SosEscalationStatus.RESOLVED,
        'The traveller marked themselves safe.',
      );
      return;
    }

    const exhaustedReason = this.exhaustionReason(row, now);
    if (exhaustedReason) {
      await this.finish(
        { id: row.id },
        SosEscalationStatus.EXHAUSTED,
        exhaustedReason,
      );
      await this.notifySafely(
        [sos.userId],
        ESCALATION_EXHAUSTED_TITLE,
        ESCALATION_EXHAUSTED_BODY,
        { sosId: sos.id },
      );
      return;
    }

    const contactUserId = row.contactOrder[row.rank];
    const attempt = row.attempt + 1;
    const round = row.totalAttempts + 1;

    // Consent can be withdrawn between rounds. Re-check every time: a contact
    // who removed this traveller must not keep receiving their live location.
    const consenting = await this.users.filterConsentingContactUserIds(
      sos.userId,
      [contactUserId],
    );
    if (consenting.length === 0) {
      await this.recordAttempt({
        sosId: sos.id,
        contactUserId,
        rank: row.rank,
        round,
        attempt,
        channel: SosDeliveryChannel.PUSH,
        status: SosDeliveryStatus.SKIPPED,
        priority: true,
        detail:
          'Skipped — they are no longer a mutual trusted contact, so we may not share this.',
      });
      await this.advance(row, round, SOS_ESCALATION_ADVANCE_DELAY_MS);
      return;
    }

    const outcome = await this.deliver(sos, contactUserId, row.rank, round);
    await this.recordAttempt({
      sosId: sos.id,
      contactUserId,
      rank: row.rank,
      round,
      attempt,
      channel: outcome.channel,
      status: outcome.status,
      priority: true,
      detail: outcome.detail,
    });

    if (outcome.delivered) {
      // Paged. Give them room to respond, then step to the next contact.
      await this.advance(row, round, SOS_ESCALATION_ROUND_DELAY_MS);
      return;
    }

    if (attempt >= SOS_ESCALATION_MAX_ATTEMPTS_PER_CONTACT) {
      // Retried enough at this contact — move on fast rather than burn the
      // clock on someone we demonstrably cannot reach.
      this.logger.warn(
        `SOS ${sos.id}: could not reach contact ${contactUserId} after ${attempt} attempt(s) — escalating to the next contact`,
      );
      await this.advance(row, round, SOS_ESCALATION_ADVANCE_DELAY_MS);
      return;
    }

    // Retry the SAME contact after a backoff.
    const backoff =
      SOS_ESCALATION_RETRY_BACKOFF_MS[
        Math.min(attempt - 1, SOS_ESCALATION_RETRY_BACKOFF_MS.length - 1)
      ];
    await this.prisma.sosEscalation.update({
      where: { id: row.id },
      data: {
        attempt,
        totalAttempts: round,
        nextAttemptAt: new Date(now.getTime() + backoff),
      },
    });
  }

  // ── internals ─────────────────────────────────────────────────────────

  /** Why (if at all) this ladder must stop. null = keep going. */
  private exhaustionReason(row: SosEscalation, now: Date): string | null {
    if (row.rank >= row.contactOrder.length) {
      return 'Every trusted contact has been alerted. Please call local emergency services if you still need help.';
    }
    if (row.totalAttempts >= SOS_ESCALATION_MAX_ATTEMPTS) {
      return `Stopped after ${SOS_ESCALATION_MAX_ATTEMPTS} attempts without a response.`;
    }
    if (
      now.getTime() - row.startedAt.getTime() >=
      SOS_ESCALATION_MAX_DURATION_MS
    ) {
      return `Stopped after ${Math.round(SOS_ESCALATION_MAX_DURATION_MS / 60000)} minutes without a response.`;
    }
    return null;
  }

  /** Steps the ladder to the next contact and schedules the next tick. */
  private async advance(
    row: SosEscalation,
    round: number,
    delayMs: number,
  ): Promise<void> {
    await this.prisma.sosEscalation.update({
      where: { id: row.id },
      data: {
        rank: row.rank + 1,
        attempt: 0,
        totalAttempts: round,
        nextAttemptAt: new Date(Date.now() + delayMs),
      },
    });
  }

  /**
   * One attempt at one contact.
   *
   * "Delivered" is deliberately conservative. FCM acceptance is not proof a
   * handset buzzed, but two things ARE knowable server-side and both mean the
   * alert went nowhere: the contact has no registered device, or every token
   * they had was dead (NotificationsService prunes those as it sends, so a
   * contact who had tokens before and none after was not reachable). Both are
   * treated as a failed delivery and retried.
   */
  private async deliver(
    sos: EscalatingSos,
    contactUserId: string,
    rank: number,
    round: number,
  ): Promise<AttemptOutcome> {
    const shareUrl = this.shareUrlFor(sos);
    const name = sos.user.name || 'Your contact';

    // Re-publish so a contact with the app open sees it surface again.
    const message: SosRaisedMessage = {
      sosId: sos.id,
      user: { id: sos.userId, name },
      ...(sos.trip ? { tripId: sos.trip.id } : {}),
      ...(sos.lat !== null && sos.lng !== null
        ? { lat: sos.lat, lng: sos.lng }
        : {}),
      ...(sos.message ? { message: sos.message } : {}),
      contactUserIds: [contactUserId],
      raisedAt: sos.createdAt.toISOString(),
      escalationRound: round,
    };
    await this.safePublish(CHANNEL_SOS, message);

    try {
      const before = await this.prisma.deviceToken.count({
        where: { userId: contactUserId },
      });
      if (before === 0) {
        return {
          status: SosDeliveryStatus.NO_DEVICE,
          channel: SosDeliveryChannel.PUSH,
          detail:
            'They have no device registered with RoamWarden, so there was nothing to send a push to.',
          delivered: false,
        };
      }

      // NotificationsService never throws by contract; the catch is belt-and-braces.
      await this.notifications.sendToUsers([contactUserId], {
        title: escalationPushTitle(name),
        body: escalationPushBody(name, rank, sos.message ?? undefined),
        data: {
          sosId: sos.id,
          escalationRound: String(round),
          ...(sos.trip ? { tripId: sos.trip.id } : {}),
          ...(shareUrl ? { shareUrl } : {}),
        },
      });

      const after = await this.prisma.deviceToken.count({
        where: { userId: contactUserId },
      });
      if (after === 0) {
        return {
          status: SosDeliveryStatus.FAILED,
          channel: SosDeliveryChannel.PUSH,
          detail:
            'Their device registration had expired, so the alert could not be delivered.',
          delivered: false,
        };
      }

      return {
        status: SosDeliveryStatus.SENT,
        channel: SosDeliveryChannel.PUSH,
        detail: null,
        delivered: true,
      };
    } catch (err) {
      this.logger.error(
        `SOS ${sos.id}: escalation attempt to contact ${contactUserId} failed`,
        err instanceof Error ? err.stack : String(err),
      );
      return {
        status: SosDeliveryStatus.FAILED,
        channel: SosDeliveryChannel.PUSH,
        detail: 'The alert could not be sent — we will try again.',
        delivered: false,
      };
    }
  }

  /**
   * Trail rows for the immediate broadcast (round 0) — the fan-out that has
   * already happened by the time this runs. Written so the trail tells the
   * whole story, not just the priority half of it.
   *
   * NEVER THROWS: this is the audit half, and it runs while the traveller is
   * waiting on their SOS response. Its two reads go out together for the same
   * reason — a record of what happened must not cost the person it happened to.
   */
  private async recordBroadcast(
    sosId: string,
    contactUserIds: string[],
  ): Promise<void> {
    let withDevices = new Set<string>();
    let online = new Set<string>();
    try {
      const [devices, presence] = await Promise.all([
        this.prisma.deviceToken.findMany({
          where: { userId: { in: contactUserIds } },
          select: { userId: true },
          distinct: ['userId'],
        }),
        // Presence is a nice-to-have on the trail, never a reason to lose it.
        this.redis.partitionOnline(contactUserIds).catch((err: unknown) => {
          this.logger.warn(
            `SOS ${sosId}: could not read contact presence for the delivery trail: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return { online: [] as string[], offline: contactUserIds };
        }),
      ]);
      withDevices = new Set(devices.map((row) => row.userId));
      online = new Set(presence.online);
    } catch (err) {
      this.logger.error(
        `SOS ${sosId}: could not work out who the broadcast reached — the trail will be incomplete`,
        err instanceof Error ? err.stack : String(err),
      );
      return;
    }

    const rows = contactUserIds.flatMap((contactUserId, rank) => {
      const hasDevice = withDevices.has(contactUserId);
      const push = {
        sosId,
        contactUserId,
        rank,
        round: SOS_BROADCAST_ROUND,
        attempt: 1,
        channel: SosDeliveryChannel.PUSH,
        status: hasDevice
          ? SosDeliveryStatus.SENT
          : SosDeliveryStatus.NO_DEVICE,
        priority: false,
        detail: hasDevice
          ? null
          : 'They have no device registered with RoamWarden, so there was nothing to send a push to.',
      };
      if (!online.has(contactUserId)) return [push];
      return [
        push,
        {
          sosId,
          contactUserId,
          rank,
          round: SOS_BROADCAST_ROUND,
          attempt: 1,
          channel: SosDeliveryChannel.REALTIME,
          status: SosDeliveryStatus.SENT,
          priority: false,
          detail: 'They had the app open — the alert was pushed live.',
        },
      ];
    });

    try {
      await this.prisma.sosDelivery.createMany({ data: rows });
    } catch (err) {
      this.logger.error(
        `SOS ${sosId}: could not record the broadcast on the delivery trail`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** Appends one attempt to the trail. Never throws — audit must not page. */
  private async recordAttempt(row: {
    sosId: string;
    contactUserId: string;
    rank: number;
    round: number;
    attempt: number;
    channel: SosDeliveryChannel;
    status: SosDeliveryStatus;
    priority: boolean;
    detail: string | null;
  }): Promise<void> {
    try {
      await this.prisma.sosDelivery.create({ data: row });
    } catch (err) {
      this.logger.error(
        `SOS ${row.sosId}: could not record a ${row.status} delivery to contact ${row.contactUserId} in the trail`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Closes a ladder. `updateMany` with a RUNNING guard so a concurrent finish
   * (resolve racing the sweep) is a no-op instead of an error.
   */
  private async finish(
    where: { id: string } | { sosId: string },
    status: SosEscalationStatus,
    detail: string,
  ): Promise<void> {
    try {
      await this.prisma.sosEscalation.updateMany({
        where: { ...where, status: SosEscalationStatus.RUNNING },
        data: {
          status,
          detail,
          nextAttemptAt: null,
          finishedAt: new Date(),
        },
      });
    } catch (err) {
      this.logger.error(
        `Could not close SOS escalation ${JSON.stringify(where)} as ${status}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** A fresh live-view link, or undefined when there is no trip to share. */
  private shareUrlFor(sos: EscalatingSos): string | undefined {
    if (!sos.trip) return undefined;
    try {
      const share = this.tripShareTokens.issue(
        sos.trip.id,
        sos.trip.shareTokenVersion,
      );
      return buildTripShareUrl(this.config, sos.trip.id, share.token);
    } catch (err) {
      this.logger.error(
        `SOS ${sos.id}: could not mint a live-view link for the escalation — sending without it`,
        err instanceof Error ? err.stack : String(err),
      );
      return undefined;
    }
  }

  /** Push that can never break its caller. */
  private async notifySafely(
    userIds: string[],
    title: string,
    body: string,
    data: Record<string, string>,
  ): Promise<void> {
    try {
      await this.notifications.sendToUsers(userIds, { title, body, data });
    } catch (err) {
      this.logger.error(
        `Failed to send the SOS notification "${title}"`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** Publishes on a channel, logging (never throwing) on failure. */
  private async safePublish(channel: string, payload: unknown): Promise<void> {
    try {
      await this.redis.publishJson(channel, payload);
    } catch (err) {
      this.logger.error(
        `Failed to publish an SOS escalation message on ${channel}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
