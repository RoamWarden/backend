# RoamWarden API — Module Contract

Source of truth for cross-module boundaries. Every module MUST code against the
exact names and signatures here. If a signature must change, change it here
first. Derived from `RoamWarden-Build-Plan.pdf` §9–§14 and §20 (monetization).

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
| `RedisService` | `src/providers/redis/redis.service` | global; presence GEO, online hash, `publishJson`, `createSubscriber()`, `setWithTtl(key, value, ttlS)`, `claimOnce(key)` |
| channel/key constants | `src/providers/redis/redis.constants` | `CHANNEL_ALERT_INCIDENT`, `CHANNEL_SOS`, `channelTripLive(tripId)`, `PATTERN_TRIP_LIVE`, `keyDirectionsCache(hash)`, `keyPlacesCache(hash)`, `keyHandoffToken(tokenHash)` |
| `Public()` / `IS_PUBLIC_KEY` | `src/common/decorators/public.decorator` | marks routes that skip the global JWT guard |
| `CurrentUser()` | `src/common/decorators/current-user.decorator` | injects `AuthenticatedUser` |
| `AccessTokenPayload`, `TripShareTokenPayload`, `AuthenticatedUser` | `src/common/types/auth.types` | |
| domain constants | `src/common/constants` | thresholds, radii, TTLs — never inline magic numbers |
| `haversineMeters`, `toWktPoint`, `toWktLineString`, `isValidLat/Lng` | `src/common/utils/geo.util` | |
| `parseDurationSeconds` | `src/common/utils/duration.util` | |
| `validateEnv` | `src/config/env.validation` | wired into `ConfigModule.forRoot` by integration |
| `EntitlementsService` | `src/common/entitlements` | plan limits/capabilities + the `assert*` guards; `@Global`, inject it anywhere. ENFORCEMENT IS OFF BY DEFAULT — see EntitlementsModule below |

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
| geo | `src/resources/geo/` + `src/providers/google/` | `GET /geo/places/nearby`, `GET /geo/places/search`; `PlacesService` (Google Places proxy — key stays server-side) |
| billing | `src/resources/billing/` + `src/common/entitlements/` | `GET /billing/plans`, `GET/POST /billing/subscription`, `GET /billing/entitlements`, `POST /billing/portal-link`; `BillingService`, `isPremiumEntitled`, `EntitlementsService` (plan limits + the enforcement switch) |
| integration | `src/app.module.ts` | wiring: ConfigModule(validateEnv), Throttler global guard, JwtAuthGuard as APP_GUARD, Sentry, ScheduleModule |

A module may ONLY create/edit files inside its own directory. Cross-module
needs go through the exported services below.

## Exported service signatures

### AuthModule (exports: `TokensService`, `TripShareTokenService`, `JwtAuthGuard`, `HandoffTokenService`)

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

