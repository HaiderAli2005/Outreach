# API map

Base path `/api/v1`. JSON in and out except CSV exports.

## Conventions

Success:

```json
{ "data": { }, "meta": { "page": 1, "limit": 50, "total": 812 } }
```

Error:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Human readable", "details": [ ] }, "requestId": "…" }
```

* Status codes: 200/201/202/204, 400 validation, 401 unauthenticated, 402 subscription required,
  403 forbidden, 404 not found, 409 conflict, 422 business rule, 429 rate limited, 502 upstream, 503 not configured.
* Auth: `Authorization: Bearer <access token>`. Tenant: the organization is taken from the token's active
  membership (`X-Organization-Id` switches between organizations the user belongs to).
* Lists accept `page`, `limit`, `sort`, `order` and endpoint-specific filters; all validated with zod.

Legend: 🔓 public · 🔑 signed in · 🏢 organization member · 👑 org owner/admin · 🛡 platform admin · 🔏 shared secret

## Auth

| Method | Path | Access | Source equivalent |
|---|---|---|---|
| POST | `/auth/register` | 🔓 | — |
| POST | `/auth/login` | 🔓 rate limited | `POST /users/login` |
| POST | `/auth/refresh` | 🔓 refresh cookie | — |
| POST | `/auth/logout` | 🔓 | `POST /users/logout` |
| GET | `/auth/me` | 🔑 | `GET /users/logindetails` |
| GET | `/auth/oauth/google/start` | 🔓 | — |
| GET | `/auth/oauth/google/callback` | 🔓 | — |
| POST | `/auth/accept-invite` | 🔑 | — |

## Organization

| Method | Path | Access |
|---|---|---|
| GET | `/organizations/current` | 🏢 |
| PATCH | `/organizations/current` | 👑 |
| GET | `/organizations/current/members` | 🏢 |
| POST | `/organizations/current/members` | 👑 invite |
| PATCH | `/organizations/current/members/:id` | 👑 change role |
| DELETE | `/organizations/current/members/:id` | 👑 |

## Onboarding

| Method | Path | Access | Source equivalent |
|---|---|---|---|
| GET | `/onboarding` | 🏢 | — |
| PATCH | `/onboarding` | 👑 (summary, ICP, volume, warmup, provider) | — |
| POST | `/onboarding/analysis` | 👑 | `POST /config/brand-setup` |
| POST | `/onboarding/preview` | 👑 | personalize + followups |
| GET | `/onboarding/domains/ideas` | 👑 | — |
| PUT | `/onboarding/domains` | 👑 (selected domains + inboxes per domain) | — |
| POST | `/onboarding/launch` | 👑 | `POST /config/brand-apply` + `POST /smartlead/provision` |

## Billing

| Method | Path | Access |
|---|---|---|
| GET | `/billing/plans` | 🔓 |
| GET | `/billing/config` | 🔓 publishable key + enabled flag |
| GET | `/billing/subscription` | 🏢 |
| POST | `/billing/checkout` | 👑 idempotent (Idempotency-Key header) |
| POST | `/billing/portal` | 👑 |
| GET | `/billing/invoices` | 🏢 |
| GET | `/billing/payments` | 🏢 |
| POST | `/billing/webhook` | 🔏 Stripe signature, raw body |

## Engine

| Method | Path | Access | Source |
|---|---|---|---|
| GET | `/dashboard/cockpit` | 🏢 | `GET /dashboard/cockpit` |
| GET | `/dashboard/nav-counts` | 🏢 | `GET /dashboard/nav-counts` |
| POST | `/engine/stop` | 👑 | `POST /config/stop` |
| POST | `/engine/start` | 👑 | `POST /config/start` |
| GET | `/inbox` | 🏢 | `GET /inbox` |
| GET | `/inbox/:contactId` | 🏢 | `GET /inbox/:id` |
| POST | `/inbox/:contactId/reply` | 🏢 | `POST /inbox/:id/reply` |
| POST | `/inbox/:contactId/deal-closed` | 🏢 | `POST /inbox/:id/deal-closed` |
| POST | `/inbox/:contactId/handled` | 🏢 | `POST /inbox/:id/handled` |
| DELETE | `/inbox/:contactId` | 🏢 | `DELETE /inbox/:id` |
| GET | `/contacts` | 🏢 | `GET /contacts` |
| GET | `/contacts/stats` | 🏢 | `GET /contacts/stats` |
| GET | `/contacts/export` | 🏢 CSV | `GET /contacts/export` |
| POST | `/contacts/import` | 🏢 | `POST /contacts/import` |
| GET | `/contacts/:id` | 🏢 | `GET /contacts/:id` |
| GET | `/daily` · `/daily/export` | 🏢 | `GET /daily` · `/daily/export` |
| GET | `/batches` · `/batches/pending` · `/batches/:id` | 🏢 | same |
| POST | `/batches/:id/exclude` · `/batches/:id/approve` | 👑 | same |
| GET | `/public/batches/approve` | 🔏 HMAC link | `GET /slack/approve` |
| GET | `/campaigns` | 🏢 | `GET /campaigns` |
| POST | `/campaigns` | 👑 plan limit | (disabled in source) |
| GET | `/campaigns/:id` | 🏢 | `GET /campaigns/:id` |
| PATCH | `/campaigns/:id` | 👑 draft/paused only | (disabled in source) |
| PATCH | `/campaigns/:id/status` | 👑 | `PATCH /campaigns/:id/status` |
| GET | `/campaigns/:id/export` | 🏢 CSV | `GET /campaigns/:id/export` |
| GET | `/blocklist` | 🏢 | `GET /blocklist` |
| POST | `/blocklist` | 🏢 | `POST /blocklist` |
| DELETE | `/blocklist/:id` | 👑 | `DELETE /blocklist/:id` |
| POST | `/blocklist/import` | 🏢 | `POST /blocklist/import` |
| POST | `/blocklist/restore` | 🏢 | `POST /blocklist/restore` |
| GET | `/blocklist/export` | 🏢 CSV | `GET /blocklist/export` |
| GET | `/settings` · PATCH `/settings` | 🏢 / 👑 | `GET/PATCH /config` |
| PUT | `/settings/credentials/:provider` · DELETE | 👑 | key fields of `PATCH /config` |
| GET | `/settings/autopilot-status` | 🏢 | `GET /config/autopilot` |
| POST | `/settings/auto-reply/kill` | 👑 | `POST /config/auto-reply/kill` |
| GET | `/settings/auto-reply/metrics` | 🏢 | `GET /config/auto-reply/metrics` |
| POST | `/settings/verify-email` | 👑 | `GET /config/verify` |
| GET | `/sending/mailboxes` | 👑 | `GET /smartlead/mailboxes` |
| POST | `/sending/provision` | 👑 | `POST /smartlead/provision` |
| POST | `/sourcing/search` | 👑 | `POST /apollo/search` |
| POST | `/sourcing/import` | 👑 | `POST /apollo/import` |
| GET | `/sourcing/usage` | 🏢 | `GET /apollo/usage` |
| GET | `/system-logs` · POST `/system-logs/resolve` | 🏢 / 👑 | `/dashboard/system-log(/resolve)` |

## Webhooks and jobs

| Method | Path | Access | Source |
|---|---|---|---|
| POST | `/webhooks/smartlead?token=` | 🔏 | `POST /webhooks/smartlead` |
| POST | `/webhooks/calendly/:orgToken?token=` | 🔏 | `POST /webhooks/calendly` |
| POST | `/webhooks/apollo/:orgToken?token=` | 🔏 | `POST /webhooks/apollo` |
| GET | `/jobs` | 🔏 | `GET /jobs` |
| POST | `/jobs/:name/run` | 🔏 `X-Jobs-Secret` | `POST /jobs/:name/run` |

## Platform admin

| Method | Path |
|---|---|
| GET | `/admin/overview` |
| GET | `/admin/users` · PATCH `/admin/users/:id` |
| GET | `/admin/organizations` · GET/PATCH `/admin/organizations/:id` |
| GET | `/admin/subscriptions` |
| GET | `/admin/payments` · POST `/admin/payments/:id/refund` |
| GET | `/admin/webhook-events` |
| GET | `/admin/system-logs` |

## Health

`GET /healthz` (liveness, no dependencies) and `GET /api/v1/health` (database and Redis checks; 503 when the
database is unreachable).
