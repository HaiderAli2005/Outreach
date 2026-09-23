import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { limiter } from "../../middleware/rateLimit.js";
import * as c from "./auth.controller.js";

export const authRouter = Router();

const authLimiter = limiter("auth", 15 * 60_000, 60);

authRouter.get("/providers", c.providers);
authRouter.post("/register", authLimiter, c.register);
authRouter.post("/login", authLimiter, c.login);
authRouter.post("/refresh", limiter("refresh", 60_000, 30), c.refresh);
authRouter.post("/logout", c.logout);
authRouter.get("/me", requireAuth, c.me);
authRouter.post("/accept-invite", requireAuth, c.acceptInvite);
authRouter.get("/oauth/google/start", c.googleStart);
authRouter.get("/oauth/google/callback", c.googleCallback);