/** App → web account hand-off (§20). Redis-backed, 5 min TTL, single-use. */
class HandoffTokenService {
  /** For an ALREADY-authenticated user. Raw token returned once, never persisted. */
  issue(userId: string): Promise<{ token: string; expiresAt: Date }>;
  /** Burns the token, then mints a session exactly like login. Throws on reuse. */
  exchange(rawToken: string): Promise<AuthSession>;
}
```

- `JwtAuthGuard` honours `@Public()`; on success sets `request.user: AuthenticatedUser`.
- Refresh tokens: 48 random bytes base64url, stored as sha256 hex in `refresh_tokens.token_hash`.
- `POST /auth/google` — `@Public()`, throttled 20/15 min. Body
  `{ idToken, allowSignup?: boolean }` → verifies against ALL configured Google
  client ids (web/ios/android; audience check), resolves the user by `googleSub`
  → then by email, and returns 201 `{ accessToken, refreshToken, user }` (the
  same `AuthSession` shape as login; `user` = `{ id, email, name, avatarUrl, reputation }`).
  If no Google client id is configured → 503 with a clear "Google Sign-In not
  configured" message.
  - Resolution order (identical in both modes): known `googleSub` → sign in and
    refresh name/email/avatar; else the email exists → **LINK** the Google
    identity onto that account (including an email + password one) and sign in;
    else create.
  - `allowSignup` **defaults to `true`**. The app sends only `{ idToken }` and is
    unchanged: an unknown identity creates a pre-verified account.
  - `allowSignup: false` is LOGIN-ONLY mode, for the website. If the verified
    identity matches NO existing user (no `googleSub` match AND no account with
    that email) nothing is written and the response is
    **404** with body **verbatim**:
    ```json
    { "code": "NO_ACCOUNT", "message": "There's no RoamWarden account for ada@example.com yet. Create one in the RoamWarden app first — that's where your email is verified and your trusted contacts are set up — then come back and sign in with Google." }
    ```
    Note the body is exactly `{ code, message }` (no `statusCode`/`error` keys) —
    same shape as login's `403 { code: 'EMAIL_NOT_VERIFIED' }`. Clients branch on
    `code`, never on the sentence, and must render `message` as-is. It is
    deliberately NOT a 401: web clients treat 401 as a dead session and would
    loop through refresh/redirect.
  - Login-only mode changes ONLY account creation. Linking still succeeds, and
    still enforces both guards: Google's `email_verified` must be true (else 401
    `googleEmailNotVerified`), and linking onto an account that never verified its
    own email revokes that unproven `passwordHash` (pre-hijacking defence). An
    email already owned by a DIFFERENT `googleSub` is still 409.
  - `allowSignup` must be a real JSON boolean. The global pipe's
    `enableImplicitConversion` would turn the string `"false"` into `true`, so the
    DTO re-reads the raw value and rejects anything non-boolean — `"false"`, `0`,
    `null` — with a 400 rather than failing open. Only an ABSENT field means
    "default to true".
- `POST /auth/handoff` — `@Public()`, throttled 20/15 min. Body `{ token }` (the
  `handoff` query param the app put in the account URL) → 200
  `{ accessToken, refreshToken, user }`, the SAME shape as login. Hand-off tokens:
  48 random bytes base64url, stored in Redis ONLY as an HMAC-SHA256 (keyed with
  `JWT_REFRESH_SECRET`) under `keyHandoffToken(hash)` with a `HANDOFF_TOKEN_TTL_S`
  (5 min) TTL; the value is the userId. Redemption is an ATOMIC Lua GET+DEL
  (`RedisService.claimOnce`), so two concurrent exchanges can never both win.
  Unknown / expired / already-used all give the SAME 401 message (no probing).
  Redis unreachable → 503, never a session (fails closed).

### UsersModule (exports: `UsersService`)

```ts
class UsersService {
  findById(id: string): Promise<User | null>;
  /**
   * sub → email → create. `options.allowSignup` defaults to true (the app);
   * false = login-only (the website): an identity that matches no existing user
   * throws NotFoundException({ code: 'NO_ACCOUNT', message }) BEFORE any write.
   * Resolving to an existing account is a sign-in in both modes, with the
   * email_verified gate and unproven-password revocation unchanged.
   */
  upsertFromGoogle(
    p: { sub: string; email: string; name: string; avatarUrl?: string; emailVerified: boolean },
    options?: { allowSignup?: boolean },
  ): Promise<User>;
  getTrustedContacts(userId: string): Promise<TrustedContact[]>;
  /** userIds of contacts that are linked app users (contactUserId != null) */
  getContactUserIds(userId: string): Promise<string[]>;
  /** Exact-email → minimal public profile. See "Contact lookup by email". */
  lookupContactUserByEmail(
    userId: string,
    email: string,
  ): Promise<ContactUserLookupResult>;
}
```

REST: `GET /me` (profile + reputation), `PATCH /me { name?, phone?, avatarUrl? }`,
`DELETE /me` (full cascade delete — GDPR), `GET/POST/PATCH/DELETE /me/contacts(/:id)`,
`POST /me/contacts/lookup`, `POST /me/devices { token, platform: 'IOS'|'ANDROID' }`,
`DELETE /me/devices/:token`.
Contact create body: `{ name, phone?, email?, contactUserId?, relation? }`.

A trusted contact is either DETAILS-ONLY (name + phone/email you keep so you can
reach them yourself — RoamWarden sends them nothing) or LINKED (`contactUserId`
set), which is what enables in-app trip + SOS alerts. `contactUserId` must come
from the lookup below; users never type or paste it.

#### Contact lookup by email — `POST /me/contacts/lookup`

Authenticated (Bearer, like the rest of `/me`). Resolves ONE exact email to the
minimal public profile of a RoamWarden account so the app can link a trusted
contact without anyone reading a uuid down the phone.

Request body — exactly one field; any other property is a 400
(`whitelist + forbidNonWhitelisted`), so this can never grow into a directory
search:

```jsonc
{ "email": "ada@example.com" }   // trimmed + lowercased server-side
```

Success — **always 200**, in two shapes discriminated by `found`:

```jsonc
// hit
{
  "found": true,
  "user": { "id": "uuid", "name": "Ada Lovelace", "avatarUrl": "https://… | null" },
  "alreadyAdded": false,          // already in the CALLER's contact list?
  "existingContactId": null,      // that TrustedContact.id when alreadyAdded
  "message": "Ada Lovelace is on RoamWarden. Linking them means they get your trip and SOS alerts in the app."
}

