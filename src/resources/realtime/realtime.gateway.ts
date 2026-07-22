import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Redis } from 'ioredis';
import { Server, Socket } from 'socket.io';
import { TokensService } from '../auth/tokens.service';
import { TripShareTokenService } from '../auth/trip-share-token.service';
import { AuthenticatedUser } from '../../common/types/auth.types';
import {
  CHANNEL_ALERT_INCIDENT,
  CHANNEL_SOS,
  PATTERN_TRIP_LIVE,
} from '../../providers/redis/constant/redis.constants';
import { RedisService } from '../../providers/redis/redis.service';
import { TripsService } from '../trip/trips.service';
import {
  tripRoom,
  userRoom,
  WS_TRIP_LOCATION_MAX_POINTS,
} from './constant/realtime.constants';
import {
  isAlertIncidentMessage,
  isRecord,
  isSosRaisedMessage,
} from './realtime.messages';
import {
  validateTripLocationPayload,
  validateTripSubscribePayload,
  validateTripUnsubscribePayload,
} from './ws-validation';

/** Ack shape returned to every client→server event. */
type WsAck = { ok: true } | { ok: false; error: string };

/** What we stash on socket.data after a successful handshake. */
interface SocketData {
  user?: AuthenticatedUser;
  /** True only when markSocketConnected succeeded — guards the decrement. */
  presenceTracked?: boolean;
}

const AUTH_FAILED_MSG =
  'Your session is invalid or expired — reconnect with a fresh token.';
const TRIP_ACCESS_DENIED_MSG = 'You do not have access to this trip.';

