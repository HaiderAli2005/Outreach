import { Router } from "express";
import * as c from "./contacts.controller.js";

export const contactsRouter = Router();
contactsRouter.get("/", c.list);
contactsRouter.get("/stats", c.stats);
contactsRouter.get("/export", c.exportCsv);
contactsRouter.post("/import", c.importCsv);
contactsRouter.get("/:id", c.detail);

export const dailyRouter = Router();
dailyRouter.get("/", c.daily);
dailyRouter.get("/export", c.dailyExport);