// miss — a normal outcome, NOT an error
{
  "found": false,
  "user": null,
  "alreadyAdded": false,
  "existingContactId": null,
  "message": "No RoamWarden account uses that email — you can still save them as a contact you'll reach yourself."
}
```

```ts
type ContactUserLookupResult =
  | {
      found: true;
      user: { id: string; name: string; avatarUrl: string | null };
      alreadyAdded: boolean;
      existingContactId: string | null;
      message: string;
    }
  | {
      found: false;
      user: null;
      alreadyAdded: false;
      existingContactId: null;
      message: string;
    };
```

`user` is **only** those three fields. Never the email back, never phone,
reputation, counts, trips or contacts. `alreadyAdded` / `existingContactId`
describe the caller's own rows, so they disclose nothing about the other
account — and in particular the response NEVER says whether that person has
added the caller back.

Failures (`message` is always human and safe to show verbatim):

| Status | Body | When |
| --- | --- | --- |
| 400 | `{ statusCode, message: string[], error: 'Bad Request' }` | Not an email / missing / >320 chars / extra property. `message` is class-validator's array — join it. |
| 400 | `{ code: 'SELF_LOOKUP', message: "That's your own account. Search for the email of the person you want to add as a trusted contact." }` | The email is the caller's. Branch on `code`, never the sentence. |
| 401 | `{ statusCode, message: 'You must be signed in to do this.' }` | Missing/expired access token. |
| 429 | `{ statusCode: 429, message }` | Rate limited — see below. |

**Rate limit — 20 lookups per hour, enforced twice.** `@Throttle` on the route
caps it per IP; `UsersService` additionally caps it per ACCOUNT in Redis,
because the global `ThrottlerGuard` is registered ahead of `JwtAuthGuard` and so
runs before `request.user` exists (rotating IPs would otherwise be a free
bypass). The per-account 429 carries a human message
(*"You've searched for a lot of people in a short time…"*); the per-IP 429 comes
from the framework and carries `"ThrottlerException: Too Many Requests"`, so on
**any** 429 from this route the app should show its own copy rather than echoing
`message` blindly. The per-account limit fails OPEN if Redis is unreachable (the
per-IP limit still applies).

Then create the contact normally:
`POST /me/contacts { name, contactUserId: <user.id from the lookup>, relation? }`.
A `contactUserId` that is not a uuid → 400; that is the caller's own id → 400
`"You can't add yourself as your own trusted contact. Search for the email of the
person you want to add."`; that matches no account (stale lookup, account deleted
mid-flow) → 404 `"That RoamWarden account no longer exists — it may have been
deleted. Search for the person by email again, or save them as a contact you'll
reach yourself."`; already linked → 409 `DUPLICATE_LINKED_CONTACT` (avoidable by
checking `alreadyAdded` first).

