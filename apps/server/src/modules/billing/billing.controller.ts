import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, currentUser, ok, paginationSchema, skipTake } from "../../lib/http.js";
import { badRequest } from "../../lib/errors.js";
import { parseQuery } from "../../middleware/validate.js";
import * as service from "./billing.service.js";
import { catalogue } from "./plans.service.js";
import { handleStripeWebhook, verifyStripeEvent } from "./webhook.service.js";

export async function plans(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "public, max-age=300");
  return ok(res, await catalogue());
}

export function config(_req: Request, res: Response) {
  return ok(res, service.billingConfig());
}

export async function subscription(req: Request, res: Response) {
  return ok(res, await service.getSubscription(ctx(req).orgId));
}

export async function checkout(req: Request, res: Response) {
  const key = req.get("idempotency-key") ?? "";
  if (!/^[\w-]{8,100}$/.test(key)) throw badRequest("An Idempotency-Key header is required");
  return ok(res, await service.checkout(ctx(req).orgId, currentUser(req).email, key));
}

export async function portal(req: Request, res: Response) {
  return ok(res, await service.portal(ctx(req).orgId));
}

export async function invoices(req: Request, res: Response) {
  const p = parseQuery(req, paginationSchema(100, 20));
  const [rows, total] = await service.listInvoices(ctx(req).orgId, skipTake(p));
  return ok(res, rows, { ...p, total });
}

export async function payments(req: Request, res: Response) {
  const p = parseQuery(req, paginationSchema(100, 20));
  const [rows, total] = await service.listPayments(ctx(req).orgId, skipTake(p));
  return ok(res, rows, { ...p, total });
}

export async function webhook(req: Request, res: Response) {
  const event = verifyStripeEvent(req.rawBody, req.get("stripe-signature"));
  const result = await handleStripeWebhook(event);
  return ok(res, { received: true, duplicate: result.duplicate });
}

export const refundSchema = z.object({ amountCents: z.number().int().positive().optional(), reason: z.string().max(300).optional() });
