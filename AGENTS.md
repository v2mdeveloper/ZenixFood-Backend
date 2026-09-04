# ZenixFood SaaS Backend

Node.js + Express single-file API (`server.js`, ~131KB) for a multi-tenant food-ordering
SaaS, using Prisma + PostgreSQL (driver-adapter mode with `pg`).

## Running in Base44

```bash
docker compose -f docker-compose.base44.yml up -d
```

- `db` — postgres:16-alpine (user/db `zenix`, password `zenixpass`), healthchecked.
- `app` — `node:22` with the repo bind-mounted at `/app`. On start it runs
  `npm install`, `npx prisma generate`, `npx prisma db push --accept-data-loss`
  (the committed migration is stale — `db push` syncs the current `schema.prisma`),
  then `node --watch server.js` (live reload on edits). Serves host port **3000**.

There is no frontend — this is an API-only project. The preview shows the JSON
from `GET /` (`{ name, status, version }`). Useful endpoints:

- `GET /api/master/stores` — list all tenant stores (empty until one is created).
- `GET /api/stores/slug/:slug` — public store lookup.
- `GET /api/menu/public/:slug` — public menu for a store.
- `POST /api/auth/admin/login` — admin login (needs `x-store-id` header).

## Environment / secrets

Required to boot (provided by compose, not secrets):
- `DATABASE_URL` — local Postgres connection string.
- `JWT_SECRET` — dev fallback set in compose.
- `PORT` — set to `3000`.

Optional external-service keys (the app boots WITHOUT them; features degrade
gracefully — store-level tokens are used per-tenant when present):
- `MP_ACCESS_TOKEN` — MercadoPago payments.
- `GEMINI_API_KEY` — Gemini AI features.
- `FOCUS_TOKEN` — Focus NFe fiscal document issuance.
- `LUXAND_API_TOKEN` — face-recognition login.

If you want any of those features live, provide the keys via the Base44 secrets
dashboard; they are delivered to `/run/base44/app.env` and picked up by the app service.

## Notes / quirks

- The committed Prisma migration (`20260703170646_init_database`) predates the
  current schema (no `Store`/tenancy columns), so `prisma migrate deploy` would
  produce a stale DB. The Base44 compose uses `prisma db push` instead.
- `prisma/seed.js` only seeds admin employees for stores that already exist; on
  a fresh DB there are no stores, so it is a no-op. Create a store first to seed.
- Express uses `cors()` (all origins) and binds `0.0.0.0`, so the preview's
  external hostname works without extra config.
