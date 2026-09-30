# Infraforge: sending domains and inboxes

After a customer pays, Aperture buys their sending domains and inboxes through Infraforge, connects the inboxes to Smartlead with warmup on, and adds them to the campaign when warmup ends. Nobody has to click anything.

## Setup

1. In Infraforge, open **Settings → API** and create a key.
2. Add credits in Infraforge and turn on **auto top-up**. Domains and inboxes are paid from this balance.
3. Set these in `apps/server/.env`:

| Variable | What it is |
| --- | --- |
| `INFRAFORGE_API_KEY` | The key from step 1. Without it nothing is bought. |
| `INFRAFORGE_CONTACT_*` | Registrant details for the domains (first and last name, email, phone, organization, address, city, province, postal code, two-letter country). All are required. |
| `INFRAFORGE_DMARC_EMAIL`, `INFRAFORGE_DMARC_POLICY` | Where DMARC reports go, and the policy (default `quarantine`). |
| `INFRAFORGE_DEDICATED_IP_MIN_VOLUME` | Customers sending at least this many emails a day get their own IP (default 2,500). |
| `INFRAFORGE_SSL_FORWARDING` | SSL on domain forwarding, so `https://getbrand.com` also lands on the customer's site (default on, about $2 a domain a month). |
| `INFRAFORGE_MAX_DOMAIN_PRICE_CENTS` | Premium names above this price are never bought (default $50). |
| `INFRAFORGE_RELEASE_AFTER_DAYS` | Days after a subscription ends before its inboxes are closed (default 7). |
| `SMARTLEAD_API_KEY` | Needed so the inboxes can be connected for warmup and sending. |

4. Run `npm run dev`. The new database migration is applied automatically, and locally the setup job runs every minute inside the API. In production, `infra/scripts/scheduler.sh` creates the `infra-provision` (every 2 minutes) and `infra-release` (daily) jobs.

## What happens after payment

| Step | Domain status | Inbox status |
| --- | --- | --- |
| Paid, queued | `PENDING_REGISTRATION` | `PENDING` |
| Bought, waiting on the registrar | `REGISTERING` | |
| Live, forwarding to the customer's site, SPF, DKIM, DMARC and MX checked | `REGISTERED` | |
| Inbox bought | | `CREATING` |
| Inbox live at Infraforge, being added to Smartlead | | `CONNECTING` |
| In Smartlead with warmup on | | `WARMING` |
| Warmup finished, added to the campaign | | `ACTIVE` |
| Subscription ended, inbox closed | | `RELEASED` |

- **One Infraforge workspace per customer**, so their domains, inboxes and IP reputation never mix with anyone else's.
- **Taken domains**: if a picked domain was registered by someone else between checkout and purchase, the closest free lookalike is registered instead and its inboxes move with it. The customer sees a note in their activity log.
- **Fast start**: branded pre-warmed domains from Infraforge are used when there are enough. Any domain that can't be covered is registered fresh and always gets a proper 14 day warmup.
- **Ramp**: once active, sends per inbox climb from 10 a day to the daily limit over 14 days. If bounces go above 3% in a week, the climb pauses until they settle.
- **No double purchases**: Infraforge has no idempotency key, so every purchase is preceded by a read. A purchase that timed out is adopted on the next run instead of being bought again. Purchases are never retried automatically.
- **Passwords are never stored**: inbox credentials go from Infraforge straight into Smartlead.
- **Low credits** pause purchases (reads and polling carry on) and raise a critical alert. The pause clears on its own after a top-up. A card checkout request needs a payment in Infraforge, then **Resume** in the admin console.
- **Failures** back off (1, 2, 4 ... minutes) and stop after 6 tries with a clear reason.

## Admin console

**Admin → Infrastructure** shows the credit balance, how many customers are on dedicated IPs, where every domain and inbox is, paused setups (with Resume), and anything that failed (with Retry, which continues from the step where it stopped).
