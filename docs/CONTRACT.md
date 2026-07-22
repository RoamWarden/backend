# RoamWarden API — Module Contract

Source of truth for cross-module boundaries. Every module MUST code against the
exact names and signatures here. If a signature must change, change it here
first. Derived from `RoamWarden-Build-Plan.pdf` §9–§14.

## Ground rules

- NestJS 11 + Fastify adapter. TypeScript compiles with `npm run typecheck` /
  `npm run build` (TS7 tsc). `module: nodenext` — CommonJS output; no ESM-only
  imports.
- Prisma 6 (`@prisma/client`) is the ORM. PostGIS columns are `Unsupported`
  and NULLABLE: create rows with the normal client (lat/lng floats), then set
  geography in the same transaction via `$executeRaw`. All geo queries via
  `$queryRaw` with parameterized WKT from `common/utils/geo.util`.
- Every thrown `HttpException` carries a clear, human-readable `message` — no
  bare status codes, no silent failures. Log unexpected errors with context.
- DTOs: `class-validator` classes, validated by the global `ValidationPipe`
  (whitelist + forbidNonWhitelisted are ON — declare every accepted field).
- Env access via `ConfigService`; never `process.env` outside config/bootstrap
  (exceptions: `main.ts`, `instrument.ts`).
- Coordinates are always `{ lat, lng }` numbers in API payloads. WKT/PostGIS
  order is `(lng lat)` — use the helpers, never hand-build WKT.

## Foundation (already built — import, do not modify)

| Symbol | Where | Notes |
|---|---|---|
| `PrismaService` | `src/prisma/prisma.service` | global module |
| `RedisService` | `src/providers/redis/redis.service` | global; presence GEO, online hash, `publishJson`, `createSubscriber()` |
| channel/key constants | `src/providers/redis/redis.constants` | `CHANNEL_ALERT_INCIDENT`, `CHANNEL_SOS`, `channelTripLive(tripId)`, `PATTERN_TRIP_LIVE`, `keyDirectionsCache(hash)` |
| `Public()` / `IS_PUBLIC_KEY` | `src/common/decorators/public.decorator` | marks routes that skip the global JWT guard |
| `CurrentUser()` | `src/common/decorators/current-user.decorator` | injects `AuthenticatedUser` |
| `AccessTokenPayload`, `TripShareTokenPayload`, `AuthenticatedUser` | `src/common/types/auth.types` | |
| domain constants | `src/common/constants` | thresholds, radii, TTLs — never inline magic numbers |
| `haversineMeters`, `toWktPoint`, `toWktLineString`, `isValidLat/Lng` | `src/common/utils/geo.util` | |
| `parseDurationSeconds` | `src/common/utils/duration.util` | |
| `validateEnv` | `src/config/env.validation` | wired into `ConfigModule.forRoot` by integration |

## Module ownership map

| Module | Directory | Builds |
|---|---|---|
| auth | `src/resources/auth/` | `POST /auth/google`, `POST /auth/refresh`, `POST /auth/logout`; `GoogleAuthService`, `TokensService`, `TripShareTokenService`, `JwtAuthGuard` |
| users | `src/resources/user/` | `GET/PATCH/DELETE /me`, trusted contacts CRUD under `/me/contacts`, device tokens under `/me/devices`; `UsersService` |
| trips | `src/resources/trip/` + `src/providers/google/` | trips CRUD/lifecycle, breadcrumbs, live view, share tokens; `DirectionsService` (+polyline decoder) |
| reports | `src/resources/report/` | create/vote/query reports, expiry cron, reputation |
| alerts | `src/resources/alert/` | corridor matching engine + fan-out + audit + FCM to offline |
| notifications | `src/resources/notification/` | Firebase Admin FCM wrapper, token pruning |
| realtime | `src/resources/realtime/` | Socket.IO gateway, Redis subscriber bridge |
| sos | `src/resources/sos/` | `POST /sos`, `POST /sos/:id/resolve` |
| integration | `src/app.module.ts` | wiring: ConfigModule(validateEnv), Throttler global guard, JwtAuthGuard as APP_GUARD, Sentry, ScheduleModule |

A module may ONLY create/edit files inside its own directory. Cross-module
needs go through the exported services below.

## Exported service signatures

### AuthModule (exports: `TokensService`, `TripShareTokenService`, `JwtAuthGuard`)

```ts
class TokensService {
  signAccessToken(user: { id: string; email: string }): string;
  verifyAccessToken(token: string): AccessTokenPayload; // throws UnauthorizedException with clear message
  issueRefreshToken(userId: string): Promise<{ token: string; expiresAt: Date }>;
  // rotation with reuse detection: reusing a revoked token revokes ALL the user's tokens
  rotateRefreshToken(rawToken: string): Promise<{
    accessToken: string; refreshToken: string; user: { id: string; email: string };
  }>;
  revokeRefreshToken(rawToken: string): Promise<void>;
}

class TripShareTokenService {
  issue(tripId: string): { token: string; expiresAt: Date };
  verify(token: string): TripShareTokenPayload; // throws UnauthorizedException
}
```