Linking is ONE-SIDED and grants nothing on its own: every notification fan-out
passes through `UsersService.filterConsentingContactUserIds`, so neither party
sees the other's live location until both have added each other. Confirming that
an address has an account is therefore an acceptable disclosure at this exact,
authenticated, rate-limited granularity — consent, not secrecy, is what protects
the data.

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
  - Each trip row on BOTH of these carries `watcherContactIds: string[]` — the ids of the
    trusted contacts watching it, from `trip_watchers.contact_id`, i.e. the SAME id space as
    `GET /me/contacts`, so a client resolves them to names without another round trip.
    Batched server-side (one query per page), so it is not an N+1.
  - ADDITIVE, and ABSENT ELSEWHERE: `POST /trips/:id/stop`, `/cancel` and `/share` return the
    bare trip row with no such field. **A client must read an absent value as UNKNOWN, never
    as "nobody".** An EMPTY ARRAY is a real answer (this trip has no watchers) and may be
    stated as such. The app previously manufactured `[]` for every trip and printed it as
    fact — "Nobody is following" on Home, "Private journey" in the history, a no-contacts
    warning on the trip screen — for journeys that were genuinely shared.
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
- `POST /reports/:id/remove` `{ reason? }` — ADMIN takedown (`AdminGuard`). Sets `REMOVED`
  plus the removal audit (`removedById` = the admin, `removedReason`, `removedAt`).
- `POST /reports/:id/retract` — OWNER self-retraction: "I filed this and I am taking it
  back". No body. NOT a relaxation of `/remove`, which keeps its `AdminGuard`.
  - **Authorisation**: only `reporterId === caller`. Anyone else → **403** with
    `REPORT_RETRACT_FORBIDDEN_MSG`. Unknown id → **404** with `REPORT_RETRACT_NOT_FOUND_MSG`.
    403 rather than the SOS module's 404-for-everything: a report id is on the public map,
    so there is no existence to protect.
  - **ALWAYS ALLOWED** — no edit window, no "too many confirmations, too late". A report is
    a claim about the world; once its author withdraws it nobody should be routing around it.
  - **ZERO MIGRATIONS, deliberately**: it lands in the existing `ReportStatus.REMOVED` with
    the existing removal audit columns, not a new enum value. Every read path already filters
    `status IN ('UNCONFIRMED','VERIFIED')`, so one write drops the report out of bbox, near
    AND `clusterVerifyNearby` at once. A self-retraction is told apart from a takedown by
    `removed_by_id = reporter_id`; `removed_reason` carries `REPORT_SELF_RETRACT_REASON`.
  - **Votes**: untouched. `report_votes` rows stay as the audit of what people saw, but can
    no longer matter — the report is out of every query, `vote()` refuses a non-active
    report, and the counts freeze where they stood.
  - **Verification**: a retracted report stops counting toward any neighbour's cluster
    verification immediately. Neighbours ALREADY promoted stay promoted — that promotion was
    a fact at the time, and demoting would claw back other people's reputation.
  - **Reputation**: if the report was `VERIFIED`, its `+REPUTATION_REPORT_VERIFIED` award is
    given back — once, inside the same `FOR UPDATE` lock the vote path takes — because
    otherwise "file → get cluster-verified → retract" is a free reputation farm. That is a
    REVERSAL of an award, **not** a retraction penalty: reports have no such penalty and this
    does not add one. A `REJECTED` report's `REPUTATION_REPORT_REJECTED` is NOT refunded —
    retracting must never erase a penalty already earned.
  - **Idempotent**: retracting an already-REMOVED report succeeds quietly, does not overwrite
    an admin's audit trail, and never reverses reputation twice.
  - Already-delivered alerts are NOT recalled: a push that has landed cannot be unsent, and
    inventing a "never mind" push for a community report is noise, not safety.
