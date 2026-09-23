import { Router } from "express";
import { requireManager } from "../../middleware/auth.js";
import * as c from "./sending.controller.js";

export const sendingRouter = Router();
sendingRouter.get("/mailboxes", requireManager, c.mailboxes);
sendingRouter.post("/provision", requireManager, c.provision);
