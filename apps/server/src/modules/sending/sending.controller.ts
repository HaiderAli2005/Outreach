import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok } from "../../lib/http.js";
import { parseBody } from "../../middleware/validate.js";
import * as service from "./sending.service.js";

export async function mailboxes(req: Request, res: Response) {
  return ok(res, await service.mailboxes(ctx(req).orgId));
}

export async function provision(req: Request, res: Response) {
  const body = parseBody(req, z.object({ mailboxIds: z.array(z.number().int().positive()).min(1).max(500), campaignId: z.string().optional() }));
  return ok(res, await service.provision(ctx(req).orgId, body.mailboxIds, body.campaignId));
}
