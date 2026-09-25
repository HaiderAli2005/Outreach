import { Router } from "express";
import * as c from "./inbox.controller.js";

export const inboxRouter = Router();
inboxRouter.get("/", c.list);
inboxRouter.get("/:contactId", c.thread);
inboxRouter.post("/:contactId/reply", c.reply);
inboxRouter.post("/:contactId/deal-closed", c.dealClosed);
inboxRouter.post("/:contactId/handled", c.handled);
inboxRouter.delete("/:contactId", c.remove);
