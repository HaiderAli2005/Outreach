import { Router } from "express";
import { requireAuth, requirePlatformAdmin } from "../../middleware/auth.js";
import * as c from "./admin.controller.js";

export const adminRouter = Router();
adminRouter.use(requireAuth, requirePlatformAdmin);
adminRouter.get("/overview", c.overview);
adminRouter.get("/users", c.users);
adminRouter.patch("/users/:id", c.updateUser);
adminRouter.get("/organizations", c.organizations);
adminRouter.get("/organizations/:id", c.organization);
adminRouter.patch("/organizations/:id", c.updateOrganization);
adminRouter.get("/subscriptions", c.subscriptions);
adminRouter.get("/payments", c.payments);
adminRouter.post("/payments/:id/refund", c.refund);
adminRouter.get("/webhook-events", c.webhookEvents);
adminRouter.get("/system-logs", c.systemLogs);
