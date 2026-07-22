# RoamWarden API

Backend service for **RoamWarden** — a community-powered travel-safety app (crowd-sourced hazard alerts + live trip sharing with trusted contacts, multi-modal transport).

## Stack

- **NestJS 11** on the **Fastify** adapter
- **TypeScript 7** (native compiler) for build + typecheck — see [TypeScript setup](#typescript-setup)
- **PostgreSQL + PostGIS** (planned — Prisma data model lands next)
- **Redis** (planned — pub/sub geo fan-out, GEO queries)
- Socket.IO gateway, Google Platform APIs, JWT auth, FCM push, Sentry (all planned)

## Setup

```bash
cp example.env .env   # then fill in secrets
npm install
npm run start:dev
```

Server listens on `PORT` (default `3000`) at `0.0.0.0`. CORS origins come from the comma-separated `CORS_ORIGINS` env var.

Smoke test:

```bash
curl http://localhost:3000/health
# {"status":"ok","service":"roamwarden-api","timestamp":"..."}
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Compile `src/` to `dist/` with TypeScript 7 (`tsc -p tsconfig.build.json`; cleans `dist/` first) |
| `npm run typecheck` | Full-project typecheck with TypeScript 7 (`tsc --noEmit`, includes tests) |
| `npm run start` | Start via Nest CLI |
| `npm run start:dev` | Start in watch mode (dev default) |
| `npm run start:debug` | Watch mode with inspector |
| `npm run start:prod` | Run the compiled app (`node dist/main`) |
| `npm test` / `npm run test:watch` / `npm run test:cov` | Unit tests (Jest) |
| `npm run test:e2e` | End-to-end tests (Jest + supertest against the Fastify adapter) |
| `npm run lint` | ESLint (type-aware, `--fix`) |
| `npm run format` | Prettier |
| `npm run clean` | Remove `dist/` |

## TypeScript setup

TypeScript **7.0.2** (the native compiler) performs the project build and typecheck. TS 7.0 ships only the `tsc` executable — the programmatic compiler API returns in TS 7.1 — so API-based tooling (Nest CLI dev server/generators, ts-jest, typescript-eslint) cannot run on it yet.

We therefore use the officially recommended **side-by-side** layout:

- `typescript-7` (npm alias of `typescript@7.0.2`) — drives `npm run build` and `npm run typecheck`.
- `typescript` (`^6.0.3`) — the JS-based compiler API used by the Nest CLI, ts-jest and typescript-eslint. TS 6.0 is the API-compatible bridge release, so build and toolchain agree on language semantics.

When TS 7.1 restores the compiler API (see typescript-eslint/typescript-eslint#10940), collapse this back to a single `typescript@^7.1` dependency and point `build`/`typecheck` at plain `tsc`.

## Next steps (build plan)

1. **Prisma + PostGIS data model** — `users`, `trusted_contacts`, `trips`, `trip_points`, `trip_routes`, `reports`, `report_votes`, `alerts`.
2. **Google auth module** — `POST /auth/google`: verify Google Sign-In ID token (audience check against the three client IDs) → issue JWT access + rotating refresh tokens.
3. **Socket.IO gateway** — live trip location streams + real-time alert delivery.
4. **Redis pub/sub geo fan-out** — route alerts to subscribers near the reported location.
5. **FCM push worker** — background notifications for trip events and nearby alerts (APNs via Firebase).