- `GET /reports?bbox=minLng,minLat,maxLng,maxLat&types=` — active (UNCONFIRMED|VERIFIED,
  unexpired) in viewport via `ST_MakeEnvelope`/`&&`; cap 200, newest first. Reporter
  identity is NEVER exposed in any report response (privacy §17) — return counts + type + location + note + status + timestamps only.
- `GET /reports/near?lat=&lng=&radiusM=` — same shape, `ST_DWithin`.
- `GET /reports/:id`
- **`mine: boolean` on EVERY report response** (create, vote, remove, retract, bbox, near,
  get-by-id) — ADDITIVE. Computed per request against the caller; the geo queries compare
  `reporter_id` in SQL and select only the boolean, so the identity never leaves the
  database. It exists so a client knows which report carries its own retract action, and it
  is the ONLY authorship signal — `reporterId` is still shipped to nobody.
  **The `alert:incident` socket payload has no `mine`** (it is published to the people NEAR a
  report, never to its author), so a client must read an ABSENT `mine` as UNKNOWN, i.e. not
  mine — never as authorship.
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

### GeoModule (`PlacesService` exported from `GoogleModule`)

```ts
class PlacesService {
  /** Named places within PLACES_NEARBY_RADIUS_M (250 m) of a point. */
  findNearby(lat: number, lng: number): Promise<Place[] | null>;
  /** Free-text search, optionally biased to a point (PLACES_TEXT_SEARCH_RADIUS_M, 30 km). */
  searchText(query: string, lat?: number, lng?: number): Promise<Place[] | null>;
}

interface Place {
  id: string;      // Google place_id
  name: string;
  address: string; // vicinity ?? formatted_address ?? ''
  lat: number;
  lng: number;
  types: string[];
}
```

Best-effort like `DirectionsService` — NEVER throws. `null` = lookup unavailable
(no `GOOGLE_MAPS_SERVER_API_KEY` / HTTP error / bad status, logged as a warning);
`[]` = Google genuinely found nothing (ZERO_RESULTS). Results are capped at 12
and Redis-cached 10 min (`keyPlacesCache(hash)`): nearby on coords rounded to
4 dp, text search on the lowercased/trimmed query + rounded bias. The Google key
never leaves the server — the app must call these endpoints, not Google.

REST (authed via the global JWT guard, no `@Public()`):

- `GET /geo/places/nearby?lat=&lng=` → `{ places: Place[], degraded: boolean }` —
  "what is at/near this pin" for the map location picker. `degraded: true` means
  the lookup was unavailable (`places` is then `[]`) — distinct from a real
  empty result, so the app can fall back to raw coordinates.
- `GET /geo/places/search?q=&lat=&lng=` → same shape — the picker's search box.
  `q` required, 2–120 chars (trimmed); `lat`/`lng` optional bias, only applied
  when both are present.

### BillingModule (exports: `BillingService`)

Monetization (build plan §20). Two consumer tiers only — Free and Premium; B2B
duty-of-care tiers come later. **THERE IS NO PAYMENT GATEWAY.** No endpoint here
charges anyone, contacts a processor, or grants a paid entitlement, and nothing in
this codebase may write `ACTIVE` for a paid plan. Clients render "Pay now" as
visibly inert and say payments aren't live yet.

