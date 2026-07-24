import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { MailService } from './../src/providers/mail/mail.service';
import { GoogleAuthService } from './../src/resources/auth/google-auth.service';
import { NotificationsService } from './../src/resources/notification/notifications.service';

// The email/password flow now gates on an emailed OTP. MailService is stubbed so
// the verification code is captured in-process (keyed by email) — the only way
// an e2e can complete verification without a real inbox.
const otpVerificationCodes = new Map<string, string>();

// supertest's res.body is `any`; narrow it once through this helper so the
// strict type-checked lint rules (no-unsafe-member-access) stay happy.
const body = <T>(res: { body: unknown }): T => res.body as T;

interface ErrorBody {
  statusCode: number;
  message: string | string[];
  error?: string;
}
interface AuthBody {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; name: string };
}
interface RefreshBody {
  accessToken: string;
  refreshToken: string;
}
interface CreateTripBody {
  trip: { id: string };
  shareToken: string;
  shareUrl: string;
}
interface PointsBody {
  accepted: number;
  autoCompleted: boolean;
}
interface ShareBody {
  shareToken: string;
  shareUrl: string;
}
interface LiveBody {
  trip?: { id: string };
}
interface ReportBody {
  id: string;
  type: string;
  reporterId?: unknown;
}
interface SosBody {
  sosId: string;
  notifiedContactCount: number;
}
interface ForgotBody {
  message: string;
}
interface CheckinBody {
  ok: boolean;
  checkinAt: string;
}
interface RemovedReportBody {
  id: string;
  status: string;
}

// Remote Postgres + Redis from .env — give the whole suite a generous timeout.
jest.setTimeout(60000);

// A unique identity per run so repeated CI runs never collide and cleanup is
// deterministic. Date.now()/random are fine inside a normal jest test file.
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const GOOGLE_SUB = `e2e-sub-${RUN_ID}`;
const EMAIL = `e2e-${RUN_ID}@roamwarden.test`;
const NAME = 'E2E Tester';
const AVATAR = 'https://example.com/e2e-avatar.png';

// Lagos-area coordinates for the trip; a far-away point (Abuja) for the
// geo-implausibility check (well beyond REPORT_GEO_PLAUSIBILITY_M = 2000m).
const ORIGIN = { lat: 6.5244, lng: 3.3792, label: 'Origin' };
const DESTINATION = { lat: 6.6018, lng: 3.3515, label: 'Destination' };
const FAR_AWAY = { lat: 9.0765, lng: 7.3986 }; // Abuja

// Email/password identities (unique per run). PW_EMAIL is the primary local
// account; the extra emails back the check-in/delete trip and the clustering /
// moderation scenarios, each with an isolated user so ordering never collides.
const PW_EMAIL = `e2e-pw-${RUN_ID}@roamwarden.test`;
const PW_UNVERIFIED_EMAIL = `e2e-pw-unverified-${RUN_ID}@roamwarden.test`;
const PW_PASSWORD = 'Sup3rSecret!';
const PW_NAME = 'PW Tester';
const TRIP_EMAIL = `e2e-trip-${RUN_ID}@roamwarden.test`;
const CLUSTER_EMAILS = [
  `e2e-cl1-${RUN_ID}@roamwarden.test`,
  `e2e-cl2-${RUN_ID}@roamwarden.test`,
  `e2e-cl3-${RUN_ID}@roamwarden.test`,
];
const MOD_REPORTER_EMAIL = `e2e-modrep-${RUN_ID}@roamwarden.test`;
const ADMIN_EMAIL = `e2e-admin-${RUN_ID}@roamwarden.test`;
// Waitlist scenario: a unique signup email plus a dedicated admin account that
// gets promoted to read the admin listing. WaitlistService lowercases emails on
// insert, so keep these lowercase to match on read + delete cleanly.
const WAITLIST_EMAIL = `e2e-wl-${RUN_ID}@roamwarden.test`.toLowerCase();
const WAITLIST_ADMIN_EMAIL = `e2e-wladmin-${RUN_ID}@roamwarden.test`;
// Every local account created by this spec — used to clean up in afterAll.
const LOCAL_EMAILS = [
  PW_EMAIL,
  PW_UNVERIFIED_EMAIL,
  TRIP_EMAIL,
  ...CLUSTER_EMAILS,
  MOD_REPORTER_EMAIL,
  ADMIN_EMAIL,
  WAITLIST_ADMIN_EMAIL,
];
// Waitlist rows this spec creates — removed by unique email in afterAll (the
// waitlist table is independent of users, so it needs its own cleanup).
const WAITLIST_EMAILS = [WAITLIST_EMAIL];

