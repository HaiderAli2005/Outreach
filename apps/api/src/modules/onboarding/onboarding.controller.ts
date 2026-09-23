import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok } from "../../lib/http.js";
import { parseBody, parseQuery } from "../../middleware/validate.js";
import * as service from "./onboarding.service.js";

const chips = z.array(z.string().trim().min(1).max(80)).max(12);

export async function state(req: Request, res: Response) {
  return ok(res, await service.getState(ctx(req).orgId));
}

export async function start(req: Request, res: Response) {
  const { domain } = parseBody(req, z.object({ domain: z.string().trim().min(3).max(253) }));
  return ok(res, await service.start(ctx(req).orgId, domain));
}

export async function update(req: Request, res: Response) {
  const body = parseBody(
    req,
    z.object({
      summary: z.string().trim().max(1200).optional(),
      icp: z.object({ industries: chips, titles: chips, sizes: chips, regions: chips }).optional(),
      volume: z.number().int().optional(),
      warmupDays: z.number().int().optional(),
      inboxesPerDomain: z.number().int().min(1).max(5).optional(),
      provider: z.enum(["google", "microsoft", "mixed"]).optional(),
      senderName: z.string().trim().max(120).optional(),
    }),
  );
  return ok(res, await service.update(ctx(req).orgId, body));
}

export async function analyze(req: Request, res: Response) {
  return ok(res, await service.analyze(ctx(req).orgId));
}

export async function reach(req: Request, res: Response) {
  return ok(res, await service.reach(ctx(req).orgId));
}

export async function preview(req: Request, res: Response) {
  return ok(res, await service.preview(ctx(req).orgId));
}

export async function ideas(req: Request, res: Response) {
  const q = parseQuery(req, z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(36).default(12) }));
  return ok(res, await service.ideas(ctx(req).orgId, q.offset, q.limit));
}

export async function saveDomains(req: Request, res: Response) {
  const body = parseBody(req, z.object({ domains: z.array(z.object({ name: z.string().trim().toLowerCase().max(253), inboxes: z.number().int() })).min(1).max(50) }));
  return ok(res, await service.saveDomains(ctx(req).orgId, body.domains));
}

export async function launch(req: Request, res: Response) {
  return ok(res, await service.launch(ctx(req).orgId));
}