```ts
class BillingService {
  getPlans(): Promise<{ plans: PlanView[] }>;
  /** No subscription row → the free plan with status FREE. NEVER 404s. */
  getSubscription(userId: string): Promise<SubscriptionView>;
  /** 'free' → FREE now; a priced plan → PENDING, never ACTIVE. */
  selectPlan(userId: string, planCode: string): Promise<SelectPlanResult>;
  createPortalLink(userId: string): Promise<{ url: string; expiresAt: Date }>;
  /** The caller's limits/capabilities. Delegates to EntitlementsService. */
  getEntitlements(userId: string): Promise<EntitlementsView>;
  /** The coarse question. Prefer EntitlementsService for anything specific. */
  isPremium(userId: string): Promise<boolean>;
}

/** Pure rule behind it, for tests/other modules: src/resources/billing/entitlements */
function isPremiumEntitled(
  s: { planCode: string; status: SubscriptionStatus } | null,
): boolean; // null → false; 'free' → false; paid → only when ACTIVE

interface PlanView {
  code: string;              // 'free' | 'premium' — the client-facing key; row ids are NEVER exposed
  name: string;
  description: string;
  priceAmountMinor: number;  // cents; 0 = free
  currency: string;          // ISO-4217, e.g. 'USD'
  interval: string;          // 'month'
  priceFormatted: string;    // server-formatted: 'Free' | '$5.00' — clients append '/mo'
  features: string[];        // marketing bullets, rendered verbatim in order
  sortOrder: number;
  limits: PlanLimits;              // what this PLAN includes (catalog info, not a grant)
  capabilities: PlanCapabilities;  // ditto — lets a pricing page compare tiers exactly
}

interface SubscriptionView {
  plan: PlanView;
  status: 'FREE' | 'PENDING' | 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  currentPeriodEnd: string | null; // ISO over the wire; null for FREE/PENDING
  cancelAtPeriodEnd: boolean;
  isPremium: boolean;              // false while PENDING — nobody paid
  paymentAvailable: boolean;       // ALWAYS false until a gateway exists
  entitlements: EntitlementsView;  // what the CALLER may do (same shape as GET /billing/entitlements)
}

interface SelectPlanResult extends SubscriptionView { message: string }
```

Data model: `plans` is a SEEDED CATALOG (migration `20260725090000_subscription_plans`),
so copy/pricing change with a row update instead of three deploys. `subscriptions`
holds AT MOST ONE row per user — enforced by a UNIQUE on `user_id`, not app logic.
No row at all IS the free tier; users are never backfilled.

REST:

- `GET /billing/plans` — `@Public()` (the website pricing page must render
  signed-out) → 200 `{ plans: PlanView[] }`, active plans only, ascending
  `sortOrder`. An empty catalog is a misconfiguration, not a product decision →
  503 with a clear message (never a silently empty pricing page).
- `GET /billing/subscription` — authed → 200 `SubscriptionView`. A user with no
  row resolves to the free plan with `status: 'FREE'`. Carries `entitlements`
  (see EntitlementsModule) so one call tells a client both the plan and the
  limits.
- `GET /billing/entitlements` — authed → 200 `EntitlementsView`. The same object
  as `SubscriptionView.entitlements`, on its own, for clients that only need to
  know what to SHOW. Never 404s (no row → Free).
- `POST /billing/subscription` — authed, body `{ planCode }` (the ONLY accepted
  field — `forbidNonWhitelisted` rejects extras). Trimmed + lowercased, then
  validated against the catalog; unknown code → 400 naming the codes that exist.
  → 200 `SelectPlanResult`. `'free'` → `status: 'FREE'`, effective immediately.
  A priced plan → `status: 'PENDING'`, `paymentAvailable: false`, `isPremium: false`,
  and a `message` stating plainly that payments aren't available yet and nothing
  was charged. It can NEVER return `'ACTIVE'`.
- `POST /billing/portal-link` — authed, throttled 10/15 min, no body → 201
  `{ url, expiresAt }`. `url` is `${WEB_APP_URL}/account?handoff=<single-use token>`
  (host from config, never hardcoded; trailing slash stripped, token URL-encoded).
  The app opens it in a browser — the Spotify pattern, the app sells nothing
  in-app. Treat the URL as a secret: never log it. The web page swaps the token
  via `POST /auth/handoff` for a normal session. The app must NEVER put its own
  access/refresh token in a URL.

### EntitlementsModule (`@Global`, exports: `EntitlementsService`)

`src/common/entitlements/` — plan limits and the enforcement switch. Import path
for everyone: `import { EntitlementsService } from '<rel>/common/entitlements';`
**No module import needed** — EntitlementsModule is `@Global` and BillingModule
registers it, so injecting the service is enough.