- `JwtAuthGuard` honours `@Public()`; on success sets `request.user: AuthenticatedUser`.
- Refresh tokens: 48 random bytes base64url, stored as sha256 hex in `refresh_tokens.token_hash`.
- `POST /auth/google` body `{ idToken }` → verifies against ALL configured Google client ids
  (web/ios/android; audience check), upserts user by `googleSub`, returns
  `{ accessToken, refreshToken, user }`. If no Google client id is configured →
  503 with a clear "Google Sign-In not configured" message.

### UsersModule (exports: `UsersService`)

```ts
class UsersService {
  findById(id: string): Promise<User | null>;
  upsertFromGoogle(p: { sub: string; email: string; name: string; avatarUrl?: string }): Promise<User>;
  getTrustedContacts(userId: string): Promise<TrustedContact[]>;
  /** userIds of contacts that are linked app users (contactUserId != null) */
  getContactUserIds(userId: string): Promise<string[]>;
}
```

REST: `GET /me` (profile + reputation), `PATCH /me { name?, phone?, avatarUrl? }`,
`DELETE /me` (full cascade delete — GDPR), `GET/POST/PATCH/DELETE /me/contacts(/:id)`,
`POST /me/devices { token, platform: 'IOS'|'ANDROID' }`, `DELETE /me/devices/:token`.
Contact create body: `{ name, phone?, email?, contactUserId?, relation? }`.

### TripsModule (exports: `TripsService`)

```ts
class TripsService {
  getActiveTripForUser(userId: string): Promise<Trip | null>;
  /** userIds of watcher contacts that are linked app users, for gateway auth + sos */
  getWatcherUserIds(tripId: string): Promise<string[]>;
  getTripOwnerId(tripId: string): Promise<string | null>;
}
```

REST (owner-auth unless stated):

- `POST /trips` `{ mode, origin: {lat,lng,label?}, destination: {lat,lng,label?}, watcherContactIds?: string[], expectedDurationS? }`
  → creates ACTIVE trip (+geography via raw SQL), corridor into `trip_routes`
  (Google Directions with Redis cache; straight line fallback; `source` records which),
  creates `trip_watchers`, issues share token, notifies linked watcher users
  (FCM + `channelTripLive` status message). Response includes `shareToken`, `shareUrl`
  (`${API_BASE_URL}/trips/:id/live?token=…`). One ACTIVE trip per user — starting a
  new one 409s with a clear message.
- `POST /trips/:id/points` `{ points: [{lat,lng,speed?,heading?,accuracy?,recordedAt}] }`
  (max `TRIP_POINTS_MAX_BATCH`) → bulk insert (+geog), `RedisService.updatePresence`
  with last point, publish position on `channelTripLive(tripId)`; auto-complete when
  last point within `AUTO_ARRIVAL_RADIUS_M` of destination → response `{ accepted, autoCompleted }`.
- `POST /trips/:id/stop` `{ lat?, lng? }` → COMPLETED, `duration_s`, safe-arrival
  notification to watchers (FCM + live channel status).
- `POST /trips/:id/cancel`
- `GET /trips?status=&page=&limit=` → own history; `GET /trips/:id` → detail incl. route + last 100 points.
- `GET /trips/:id/live?token=` — `@Public()`; accepts EITHER a valid share token for
  this trip OR a Bearer JWT of the owner/linked watcher. Returns trip meta, last
  ~50 points, active reports within 1km of the corridor. Never leaks other trips.
- `POST /trips/:id/share` → fresh share token (owner only).

Live-channel message shapes (published on `channelTripLive(tripId)`):

```ts
{ kind: 'position', tripId, point: { lat, lng, speed?, heading?, recordedAt } }
{ kind: 'status', tripId, status: 'ACTIVE'|'COMPLETED'|'CANCELLED'|'SOS', endedAt?, durationS? }
```

### ReportsModule (exports: `ReportsService`)

- `POST /reports` `{ type, lat, lng, note? }` — throttled hard. Geo-plausibility:
  if presence known and farther than `REPORT_GEO_PLAUSIBILITY_M` → 422 with clear
  message. `expiresAt = now + REPORT_TTL_S[type]`. After insert (+geog raw SQL),
  call `AlertsService.handleNewReport(report)`.
- `POST /reports/:id/vote` `{ vote: 1 | -1 }` — upsert per (report,user); own report
  forbidden; recompute counts; VERIFIED at `REPORT_VERIFY_THRESHOLD` confirms
  (reputation `+REPUTATION_REPORT_VERIFIED` once), REJECTED when denies ≥
  `REPORT_REJECT_THRESHOLD` and > confirms (reputation `REPUTATION_REPORT_REJECTED` once).
