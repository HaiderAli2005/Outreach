import type { Request, Response, CookieOptions } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env, features, isProd, webOrigins } from "../../config/env.js";
import { ok, created, currentUser } from "../../lib/http.js";
import { badRequest, unauthorized } from "../../lib/errors.js";
import { parseBody } from "../../middleware/validate.js";
import * as service from "./auth.service.js";
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH, REFRESH_TTL_DAYS } from "./tokens.js";
import { buildGoogleAuthUrl, exchangeGoogleCode, type OAuthState } from "./oauth.google.js";

const OAUTH_COOKIE = "ap_oauth";

const refreshCookieOpts = (): CookieOptions => ({
  httpOnly: true,
  secure: isProd,
  sameSite: "strict",
  path: REFRESH_COOKIE_PATH,
  maxAge: REFRESH_TTL_DAYS * 86_400_000,
});

function meta(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null };
}

function sendSession(res: Response, result: { session: service.SessionPayload; refreshToken: string }, status = 200) {
  res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOpts());
  return status === 201 ? created(res, result.session) : ok(res, result.session);
}

const password = z.string().min(8, "Use at least 8 characters").max(128);

const registerSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(120),
  email: z.email("Enter a valid email").max(254),
  password,
  organizationName: z.string().trim().max(120).optional(),
  domain: z.string().trim().max(253).optional(),
});

const loginSchema = z.object({ email: z.email("Enter a valid email"), password: z.string().min(1).max(128) });

export async function register(req: Request, res: Response) {
  const body = parseBody(req, registerSchema);
  return sendSession(res, await service.register(body, meta(req)), 201);
}

export async function login(req: Request, res: Response) {
  const body = parseBody(req, loginSchema);
  return sendSession(res, await service.login(body.email, body.password, meta(req)));
}

export async function refresh(req: Request, res: Response) {
  if (req.get("x-requested-with") !== "aperture") throw badRequest("Missing X-Requested-With header");
  const org = typeof req.body?.organizationId === "string" ? req.body.organizationId : null;
  try {
    return sendSession(res, await service.refresh(req.cookies?.[REFRESH_COOKIE], org, meta(req)));
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    throw err;
  }
}

export async function logout(req: Request, res: Response) {
  await service.logout(req.cookies?.[REFRESH_COOKIE]);
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  return ok(res, { signedOut: true });
}

export async function me(req: Request, res: Response) {
  const user = currentUser(req);
  return ok(res, await service.me(user.id, req.get("x-organization-id") ?? (req as { tokenOrg?: string | null }).tokenOrg ?? null));
}

export async function acceptInvite(req: Request, res: Response) {
  const { token } = parseBody(req, z.object({ token: z.string().min(10).max(200) }));
  const user = currentUser(req);
  return ok(res, await service.acceptInvite(user.id, user.email, token));
}

export function providers(_req: Request, res: Response) {
  return ok(res, { google: features.googleOAuth });
}

export function googleStart(req: Request, res: Response) {
  const { url, state } = buildGoogleAuthUrl(String(req.query.next ?? "/app"));
  const signed = jwt.sign(state, env.JWT_ACCESS_SECRET, { expiresIn: 600 });
  res.cookie(OAUTH_COOKIE, signed, { httpOnly: true, secure: isProd, sameSite: "lax", path: "/api/v1/auth/oauth", maxAge: 600_000 });
  res.redirect(302, url);
}

export async function googleCallback(req: Request, res: Response) {
  const web = webOrigins[0] ?? "";
  const fail = (reason: string) => res.redirect(302, `${web}/signin?error=${encodeURIComponent(reason)}`);
  const raw = req.cookies?.[OAUTH_COOKIE];
  res.clearCookie(OAUTH_COOKIE, { path: "/api/v1/auth/oauth" });
  if (req.query.error) return fail("Google sign-in was cancelled");
  let state: OAuthState;
  try {
    state = jwt.verify(String(raw ?? ""), env.JWT_ACCESS_SECRET) as OAuthState;
  } catch {
    return fail("Your sign-in session expired, please try again");
  }
  if (!req.query.state || req.query.state !== state.state || typeof req.query.code !== "string") return fail("Google sign-in failed");
  try {
    const identity = await exchangeGoogleCode(req.query.code, state.verifier);
    const result = await service.oauthSignIn("google", identity.sub, identity.email, identity.name, meta(req));
    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOpts());
    return res.redirect(302, `${web}/auth/callback?next=${encodeURIComponent(state.next)}`);
  } catch (err) {
    if (err instanceof Error && err.message) return fail(err.message);
    throw unauthorized();
  }
}