/**
 * Socket.IO gateway: authenticates sockets with the access JWT, tracks online
 * presence, relays the low-latency trip location stream, and bridges Redis
 * pub/sub fan-out (incident alerts, SOS, per-trip live channels) into rooms.
 *
 * CORS: decorator options are evaluated before DI exists, so the decorator
 * ships the permissive fallback (origin: true). The env-driven allowlist
 * (CORS_ORIGINS, comma-separated) is applied in onModuleInit via
 * ConfigService — see applyCorsOrigins().
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class RealtimeGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  private subscriber: Redis | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly tokens: TokensService,
    private readonly tripShareTokens: TripShareTokenService,
    private readonly trips: TripsService,
  ) {}

  // ── lifecycle: Redis pub/sub bridge ───────────────────────────────────

  async onModuleInit(): Promise<void> {
    this.applyCorsOrigins();

    const sub = this.redis.createSubscriber();
    this.subscriber = sub;
    // Listeners attach before subscribing so no message slips through.
    sub.on('message', (channel: string, raw: string) => {
      this.handleChannelMessage(channel, raw);
    });
    sub.on('pmessage', (_pattern: string, channel: string, raw: string) => {
      this.handleTripLiveMessage(channel, raw);
    });
    await sub.subscribe(CHANNEL_ALERT_INCIDENT, CHANNEL_SOS);
    await sub.psubscribe(PATTERN_TRIP_LIVE);
    this.logger.log(
      `Realtime bridge subscribed to ${CHANNEL_ALERT_INCIDENT}, ${CHANNEL_SOS} and ${PATTERN_TRIP_LIVE}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    const sub = this.subscriber;
    this.subscriber = null;
    if (!sub) return;
    try {
      await sub.quit();
    } catch {
      // Connection already gone (RedisService also quits owned subscribers on
      // shutdown) — force-close is safe and idempotent.
      sub.disconnect();
    }
  }

  // ── connection auth + presence ────────────────────────────────────────

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token = this.extractToken(socket);
      if (!token) {
        this.rejectConnection(socket);
        return;
      }
      let user: AuthenticatedUser;
      try {
        const payload = this.tokens.verifyAccessToken(token);
        user = { id: payload.sub, email: payload.email };
      } catch {
        this.rejectConnection(socket);
        return;
      }

      (socket.data as SocketData).user = user;
      await socket.join(userRoom(user.id));
      try {
        await this.redis.markSocketConnected(user.id);
        (socket.data as SocketData).presenceTracked = true;
      } catch (err) {
        // Presence tracking is best-effort — the socket stays usable.
        this.logger.error(
          `Failed to mark user ${user.id} online in Redis — online status may be stale`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    } catch (err) {
      this.logger.error(
        `Unexpected error during socket handshake (socket ${socket.id})`,
        err instanceof Error ? err.stack : String(err),
      );
      this.rejectConnection(socket);
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const data = socket.data as SocketData;
    if (!data.user || !data.presenceTracked) return;
    try {
      await this.redis.markSocketDisconnected(data.user.id);
    } catch (err) {
      this.logger.error(
        `Failed to mark user ${data.user.id} offline in Redis — online status may be stale`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  // ── client → server events ────────────────────────────────────────────

  /**
   * Low-latency location stream from the trip owner. Intentionally NOT
   * persisted to trip_points — REST `POST /trips/:id/points` is the durable
   * persistence path. Here we only refresh Redis presence and fan the newest
   * point out to the trip's live watchers.
   */
  @SubscribeMessage('trip:location')
  async onTripLocation(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: unknown,
  ): Promise<WsAck> {
    const user = this.userOf(socket);
    if (!user) {
      return {
        ok: false,
        error:
          'You are not authenticated — reconnect with a valid access token before streaming locations.',
      };
    }

    const parsed = validateTripLocationPayload(
      payload,
      WS_TRIP_LOCATION_MAX_POINTS,
    );
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const { tripId, points } = parsed.value;

    let ownerId: string | null;
    try {
      ownerId = await this.trips.getTripOwnerId(tripId);
    } catch (err) {
      this.logger.error(
        `Failed to look up owner of trip ${tripId}`,
        err instanceof Error ? err.stack : String(err),
      );
      return {
        ok: false,
        error: 'Could not verify this trip right now — try again in a moment.',
      };
    }
    if (ownerId === null || ownerId !== user.id) {
      return {
        ok: false,
        error:
          'This trip does not exist or is not yours — only the trip owner can stream its location.',
      };
    }

    const last = points[points.length - 1];
    try {
      await this.redis.updatePresence(user.id, last.lat, last.lng);
    } catch (err) {
      // Presence is best-effort — the watcher broadcast below still goes out.
      this.logger.error(
        `Failed to update presence for user ${user.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    this.server.to(tripRoom(tripId)).emit('trip:watch', {
      tripId,
      point: {
        lat: last.lat,
        lng: last.lng,
        speed: last.speed,
        heading: last.heading,
        recordedAt: last.recordedAt ?? new Date().toISOString(),
      },
    });

    return { ok: true };
  }

  @SubscribeMessage('trip:subscribe')
  async onTripSubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: unknown,
  ): Promise<WsAck> {
    const parsed = validateTripSubscribePayload(payload);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const { tripId, shareToken } = parsed.value;
    const user = this.userOf(socket);

    let granted = false;
    try {
      if (user) {
        const ownerId = await this.trips.getTripOwnerId(tripId);
        if (ownerId === user.id) {
          granted = true;
        } else if (ownerId !== null) {
          const watcherIds = await this.trips.getWatcherUserIds(tripId);
          granted = watcherIds.includes(user.id);
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to check access to trip ${tripId} for user ${user?.id ?? 'anonymous'}`,
        err instanceof Error ? err.stack : String(err),
      );
      return {
        ok: false,
        error:
          'Could not verify trip access right now — try again in a moment.',
      };
    }

    // A valid share token for THIS trip grants access even to sockets that
    // authenticated normally (e.g. an app user opening a shared live link).
    // Version-checked so a reissued (revoked) link cannot rejoin the room.
    if (!granted && shareToken) {
      try {
        granted = await this.trips.isValidShareToken(tripId, shareToken);
      } catch {
        // Invalid or expired share token — fall through to the denial below.
      }
    }

    if (!granted) {
      return { ok: false, error: TRIP_ACCESS_DENIED_MSG };
    }
    await socket.join(tripRoom(tripId));
    return { ok: true };
  }

  @SubscribeMessage('trip:unsubscribe')
  async onTripUnsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: unknown,
  ): Promise<WsAck> {
    const parsed = validateTripUnsubscribePayload(payload);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    await socket.leave(tripRoom(parsed.value.tripId));
    return { ok: true };
  }

  // ── Redis bridge: fan-out to rooms ────────────────────────────────────

  private handleChannelMessage(channel: string, raw: string): void {
    const msg = this.parseJson(channel, raw);
    if (msg === undefined) return;
    if (channel === CHANNEL_ALERT_INCIDENT) {
      this.relayAlertIncident(msg);
    } else if (channel === CHANNEL_SOS) {
      this.relaySosRaised(msg);
    } else {
      this.logger.warn(`Ignoring message on unexpected channel "${channel}"`);
    }
  }

  private relayAlertIncident(msg: unknown): void {
    if (!isAlertIncidentMessage(msg)) {
      this.logger.error(
        `Skipping malformed ${CHANNEL_ALERT_INCIDENT} payload — expected { report, userIds[] }`,
      );
      return;
    }
    for (const userId of msg.userIds) {
      this.server.to(userRoom(userId)).emit('alert:incident', {
        ...msg.report,
        tripId: msg.tripIdByUserId?.[userId],
      });
    }
  }

  private relaySosRaised(msg: unknown): void {
    if (!isSosRaisedMessage(msg)) {
      this.logger.error(
        `Skipping malformed ${CHANNEL_SOS} payload — expected { sosId, user, contactUserIds[] }`,
      );
      return;
    }
    // Recipients get the event without the recipient list itself.
    const { contactUserIds, ...event } = msg;
    for (const contactUserId of contactUserIds) {
      this.server.to(userRoom(contactUserId)).emit('sos:raised', event);
    }
  }

  private handleTripLiveMessage(channel: string, raw: string): void {
    const msg = this.parseJson(channel, raw);
    if (msg === undefined) return;
    if (!isRecord(msg)) {
      this.logger.error(
        `Skipping malformed trip live payload on ${channel} — expected an object`,
      );
      return;
    }

    // 'trip:live:*' → the channel suffix is the tripId fallback.
    const channelTripId = channel.slice(PATTERN_TRIP_LIVE.length - 1);
    const tripId =
      typeof msg.tripId === 'string' && msg.tripId.length > 0
        ? msg.tripId
        : channelTripId;
    if (!tripId) {
      this.logger.error(
        `Skipping trip live message without a tripId on ${channel}`,
      );
      return;
    }

    if (msg.kind === 'position') {
      if (!isRecord(msg.point)) {
        this.logger.error(
          `Skipping position message without a point on ${channel}`,
        );
        return;
      }
      this.server
        .to(tripRoom(tripId))
        .emit('trip:watch', { tripId, point: msg.point });
      return;
    }

    if (msg.kind === 'status') {
      const rest: Record<string, unknown> = { ...msg };
      delete rest.kind;
      const event = { ...rest, tripId };
      this.server.to(tripRoom(tripId)).emit('trip:status', event);
      // When the publisher includes the owner, mirror the status to their
      // per-user room (covers the owner's other devices).
      if (typeof msg.ownerId === 'string' && msg.ownerId.length > 0) {
        this.server.to(userRoom(msg.ownerId)).emit('trip:status', event);
      }
      return;
    }

    this.logger.warn(
      `Ignoring trip live message with unknown kind "${String(msg.kind)}" on ${channel}`,
    );
  }

  /** JSON.parse that logs and returns undefined on garbage instead of throwing. */
  private parseJson(channel: string, raw: string): unknown {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      this.logger.error(
        `Skipping malformed JSON on ${channel}: ${raw.slice(0, 200)}`,
      );
      return undefined;
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private userOf(socket: Socket): AuthenticatedUser | undefined {
    return (socket.data as SocketData).user;
  }

  private extractToken(socket: Socket): string | null {
    const authToken = (
      socket.handshake.auth as Record<string, unknown> | undefined
    )?.token;
    if (typeof authToken === 'string' && authToken.length > 0) return authToken;
    const header = socket.handshake.headers.authorization;
    if (typeof header !== 'string') return null;
    return /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? null;
  }

  private rejectConnection(socket: Socket): void {
    socket.emit('error', { message: AUTH_FAILED_MSG });
    socket.disconnect(true);
  }

  /**
   * Applies the CORS_ORIGINS env allowlist. engine.io's CORS middleware holds
   * a reference to the SAME options object the decorator passed in, and the
   * `cors` package re-reads it on every request — so we mutate it in place.
   * No CORS_ORIGINS configured → keep the decorator fallback (origin: true).
   */
  private applyCorsOrigins(): void {
    const raw = this.config.get<string>('CORS_ORIGINS');
    const origins = (raw ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
    if (origins.length === 0) {
      this.logger.log(
        'CORS_ORIGINS not set — WebSocket connections allowed from any origin.',
      );
      return;
    }
    const engine = (
      this.server as unknown as {
        engine?: { opts?: { cors?: { origin?: unknown } } };
      }
    )?.engine;
    const cors = engine?.opts?.cors;
    if (!cors) {
      this.logger.warn(
        'Could not reach the Socket.IO engine CORS options — WebSocket connections remain allowed from any origin. Check the adapter wiring.',
      );
      return;
    }
    cors.origin = origins;
    this.logger.log(
      `WebSocket CORS origins restricted to: ${origins.join(', ')}`,
    );
  }
}
