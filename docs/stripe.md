# Stripe integration

## Product model (from the design)

| Item | Price | Stripe object |
|---|---|---|
| Launch plan (≤ 500 emails/day) | $79 / month | recurring Price, env `STRIPE_PRICE_LAUNCH` |
| Growth plan (≤ 2,000/day) | $199 / month | `STRIPE_PRICE_GROWTH` |
| Scale plan (≤ 5,000/day) | $449 / month | `STRIPE_PRICE_SCALE` |
| Inbox | $4 / month each | recurring Price with quantity, `STRIPE_PRICE_INBOX` |
| Pre-warmed inbox (fast start) | `INBOX_FAST_PRICE_CENTS` / month each | optional, `STRIPE_PRICE_INBOX_FAST`. When unset, fast start shows as unavailable. |
| Sending domain | per TLD, yearly | one-time invoice item added to the first invoice (price_data) |

Sizing rules: an inbox sends at most 40 emails/day when warm; inboxes needed = ceil(volume / 40); domains
needed = ceil(inboxes / inboxes-per-domain). These live in `apps/api/src/config/plans.ts` and are served
by `/billing/plans`, so the landing slider, the onboarding steps and the backend total all use one formula.

## Flow

```text
Onboarding step 7 (web)
  └─ POST /billing/checkout  { Idempotency-Key }
       ├─ ensureCustomer(org)            → stripe.customers.create (idempotency key org:<id>:customer)
       ├─ stripe.subscriptions.create    → items: plan price + inbox price × quantity
       │     payment_behavior=default_incomplete, add_invoice_items: domains,
       │     expand latest_invoice.payment_intent, idempotency key from the header
       ├─ Subscription row (INCOMPLETE) + Payment row (REQUIRES_PAYMENT)
       └─ returns { clientSecret, subscriptionId }
  └─ stripe.confirmPayment(PaymentElement)   (card data goes straight to Stripe)
Stripe ──webhook──▶ POST /billing/webhook
       ├─ verify signature (STRIPE_WEBHOOK_SECRET, raw body)
       ├─ insert WebhookEvent(provider=STRIPE, externalId=event.id)  ← unique; duplicates acknowledged, not reprocessed
       └─ dispatch:
            invoice.paid                     → Payment SUCCEEDED, Invoice upsert, Subscription ACTIVE, onboarding.paidAt, domains → PENDING_REGISTRATION
            invoice.payment_failed           → Payment FAILED (+ message), Subscription PAST_DUE, SystemLog WARN
            customer.subscription.updated    → status, period end, cancel_at_period_end, plan/quantity
            customer.subscription.deleted    → CANCELED, autopilot switched off
            payment_intent.succeeded/failed  → Payment status sync
            charge.refunded                  → Payment REFUNDED / PARTIALLY_REFUNDED, amountRefunded
```

The web app polls `GET /billing/subscription` after confirmation until the webhook has activated the
subscription, then moves to the launch step. It never trusts the client-side confirmation alone.

## Idempotency

* Outbound: every mutating Stripe call passes an idempotency key. Checkout uses the client's
  `Idempotency-Key` header (the web app generates one per checkout attempt), so a double click or a retried
  request cannot create two subscriptions. Customer creation uses a deterministic key per organization.
* Inbound: `WebhookEvent(provider, externalId)` is unique. The handler inserts first; on a unique-constraint
  violation it returns 200 without processing. A handler failure marks the event `FAILED` and returns 500 so
  Stripe retries; the retry finds the existing row in `FAILED` state and processes it again.

## Failed payments

`invoice.payment_failed` sets the subscription to `PAST_DUE`. Every scheduled job checks
`hasActiveSubscription(org)` (ACTIVE or TRIALING) before doing paid work, so sending stops while payment is
outstanding. The app shows a banner with a link to the Stripe customer portal (`POST /billing/portal`) to
update the card; Stripe's own retries and the next `invoice.paid` reactivate everything.

## Refunds

Platform admins refund from `/admin/payments` → `POST /admin/payments/:id/refund { amountCents?, reason }`.
The API calls `stripe.refunds.create` with an idempotency key, stores a `Refund` row, and the resulting
`charge.refunded` webhook updates the payment status. Partial refunds are supported.

## Secrets

`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are server-only (Secret Manager in production). The web app
only ever receives the publishable key, from `GET /billing/config`. When `STRIPE_SECRET_KEY` is missing the
billing endpoints respond 503 `BILLING_NOT_CONFIGURED` and the payment step says so; nothing is simulated.

## Testing

`test/billing.test.ts` injects a fake Stripe client into the billing service (the only seam) and uses
`stripe.webhooks.generateTestHeaderString` with the real SDK to produce valid and invalid signatures. It
covers checkout creation, idempotent retries, successful payment, failed payment, duplicate webhooks,
refunds and signature rejection.

## Local setup

```bash
stripe login
stripe listen --forward-to localhost:4000/api/v1/billing/webhook   # prints whsec_… → STRIPE_WEBHOOK_SECRET
npm run stripe:prices -w apps/api                                   # creates the four recurring prices, prints env lines
```
