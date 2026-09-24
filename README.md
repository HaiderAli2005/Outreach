# Aperture

Multi-tenant outbound email SaaS. A company enters its domain, gets a free analysis and preview, picks a
daily volume, buys sending domains and inboxes in one Stripe checkout, and launches its first campaign.

- `apps/api`: Node, Express 5, TypeScript, Prisma, PostgreSQL, optional Redis
- `apps/web`: Next.js (App Router), TypeScript, Redux Toolkit / RTK Query, Tailwind
- `infra`: Docker Compose for local services, Dockerfiles, Cloud Build and GCP scripts
- `docs`: architecture, API map, schema, auth, Stripe, SaaS model, deployment, feature map, migration plan

## Local setup

Requirements: Node 20 or newer, Docker (or your own PostgreSQL 16 and Redis 7).

```bash
npm run setup
npm run dev
```

`npm run setup` starts Postgres and Redis in Docker, installs packages, creates `apps/api/.env` with fresh
local secrets and `apps/web/.env.local`, applies migrations (never resets data) and seeds the plans. On
the first run it also creates a platform admin and prints its password once. `npm run dev` runs the API
and the web app together.

The web app runs on http://localhost:3000 and proxies `/api` to the API on port 4000. The Docker
Postgres listens on port 5433 so it doesn't clash with a Postgres already installed on 5432.

Integrations switch on when their keys are set in `apps/api/.env`: Stripe (billing), OpenAI (site
analysis and sequences), Apollo (market sizing and leads), Smartlead (campaigns and mailboxes), Google
OAuth (sign in). Without a key, the related screens say what is missing instead of showing sample data.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

`npm test` runs the API tests (they need the `aperture_test` database that `npm run db:up` creates)
and then the web tests, which run in jsdom with the network mocked.

## Deploying

See `docs/deployment.md` for Cloud Run, Cloud SQL, Memorystore, Secret Manager and Cloud Scheduler, and
`docs/migration-plan.md` for the cut-over checklist and known gaps.