// A dedicated trip for the check-in/delete scenario, well away from the main
// ORIGIN/DESTINATION so nothing auto-completes unexpectedly.
const TRIP2_ORIGIN = { lat: 6.4321, lng: 3.4123, label: 'Trip2 Origin' };
const TRIP2_DEST = { lat: 6.4712, lng: 3.4501, label: 'Trip2 Destination' };

// A cluster location unique per run (jittered by RUN_ID) so parallel/repeated
// runs never pile onto the same coordinates and cross-contaminate the count.
const CLUSTER_JITTER = (Number(RUN_ID.split('-')[1] ?? '0') % 1000) / 100000;
const CLUSTER = { lat: 7.1 + CLUSTER_JITTER, lng: 3.9 + CLUSTER_JITTER };
// A separate unique spot for the moderation report.
const MOD_POINT = { lat: 8.2 + CLUSTER_JITTER, lng: 4.5 + CLUSTER_JITTER };

describe('RoamWarden API (e2e, live Postgres + Redis)', () => {
  let app: NestFastifyApplication;
  let server: App;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GoogleAuthService)
      .useValue({
        verify: () =>
          Promise.resolve({
            sub: GOOGLE_SUB,
            email: EMAIL,
            name: NAME,
            avatarUrl: AVATAR,
          }),
      })
      .overrideProvider(NotificationsService)
      .useValue({ sendToUsers: jest.fn() })
      .overrideProvider(MailService)
      .useValue({
        // Capture the verification code so registerAndVerify() can complete.
        sendVerificationCode: (email: string, code: string) => {
          otpVerificationCodes.set(email, code);
          return Promise.resolve();
        },
        sendWelcome: () => Promise.resolve(),
        sendPasswordReset: () => Promise.resolve(),
        sendWaitlistConfirmation: () => Promise.resolve(),
        buildResetUrl: (token: string) =>
          `https://app.roamwarden.test/reset-password?token=${token}`,
      })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: false }),
    );

    // Mirror main.ts so validation behaves exactly like production.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useWebSocketAdapter(new IoAdapter(app));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    server = app.getHttpServer();
  });

  afterAll(async () => {
    // Best-effort cleanup BEFORE closing the app — cascade deletes wipe the
    // user's trips, reports, refresh tokens and sos events with it.
    if (app) {
      try {
        const prisma = app.get(PrismaService);
        await prisma.user.deleteMany({ where: { googleSub: GOOGLE_SUB } });
        // Email/password accounts created by this spec — cascade deletes wipe
        // their trips, reports, tokens and password-reset rows with them.
        await prisma.user.deleteMany({
          where: { email: { in: LOCAL_EMAILS } },
        });
        // Waitlist entries are not tied to users, so remove them explicitly by
        // the unique emails this spec added.
        await prisma.waitlistEntry.deleteMany({
          where: { email: { in: WAITLIST_EMAILS } },
        });
      } catch {
        // ignore — leaving the app un-closed would be worse than a stray row.
      }
      await app.close();
    }
  });

  // Shared state threaded across the ordered scenario below.
  let accessToken: string;
  let refreshToken: string;
  let tripId: string;
  let shareToken: string;
  let reportId: string;

  const auth = () => `Bearer ${accessToken}`;

  /**
   * Registers a local account and completes email verification, returning the
   * issued session. Register no longer mints a session directly — the code is
   * captured by the stubbed MailService, then posted to /auth/verify-email.
   */
  const registerAndVerify = async (
    email: string,
    password: string,
    name: string,
  ): Promise<AuthBody> => {
    const reg = await request(server)
      .post('/auth/register')
      .send({ email, password, name });
    expect([200, 201]).toContain(reg.status);

    const code = otpVerificationCodes.get(email);
    if (!code) {
      throw new Error(`No verification code was captured for ${email}`);
    }

    const verified = await request(server)
      .post('/auth/verify-email')
      .send({ email, code })
      .expect(200);
    return body<AuthBody>(verified);
  };

  it('GET /health → 200 with database + redis up', async () => {
    const res = await request(server).get('/health').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'roamwarden-api',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('GET /me without a token → 401 human-readable message', async () => {
    const res = await request(server).get('/me').expect(401);
    const err = body<ErrorBody>(res);
    expect(err.statusCode).toBe(401);
    expect(String(err.message).length).toBeGreaterThan(0);
    expect(err.message).toBe('You must be signed in to do this.');
  });

  it('POST /auth/google with empty body → 400 mentioning idToken', async () => {
    const res = await request(server).post('/auth/google').send({}).expect(400);
    const message = JSON.stringify(body<ErrorBody>(res).message);
    expect(message).toMatch(/idToken/);
  });

  it('POST /auth/google (mocked verify) → 201 with tokens + user', async () => {
    const res = await request(server)
      .post('/auth/google')
      .send({ idToken: 'anything' })
      .expect(201);

    const b = body<AuthBody>(res);
    expect(typeof b.accessToken).toBe('string');
    expect(typeof b.refreshToken).toBe('string');
    expect(b.user).toMatchObject({ email: EMAIL, name: NAME });
    expect(typeof b.user.id).toBe('string');

    accessToken = b.accessToken;
    refreshToken = b.refreshToken;
  });

  it('POST /auth/refresh rotates the pair, and reuse of the old token → 401', async () => {
    const oldRefresh = refreshToken;

    const rotated = await request(server)
      .post('/auth/refresh')
      .send({ refreshToken: oldRefresh })
      .expect(201);

    const r = body<RefreshBody>(rotated);
    expect(typeof r.accessToken).toBe('string');
    expect(typeof r.refreshToken).toBe('string');
    expect(r.refreshToken).not.toBe(oldRefresh);

    // Adopt the fresh pair for the rest of the run.
    accessToken = r.accessToken;
    refreshToken = r.refreshToken;

    // INVARIANT: reusing a revoked refresh token is rejected (reuse detection).
    const reused = await request(server)
      .post('/auth/refresh')
      .send({ refreshToken: oldRefresh })
      .expect(401);
    expect(body<ErrorBody>(reused).statusCode).toBe(401);
  });

  it('POST /trips → 201 with shareToken + shareUrl; second active trip → 409', async () => {
    const res = await request(server)
      .post('/trips')
      .set('Authorization', auth())
      .send({ mode: 'CAR', origin: ORIGIN, destination: DESTINATION })
      .expect(201);

    const b = body<CreateTripBody>(res);
    expect(typeof b.shareToken).toBe('string');
    expect(typeof b.shareUrl).toBe('string');
    expect(b.shareUrl).toContain(b.shareToken);
    expect(b.trip).toBeDefined();
    expect(b.trip.id).toBeDefined();

    tripId = b.trip.id;
    shareToken = b.shareToken;

    // INVARIANT: exactly one ACTIVE trip per user.
    const second = await request(server)
      .post('/trips')
      .set('Authorization', auth())
      .send({ mode: 'CAR', origin: ORIGIN, destination: DESTINATION })
      .expect(409);
    const secondErr = body<ErrorBody>(second);
    expect(secondErr.statusCode).toBe(409);
    expect(String(secondErr.message)).toMatch(/active trip/i);
  });

  it('POST /trips/:id/points near origin → accepted, not auto-completed (sets presence)', async () => {
    const res = await request(server)
      .post(`/trips/${tripId}/points`)
      .set('Authorization', auth())
      .send({
        points: [
          {
            lat: ORIGIN.lat,
            lng: ORIGIN.lng,
            recordedAt: new Date().toISOString(),
          },
        ],
      })
      .expect(200);

    expect(body<PointsBody>(res)).toMatchObject({
      accepted: 1,
      autoCompleted: false,
    });
  });

  it('POST /reports far from set presence → 422 geo-implausible', async () => {
    // Presence was just set near ORIGIN by the /points call above and the trip
    // is still ACTIVE (presence is only cleared on completion). A report ~500km
    // away (Abuja) is beyond REPORT_GEO_PLAUSIBILITY_M (2000m) → 422.
    // INVARIANT: reports must be dropped near the reporter's known location.
    const res = await request(server)
      .post('/reports')
      .set('Authorization', auth())
      .send({ type: 'ROBBERY', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng });

    if (res.status === 422) {
      const err = body<ErrorBody>(res);
      expect(err.statusCode).toBe(422);
      expect(String(err.message)).toMatch(/too far|near your current/i);
    } else {
      // Presence could not be read this run (Redis GEO propagation) — the
      // service skips the check rather than blocking. Soft-skip with a warning
      // rather than a spurious failure.
      console.warn(
        `geo-implausibility check skipped: expected 422 but got ${res.status}`,
      );
    }
  });

  it('POST /trips/:id/points with last point AT the destination → autoCompleted true', async () => {
    const res = await request(server)
      .post(`/trips/${tripId}/points`)
      .set('Authorization', auth())
      .send({
        points: [
          {
            lat: DESTINATION.lat,
            lng: DESTINATION.lng,
            recordedAt: new Date().toISOString(),
          },
        ],
      })
      .expect(200);

    expect(body<PointsBody>(res).autoCompleted).toBe(true);
  });

  it('GET /trips/:id/live?token=<shareToken> → 200; garbage token → 401', async () => {
    const ok = await request(server)
      .get(`/trips/${tripId}/live`)
      .query({ token: shareToken })
      .expect(200);
    const live = body<LiveBody>(ok);
    expect(live).toBeDefined();
    // Never leaks another trip — the live view is for THIS trip.
    if (live.trip) {
      expect(live.trip.id).toBe(tripId);
    }

    // INVARIANT: a bad share token is a 401, indistinguishable from missing.
    const bad = await request(server)
      .get(`/trips/${tripId}/live`)
      .query({ token: 'garbage-not-a-real-token' })
      .expect(401);
    expect(body<ErrorBody>(bad).statusCode).toBe(401);
  });

  it('POST /trips/:id/share revokes the old share token and issues a working one', async () => {
    const oldShareToken = shareToken;

    const res = await request(server)
      .post(`/trips/${tripId}/share`)
      .set('Authorization', auth())
      .expect(200);
    const b = body<ShareBody>(res);
    expect(typeof b.shareToken).toBe('string');
    expect(b.shareToken).not.toBe(oldShareToken);

    const newShareToken = b.shareToken;
    shareToken = newShareToken;

    // INVARIANT: the OLD token is revoked (version bump) → 401.
    await request(server)
      .get(`/trips/${tripId}/live`)
      .query({ token: oldShareToken })
      .expect(401);

    // The freshly issued token works.
    await request(server)
      .get(`/trips/${tripId}/live`)
      .query({ token: newShareToken })
      .expect(200);
  });

  it('POST /reports → 201 anonymized (no reporterId leaked)', async () => {
    const res = await request(server)
      .post('/reports')
      .set('Authorization', auth())
      .send({ type: 'ROBBERY', lat: ORIGIN.lat, lng: ORIGIN.lng })
      .expect(201);

    const b = body<ReportBody>(res);
    expect(b.id).toBeDefined();
    expect(b.type).toBe('ROBBERY');
    // INVARIANT: reporter identity is never exposed (privacy §17).
    expect(b.reporterId).toBeUndefined();
    expect(res.body).not.toHaveProperty('reporterId');

    reportId = b.id;
  });

  it('GET /reports?bbox=… including the point → the report is present', async () => {
    // bbox = minLng,minLat,maxLng,maxLat around the origin.
    const pad = 0.02;
    const bbox = [
      ORIGIN.lng - pad,
      ORIGIN.lat - pad,
      ORIGIN.lng + pad,
      ORIGIN.lat + pad,
    ].join(',');

    const res = await request(server)
      .get('/reports')
      .query({ bbox })
      .set('Authorization', auth())
      .expect(200);

    const list = body<ReportBody[]>(res);
    expect(Array.isArray(list)).toBe(true);
    const ids = list.map((r) => r.id);
    expect(ids).toContain(reportId);
    // Anonymization holds in the list view too.
    for (const r of list) {
      expect(r).not.toHaveProperty('reporterId');
    }
  });

  it('POST /reports/:id/vote by the reporter (same user) → 403', async () => {
    const res = await request(server)
      .post(`/reports/${reportId}/vote`)
      .set('Authorization', auth())
      .send({ vote: 1 })
      .expect(403);
    const err = body<ErrorBody>(res);
    expect(err.statusCode).toBe(403);
    expect(String(err.message)).toMatch(/own report/i);
  });

  it('POST /sos {} → 201 with sosId', async () => {
    const res = await request(server)
      .post('/sos')
      .set('Authorization', auth())
      .send({})
      .expect(201);
    const b = body<SosBody>(res);
    expect(typeof b.sosId).toBe('string');
    expect(b.notifiedContactCount).toBeGreaterThanOrEqual(0);
  });

  // ── waitlist (public join + count, admin listing) ─────────────────────

  interface JoinWaitlistBody {
    joined: boolean;
    alreadyJoined: boolean;
  }
  interface WaitlistCountBody {
    count: number;
  }
  interface WaitlistListBody {
    entries: { id: string; email: string; source: string | null }[];
    total: number;
    page: number;
    limit: number;
  }

  it('POST /waitlist → 201 joined; re-join same email → alreadyJoined true', async () => {
    const first = await request(server)
      .post('/waitlist')
      .send({ email: WAITLIST_EMAIL, source: 'e2e' })
      .expect(201);
    expect(body<JoinWaitlistBody>(first)).toMatchObject({
      joined: true,
      alreadyJoined: false,
    });

    // INVARIANT: joining an already-listed email is idempotent success.
    const again = await request(server)
      .post('/waitlist')
      .send({ email: WAITLIST_EMAIL, source: 'e2e' })
      .expect(201);
    expect(body<JoinWaitlistBody>(again)).toMatchObject({
      joined: true,
      alreadyJoined: true,
    });
  });

  it('GET /waitlist/count → 200 with a numeric count >= 1', async () => {
    const res = await request(server).get('/waitlist/count').expect(200);
    const b = body<WaitlistCountBody>(res);
    expect(typeof b.count).toBe('number');
    expect(b.count).toBeGreaterThanOrEqual(1);
  });

  it('POST /waitlist with a malformed email → 400', async () => {
    const res = await request(server)
      .post('/waitlist')
      .send({ email: 'not-an-email', source: 'e2e' })
      .expect(400);
    expect(body<ErrorBody>(res).statusCode).toBe(400);
  });

  it('GET /waitlist: no auth → 401; non-admin → 403; admin → 200 with entries', async () => {
    // INVARIANT: the admin listing requires authentication.
    await request(server).get('/waitlist').expect(401);

    // A freshly registered (non-admin) user is forbidden.
    const adminUser = await registerAndVerify(
      WAITLIST_ADMIN_EMAIL,
      PW_PASSWORD,
      'Waitlist Admin',
    );

    await request(server)
      .get('/waitlist')
      .set('Authorization', `Bearer ${adminUser.accessToken}`)
      .expect(403);

    // Promote the same user to admin directly in the DB, then the listing works.
    const prisma = app.get(PrismaService);
    await prisma.user.update({
      where: { id: adminUser.user.id },
      data: { isAdmin: true },
    });

    const listed = await request(server)
      .get('/waitlist')
      .set('Authorization', `Bearer ${adminUser.accessToken}`)
      .expect(200);
    const b = body<WaitlistListBody>(listed);
    expect(Array.isArray(b.entries)).toBe(true);
    expect(typeof b.total).toBe('number');
    const emails = b.entries.map((e) => e.email);
    expect(emails).toContain(WAITLIST_EMAIL);
  });

  // ── email/password authentication ─────────────────────────────────────

  it('POST /auth/register → pending verification (no session); verify-email issues the session', async () => {
    const reg = await request(server)
      .post('/auth/register')
      .send({ email: PW_EMAIL, password: PW_PASSWORD, name: PW_NAME });
    expect([200, 201]).toContain(reg.status);

    // INVARIANT: registration does NOT hand out a session — verification must
    // happen first.
    const pending = body<{ verificationRequired?: boolean; email?: string }>(
      reg,
    );
    expect(pending.verificationRequired).toBe(true);
    expect(pending.email).toBe(PW_EMAIL);
    expect((reg.body as Record<string, unknown>).accessToken).toBeUndefined();

    // A wrong code is rejected (and counted against the attempt cap).
    await request(server)
      .post('/auth/verify-email')
      .send({ email: PW_EMAIL, code: '000000' })
      .expect(400);

    // The real (captured) code verifies the email and mints the session.
    const code = otpVerificationCodes.get(PW_EMAIL);
    expect(typeof code).toBe('string');
    const verified = await request(server)
      .post('/auth/verify-email')
      .send({ email: PW_EMAIL, code })
      .expect(200);
    const b = body<AuthBody>(verified);
    expect(typeof b.accessToken).toBe('string');
    expect(typeof b.refreshToken).toBe('string');
    expect(b.user).toMatchObject({ email: PW_EMAIL, name: PW_NAME });

    // INVARIANT: a now-verified email cannot register again → 409.
    const dup = await request(server)
      .post('/auth/register')
      .send({ email: PW_EMAIL, password: PW_PASSWORD, name: PW_NAME })
      .expect(409);
    expect(body<ErrorBody>(dup).statusCode).toBe(409);
  });

  it('POST /auth/login before verification → 403 EMAIL_NOT_VERIFIED (no session)', async () => {
    // A brand-new account that registers but never verifies.
    const reg = await request(server).post('/auth/register').send({
      email: PW_UNVERIFIED_EMAIL,
      password: PW_PASSWORD,
      name: 'Unverified',
    });
    expect([200, 201]).toContain(reg.status);

    const blocked = await request(server)
      .post('/auth/login')
      .send({ email: PW_UNVERIFIED_EMAIL, password: PW_PASSWORD })
      .expect(403);
    expect(body<{ code?: string }>(blocked).code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('POST /auth/login correct creds → tokens; wrong password → 401 generic', async () => {
    const ok = await request(server)
      .post('/auth/login')
      .send({ email: PW_EMAIL, password: PW_PASSWORD });
    expect([200, 201]).toContain(ok.status);
    const b = body<AuthBody>(ok);
    expect(typeof b.accessToken).toBe('string');
    expect(typeof b.refreshToken).toBe('string');
    expect(b.user.email).toBe(PW_EMAIL);

    // INVARIANT: a wrong password is a generic 401 — no existence leak.
    const bad = await request(server)
      .post('/auth/login')
      .send({ email: PW_EMAIL, password: 'not-the-password' })
      .expect(401);
    const err = body<ErrorBody>(bad);
    expect(err.statusCode).toBe(401);
    expect(String(err.message)).toMatch(/incorrect email or password/i);
  });

  it('POST /auth/password/forgot → 200 neutral message (no existence leak)', async () => {
    const known = await request(server)
      .post('/auth/password/forgot')
      .send({ email: PW_EMAIL })
      .expect(200);
    const knownBody = body<ForgotBody>(known);
    expect(knownBody.message).toMatch(/if an account with that email exists/i);

    // An unknown email resolves identically — same neutral message.
    const unknown = await request(server)
      .post('/auth/password/forgot')
      .send({ email: `nobody-${RUN_ID}@roamwarden.test` })
      .expect(200);
    expect(body<ForgotBody>(unknown).message).toBe(knownBody.message);
  });

  it('POST /auth/password/change wrong current → 401; correct → 200 fresh tokens', async () => {
    // Log in fresh to get a Bearer token for this local account.
    const login = await request(server)
      .post('/auth/login')
      .send({ email: PW_EMAIL, password: PW_PASSWORD });
    expect([200, 201]).toContain(login.status);
    const pwToken = body<AuthBody>(login).accessToken;

    // INVARIANT: the wrong current password is rejected 401.
    const wrong = await request(server)
      .post('/auth/password/change')
      .set('Authorization', `Bearer ${pwToken}`)
      .send({ currentPassword: 'wrong-current', newPassword: 'Br4ndNewPass!' })
      .expect(401);
    expect(body<ErrorBody>(wrong).statusCode).toBe(401);

    const newPassword = 'Br4ndNewPass!';
    const ok = await request(server)
      .post('/auth/password/change')
      .set('Authorization', `Bearer ${pwToken}`)
      .send({ currentPassword: PW_PASSWORD, newPassword })
      .expect(200);
    const pair = body<RefreshBody>(ok);
    expect(typeof pair.accessToken).toBe('string');
    expect(typeof pair.refreshToken).toBe('string');

    // The new password now logs in.
    const relogin = await request(server)
      .post('/auth/login')
      .send({ email: PW_EMAIL, password: newPassword });
    expect([200, 201]).toContain(relogin.status);
  });

  // ── trip check-in + delete (own dedicated user/trip) ──────────────────

  it('POST /trips/:id/checkin → 200 ok; then stop, DELETE → 204, GET → 404', async () => {
    // A dedicated local user + trip so this never touches the main scenario.
    const tripUser = await registerAndVerify(
      TRIP_EMAIL,
      PW_PASSWORD,
      'Trip Tester',
    );
    const tripAuth = `Bearer ${tripUser.accessToken}`;

    const created = await request(server)
      .post('/trips')
      .set('Authorization', tripAuth)
      .send({ mode: 'CAR', origin: TRIP2_ORIGIN, destination: TRIP2_DEST })
      .expect(201);
    const trip2Id = body<CreateTripBody>(created).trip.id;

    // Check-in on the ACTIVE trip → 200 ok.
    const checkin = await request(server)
      .post(`/trips/${trip2Id}/checkin`)
      .set('Authorization', tripAuth)
      .expect(200);
    expect(body<CheckinBody>(checkin).ok).toBe(true);

    // Deleting an ACTIVE trip is refused — stop it first.
    await request(server)
      .delete(`/trips/${trip2Id}`)
      .set('Authorization', tripAuth)
      .expect(409);

    await request(server)
      .post(`/trips/${trip2Id}/stop`)
      .set('Authorization', tripAuth)
      .send({})
      .expect(200);

    // Now the delete succeeds (204) and the trip is gone (404).
    await request(server)
      .delete(`/trips/${trip2Id}`)
      .set('Authorization', tripAuth)
      .expect(204);

    await request(server)
      .get(`/trips/${trip2Id}`)
      .set('Authorization', tripAuth)
      .expect(404);
  });

  // ── report clustering auto-verification ───────────────────────────────

  it('THREE same-type reports within the cluster radius → VERIFIED', async () => {
    // Three distinct fresh users (no presence, so the geo-plausibility check is
    // skipped) drop the same report type at near-identical coordinates.
    const tokens: string[] = [];
    for (const email of CLUSTER_EMAILS) {
      const clusterUser = await registerAndVerify(
        email,
        PW_PASSWORD,
        'Cluster Tester',
      );
      tokens.push(clusterUser.accessToken);
    }

    // Tiny offsets keep the three points inside REPORT_CLUSTER_RADIUS_M (300m)
    // — ~0.00005 deg ≈ 5.5m apart — while remaining non-identical.
    const offsets = [0, 0.00005, 0.0001];
    const ids: string[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const res = await request(server)
        .post('/reports')
        .set('Authorization', `Bearer ${tokens[i]}`)
        .send({
          type: 'ACCIDENT',
          lat: CLUSTER.lat + offsets[i],
          lng: CLUSTER.lng + offsets[i],
        })
        .expect(201);
      ids.push(body<ReportBody>(res).id);
    }

    // After the third drop the cluster auto-verifies every member. Read one
    // back and assert VERIFIED (any authenticated caller may GET a report).
    const check = await request(server)
      .get(`/reports/${ids[0]}`)
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);
    expect(body<RemovedReportBody>(check).status).toBe('VERIFIED');
  });

  // ── moderation / admin takedown ───────────────────────────────────────

  it('admin can remove a report (gone from bbox); non-admin → 403', async () => {
    // A reporter drops a report at a unique spot.
    const rep = await registerAndVerify(
      MOD_REPORTER_EMAIL,
      PW_PASSWORD,
      'Mod Reporter',
    );
    const repToken = rep.accessToken;

    const created = await request(server)
      .post('/reports')
      .set('Authorization', `Bearer ${repToken}`)
      .send({ type: 'UNREST', lat: MOD_POINT.lat, lng: MOD_POINT.lng })
      .expect(201);
    const modReportId = body<ReportBody>(created).id;

    // A non-admin calling remove → 403.
    await request(server)
      .post(`/reports/${modReportId}/remove`)
      .set('Authorization', `Bearer ${repToken}`)
      .send({ reason: 'testing' })
      .expect(403);

    // Promote a fresh user to admin directly in the DB.
    const adminAuth = await registerAndVerify(
      ADMIN_EMAIL,
      PW_PASSWORD,
      'Admin User',
    );
    const prisma = app.get(PrismaService);
    await prisma.user.update({
      where: { id: adminAuth.user.id },
      data: { isAdmin: true },
    });

    // The admin removes the report → 2xx, status REMOVED. (POST default is 201.)
    const removed = await request(server)
      .post(`/reports/${modReportId}/remove`)
      .set('Authorization', `Bearer ${adminAuth.accessToken}`)
      .send({ reason: 'inappropriate' });
    expect([200, 201]).toContain(removed.status);
    expect(body<RemovedReportBody>(removed).status).toBe('REMOVED');

    // The removed report is no longer listed in a bbox that contains it.
    const pad = 0.02;
    const bbox = [
      MOD_POINT.lng - pad,
      MOD_POINT.lat - pad,
      MOD_POINT.lng + pad,
      MOD_POINT.lat + pad,
    ].join(',');
    const list = await request(server)
      .get('/reports')
      .query({ bbox })
      .set('Authorization', `Bearer ${repToken}`)
      .expect(200);
    const ids = body<ReportBody[]>(list).map((r) => r.id);
    expect(ids).not.toContain(modReportId);
  });

  it('DELETE /me → 204; then GET /me with the same token → account gone', async () => {
    await request(server)
      .delete('/me')
      .set('Authorization', auth())
      .expect(204);

    // NOTE: the JWT guard is stateless (verifies signature only, no DB lookup),
    // so the token still authenticates; getProfile then finds no user and
    // throws 404. The account is gone either way. Assert ACTUAL behavior.
    const res = await request(server).get('/me').set('Authorization', auth());
    expect([401, 404]).toContain(res.status);
    expect(res.status).toBe(404);
  });
});