**THE ONE RULE: `ENFORCE_PLAN_LIMITS` DEFAULTS TO FALSE, AND FALSE MEANS NOTHING
IS TAKEN AWAY.** While it is off, `assert*` never throws, `WindowCheck.since` is
always `null`, and every user keeps exactly what they can do today. The checks
still compute and RETURN what they *would* have blocked (`wouldBlock`) and log it
at debug tagged `[plan-limits][shadow]`. Never gate on `enforced` yourself and
never re-derive a limit — call the helpers and use their answer.

```ts
class EntitlementsService {
  /** Resolved entitlements for a user. No subscription row → Free. Memoized ~5s. */
  getEntitlements(userId: string): Promise<Entitlements>;
  /** Same, from a row you already loaded (no query). null = no row = Free. */
  entitlementsFor(s: { planCode: string; status: SubscriptionStatus } | null): Entitlements;
  /** What a CATALOG plan includes (pricing pages). Not a grant to anyone. */
  planEntitlements(planCode: string): PlanEntitlements;

  /** Read-only. NEVER throws. `currentCount` = what they have BEFORE adding one. */
  checkLimit(userId: string, key: CountLimitKey, currentCount: number): Promise<LimitCheck>;
  /** The guard. Throws 403 ONLY while enforcement is ON; otherwise returns the check. */
  assertWithinLimit(userId: string, key: CountLimitKey, currentCount: number): Promise<LimitCheck>;

  checkCapability(userId: string, key: CapabilityKey): Promise<CapabilityCheck>;
  assertCapability(userId: string, key: CapabilityKey): Promise<CapabilityCheck>;

  /** Window limits (trip history). `since` is null unless enforcement is ON. */
  getWindow(userId: string, key: WindowLimitKey): Promise<WindowCheck>;

  isEnforced(): boolean;
  /** Call after changing a user's plan. BillingService.selectPlan already does. */
  invalidate(userId: string): void;
}

type CountLimitKey = 'trustedContacts' | 'familyMembers';
type WindowLimitKey = 'tripHistoryDays';
type CapabilityKey = 'analytics' | 'prioritySos' | 'familyPlan' | 'offlineMaps';

/** null ALWAYS means UNLIMITED — never Infinity, never -1 (JSON-safe). */
type LimitValue = number | null;
type PlanLimits = {
  trustedContacts: LimitValue;
  tripHistoryDays: LimitValue;
  familyMembers: LimitValue;
};
type PlanCapabilities = Record<CapabilityKey, boolean>;

interface Entitlements {           // === EntitlementsView on the wire
  planCode: string;                // plan on the subscription row ('free' when none)
  entitledPlanCode: string;        // plan whose limits APPLY — 'free' unless ACTIVE paid
  status: 'FREE' | 'PENDING' | 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  isPremium: boolean;              // entitledPlanCode !== 'free'
  limits: PlanLimits;
  capabilities: PlanCapabilities;
  enforced: boolean;               // false today; while false clients MUST NOT lock anything
}

interface LimitCheck {
  key: CountLimitKey;
  planCode: string;                // the entitled plan the numbers came from
  enforced: boolean;
  limit: LimitValue;               // null = unlimited
  current: number;                 // what you passed, floored at 0
  remaining: LimitValue;           // null = unlimited; never negative
  allowed: boolean;                // ALWAYS true while enforced is false
  wouldBlock: boolean;             // what enforcement WOULD have done
  message: string | null;          // human copy, set whenever wouldBlock
}

interface CapabilityCheck {
  key: CapabilityKey; planCode: string; enforced: boolean;
  granted: boolean;                // does the plan include it
  allowed: boolean;                // ALWAYS true while enforced is false
  wouldBlock: boolean; message: string | null;
}

interface WindowCheck {
  key: WindowLimitKey; planCode: string; enforced: boolean;
  windowDays: LimitValue;          // null = unlimited
  since: Date | null;              // APPLY this; null = no cutoff (unlimited OR not enforced)
  wouldApplySince: Date | null;    // what would apply if enforced — safe to show, never to hide
}
```

The limits table (`src/common/entitlements/entitlement.constants.ts`, keyed by
`plans.code` — add a plan = add a catalog row + an entry here):

