import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { safeEqual } from "../../lib/crypto.js";
import { unauthorized } from "../../lib/errors.js";
import { ok } from "../../lib/http.js";
import * as service from "./webhooks.service.js";

function authorize(req: Request): void {
  const token = String(req.query.token ?? req.get("x-webhook-secret") ?? "");
  if (!token || !safeEqual(token, env.WEBHOOK_SECRET)) throw unauthorized("Invalid webhook token");
}

export async function smartlead(req: Request, res: Response) {
  authorize(req);
  return ok(res, await service.handleSmartlead((req.body ?? {}) as Record<string, unknown>));
}

export async function calendly(req: Request, res: Response) {
  authorize(req);
  return ok(res, await service.handleCalendly(String(req.params.orgToken), (req.body ?? {}) as Record<string, unknown>));
}

export async function apollo(req: Request, res: Response) {
  authorize(req);
  return ok(res, await service.handleApollo(String(req.params.orgToken), (req.body ?? {}) as Record<string, unknown>));
}
