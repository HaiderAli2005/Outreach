import { Router } from "express";
import { requireAuth, requireManager, requireOrg } from "../../middleware/auth.js";
import * as c from "./billing.controller.js";

export const billingPublicRouter = Router();
billingPublicRouter.get("/plans", c.plans);
billingPublicRouter.get("/config", c.config);
billingPublicRouter.post("/webhook", c.webhook);

export const billingRouter = Router();
billingRouter.use(requireAuth, requireOrg);
billingRouter.get("/subscription", c.subscription);
billingRouter.post("/checkout", requireManager, c.checkout);
billingRouter.post("/portal", requireManager, c.portal);
billingRouter.get("/invoices", c.invoices);
billingRouter.get("/payments", c.payments);