| key | free | premium | meaning |
|---|---|---|---|
| `trustedContacts` | 5 | unlimited (`null`) | contacts a user may have |
| `tripHistoryDays` | 30 | unlimited (`null`) | how far back trip history/analytics may read |
| `familyMembers` | 0 | 6 | seats in a family/group plan, owner included |
| `analytics` | false | true | trip history & analytics |
| `prioritySos` | false | true | priority SOS handling |
| `familyPlan` | false | true | family/group plan |
| `offlineMaps` | false | true | offline maps |

Usage, exactly as intended:

```ts
// countable limit — pass the CURRENT count, before adding
const check = await this.entitlements.assertWithinLimit(userId, 'trustedContacts', count);
// ...proceed. With the flag off this line is always reached.

// window limit — one expression, correct in both modes
const { since } = await this.entitlements.getWindow(userId, 'tripHistoryDays');
where: { startedAt: since ? { gte: since } : undefined }
```

When enforcement IS on, `assert*` throws 403 with a human `message` plus
machine-readable fields: `{ code: 'PLAN_LIMIT_REACHED', limitKey, limit, current,
planCode, upgradeTo }` or `{ code: 'PLAN_UPGRADE_REQUIRED', capability, planCode,
upgradeTo }`. If the entitlement lookup itself fails, `check*`/`assert*` FAIL
OPEN (`allowed: true`, `enforced: false`, warning logged) — a plan check must
never break a safety feature.

### Integration (app.module.ts)

- `ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })`
- `ThrottlerModule.forRoot` from `RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX`
  (defaults 60000/100) + `ThrottlerGuard` as APP_GUARD.
- `JwtAuthGuard` as APP_GUARD (after throttler).
- `ScheduleModule.forRoot()`, `SentryModule` + `SentryGlobalFilter` (`@sentry/nestjs/setup`).
- Health: keep `GET /health` public; extend to report db/redis status.
- `ENFORCE_PLAN_LIMITS` (`'true' | 'false'`, default false) is the plan-limit
  master switch. It MUST stay false until checkout is live — true takes features
  away from users who cannot buy them back. No app.module wiring is needed:
  `EntitlementsModule` is `@Global` and BillingModule registers it.
- `SOS_ESCALATION_ENABLED` (`'true' | 'false'`, default false) is the SOS
  escalation master switch, independent of any plan. It MUST stay false until a
  client can stop a ladder (`POST /sos/:id/resolve` and `POST /sos/:id/ack`) —
  armed without them, every SOS runs to exhaustion and tells the traveller no one
  answered, which the server cannot know. Off changes nothing else: contacts are
  still alerted at once, the delivery trail is still recorded for every user, and
  retraction still stands those contacts down.
- `WEB_APP_URL` is the website origin (password-reset page + the `/account` area).
  The account area is a browser page calling this API cross-origin, so whenever
  `CORS_ORIGINS` is set that origin MUST be in it, or the account page gets a CORS
  failure instead of a session.

## Error envelope

Nest defaults (`{ statusCode, message, error }`). `message` must tell a human
what happened and what to do. 401 invalid/expired token; 403 not yours; 404
missing; 409 conflicting state (e.g. second active trip); 422 domain rejection
(geo-implausible report); 429 throttled.

Two responses carry a machine-readable `code` next to `message`, so clients
branch on the code and never on the sentence: the 404 `{ code: 'NO_ACCOUNT' }`
from login-only Google sign-in, and the 400 `{ code: 'SELF_LOOKUP' }` from
`POST /me/contacts/lookup`.

One 403 carries extra fields: a plan limit blocked by `EntitlementsService`
adds `code` (`'PLAN_LIMIT_REACHED'` | `'PLAN_UPGRADE_REQUIRED'`), `planCode`,
`upgradeTo`, and the numbers. It CANNOT occur while `ENFORCE_PLAN_LIMITS` is off
(the default), so clients may treat it as a future case — but if they handle it,
show `message` and route to the account area.
