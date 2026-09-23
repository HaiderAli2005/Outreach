# Authentication and authorization

## What the source did

* No registration; logins were inserted by a script.
* Passwords stored in plaintext and compared with `timingSafeEqual`.
* One 7-day JWT in an httpOnly cookie; `requireAuth` on data routes.
* In-memory login throttle (8 attempts / 15 minutes per ip+email).
* No roles: every login saw and changed everything.

Kept: fail-closed middleware, constant-time failure path (a dummy hash compare when the user does not
exist), throttling, generic "Invalid email or password". Replaced: everything else.

## Tokens

| Token | Where | Lifetime | Contents |
|---|---|---|---|
| Access (JWT HS256) | memory in the web app, sent as `Authorization: Bearer` | 15 min | `sub` user id, `org` active organization id, `role`, `pa` platform admin flag |
| Refresh (opaque 256-bit) | httpOnly, `Secure`, `SameSite=Strict`, `Path=/api/v1/auth` cookie | 30 days | random; only its SHA-256 hash is stored in `RefreshToken` |

Refresh rotation: every `/auth/refresh` revokes the presented token and issues a new one in the same
`familyId`. Presenting an already-revoked token revokes the whole family (token theft detection) and returns
401. Logout revokes the current token and clears the cookie. Disabling a user revokes all their tokens.

Because the access token never lives in a cookie, API calls are not exposed to CSRF. The refresh endpoint is
the only cookie-authenticated route; it is protected by `SameSite=Strict`, the narrow cookie path, a
required `X-Requested-With: aperture` header (a cross-site form cannot set it) and the CORS allow-list.

## Passwords

bcrypt, cost 12. Minimum 8 characters, maximum 128. Login is rate-limited per IP and per email (Redis
store when available, memory otherwise): 8 failures per 15 minutes.

## Google OAuth 2.0

Authorization code flow with PKCE and `state`:

1. `GET /auth/oauth/google/start?redirect=/onboarding` stores `state`, the PKCE verifier and the post-login
   redirect in a short-lived signed, httpOnly cookie and redirects to Google.
2. `GET /auth/oauth/google/callback` checks `state`, exchanges the code with the verifier, reads the
   verified email from the ID token (`email_verified` must be true), links or creates the user (and a new
   organization for a first-time user), sets the refresh cookie and redirects to `/auth/callback` in the web
   app, which calls `/auth/refresh` to obtain an access token.

When `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are not set, the start endpoint returns 503 and the web app
hides the button.

## Authorization layers

1. `requireAuth` validates the access token and loads the user (disabled users are rejected).
2. `requireOrg` resolves the active membership (token `org`, or `X-Organization-Id` if the user is a member
   of that organization) and rejects suspended organizations. It sets `req.ctx = { userId, orgId, role }`.
3. `requireRole('OWNER','ADMIN')` for configuration, billing, members and destructive actions.
4. `requirePlatformAdmin` for `/admin/*`.
5. Repositories take `orgId` as a mandatory argument, so a missing tenant filter is a type error rather than a
   data leak. Isolation tests cover every tenant-owned resource.

| Action | OWNER | ADMIN | MEMBER |
|---|---|---|---|
| Read dashboard, inbox, leads, campaigns, blocklist, logs | ✓ | ✓ | ✓ |
| Reply, mark handled, deal closed, remove person, add to blocklist, import leads | ✓ | ✓ | ✓ |
| Approve/exclude weekly leads, pause/resume campaigns | ✓ | ✓ | ✗ |
| Settings, integrations, engine stop/start, auto-reply | ✓ | ✓ | ✗ |
| Billing, members, onboarding changes | ✓ | ✓ | ✗ |
| Transfer or remove the owner | ✓ | ✗ | ✗ |

## Web app route protection

`/app/*` and `/admin/*` render inside `AuthGate`, which attempts a silent refresh on first load and
redirects to `/signin?next=` when that fails. This is a UX convenience only: every protected API route
checks permissions server-side.
