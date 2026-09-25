import type { Request, Response } from "express";
import { ctx, ok } from "../../lib/http.js";
import * as service from "./dashboard.service.js";

export async function cockpit(req: Request, res: Response) {
  return ok(res, await service.cockpit(ctx(req).orgId));
}

export async function navCounts(req: Request, res: Response) {
  return ok(res, await service.navCounts(ctx(req).orgId));
}
