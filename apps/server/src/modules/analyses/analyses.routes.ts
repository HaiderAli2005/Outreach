import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ctx } from "../../lib/http.js";
import { parseQuery } from "../../middleware/validate.js";
import { streamRun } from "./analyses.service.js";
import { streamProvisioning } from "./provisioning.service.js";

export const analysesRouter = Router();

analysesRouter.get("/:id/stream", async (req: Request, res: Response) => {
  const q = parseQuery(req, z.object({ from: z.coerce.number().int().min(0).optional() }));
  const header = Number(req.get("last-event-id"));
  const from = q.from ?? (Number.isFinite(header) ? header : 0);
  await streamRun(req, res, ctx(req).orgId, String(req.params.id), from);
});

export const provisioningRouter = Router();

provisioningRouter.get("/:id/provisioning/stream", async (req: Request, res: Response) => {
  await streamProvisioning(req, res, ctx(req).orgId, String(req.params.id));
});