- `GET /reports?bbox=minLng,minLat,maxLng,maxLat&types=` — active (UNCONFIRMED|VERIFIED,
  unexpired) in viewport via `ST_MakeEnvelope`/`&&`; cap 200, newest first. Reporter
  identity is NEVER exposed in any report response (privacy §17) — return counts + type + location + note + status + timestamps only.
- `GET /reports/near?lat=&lng=&radiusM=` — same shape, `ST_DWithin`.
- `GET /reports/:id`
- Cron (`@nestjs/schedule`, every 5 min): expire past-due reports.

### AlertsModule (exports: `AlertsService`)

```ts
class AlertsService {
  /** PostGIS corridor match + Redis GEO presence → audit rows → fan-out. Returns affected users. */
  handleNewReport(report: Report): Promise<{ alertedUserIds: string[] }>;
}
```

Matching: ACTIVE trips whose `trip_routes.path` is within
`REPORT_ALERT_CORRIDOR_RADIUS_M` of the report point (`ST_DWithin` on geography),
UNION users with presence within `REPORT_ALERT_PRESENCE_RADIUS_M`
(`RedisService.searchNearbyUserIds`). Exclude the reporter. Write `alerts` rows
(channel WEBSOCKET for online / PUSH for offline via `partitionOnline`), publish
`AlertIncidentMessage` on `CHANNEL_ALERT_INCIDENT`, send FCM to offline users via
`NotificationsService`.

```ts
interface AlertIncidentMessage {
  report: { id, type, lat, lng, note, status, confirmCount, denyCount, createdAt, expiresAt }; // NO reporter id
  userIds: string[];           // all affected (gateway emits to those it hosts)
  tripIdByUserId?: Record<string, string>;
}
```

### NotificationsModule (exports: `NotificationsService`)

```ts
class NotificationsService {
  /** Looks up device tokens itself; chunks ≤500; prunes dead tokens; never throws (logs). */
  sendToUsers(userIds: string[], msg: { title: string; body: string; data?: Record<string, string> }): Promise<void>;
}
```

Firebase Admin initialised from env; if unconfigured, log ONE clear warning at
boot and no-op (never crash, never silently skip without that warning).

### RealtimeModule (Socket.IO gateway)

- Handshake: `auth: { token }` (or `Authorization` header) verified with
  `TokensService.verifyAccessToken`; failure → disconnect with error event
  carrying a clear message. On connect: join room `user:<id>`,
  `markSocketConnected`; on disconnect: `markSocketDisconnected`.
- Client → server events:
  - `trip:location` `{ tripId, points: [{lat,lng,speed?,heading?,recordedAt?}] }` —
    owner only; updates presence, persists via `TripsService` path or direct prisma?
    → USE `TripsService` public ingest method if present, else persist minimal:
    presence + broadcast (REST is the durable path). Broadcast `trip:watch` to `trip:<tripId>`.
  - `trip:subscribe` `{ tripId, shareToken? }` — allowed for owner, linked watcher
    (`TripsService.getWatcherUserIds`), or valid share token → join `trip:<tripId>`.
  - `trip:unsubscribe` `{ tripId }`
- Server → client events: `alert:incident` (payload: `AlertIncidentMessage.report` + `tripId?`),
  `trip:watch` `{ tripId, point }`, `trip:status` `{ tripId, status, … }`,
  `sos:raised` (payload from `SosRaisedMessage`).
- Redis bridge: one `createSubscriber()`; SUBSCRIBE `CHANNEL_ALERT_INCIDENT`,
  `CHANNEL_SOS`; PSUBSCRIBE `PATTERN_TRIP_LIVE`. Relay to rooms accordingly.

### SosModule

- `POST /sos` `{ tripId?, lat?, lng?, message? }` → create `sos_events` row; if the
  user has an ACTIVE trip: mark it status SOS + publish status on its live channel.
  Notify ALL trusted contacts: linked users get `sos:raised` (via `CHANNEL_SOS`)
  + FCM; response `{ sosId, notifiedContactCount, shareUrl? }` (share URL when a
  trip exists, via `TripShareTokenService`).
- `POST /sos/:id/resolve` (owner) → set `resolvedAt`.

```ts
interface SosRaisedMessage {
  sosId: string;
  user: { id: string; name: string };
  tripId?: string; lat?: number; lng?: number; message?: string;
  contactUserIds: string[];
  raisedAt: string; // ISO
}
```

### Integration (app.module.ts)

- `ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })`
- `ThrottlerModule.forRoot` from `RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX`
  (defaults 60000/100) + `ThrottlerGuard` as APP_GUARD.
- `JwtAuthGuard` as APP_GUARD (after throttler).
- `ScheduleModule.forRoot()`, `SentryModule` + `SentryGlobalFilter` (`@sentry/nestjs/setup`).
- Health: keep `GET /health` public; extend to report db/redis status.

## Error envelope

Nest defaults (`{ statusCode, message, error }`). `message` must tell a human
what happened and what to do. 401 invalid/expired token; 403 not yours; 404
missing; 409 conflicting state (e.g. second active trip); 422 domain rejection
(geo-implausible report); 429 throttled.
