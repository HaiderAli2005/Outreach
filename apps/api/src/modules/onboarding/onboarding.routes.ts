import { Router } from "express";
import { requireManager } from "../../middleware/auth.js";
import { limiter } from "../../middleware/rateLimit.js";
import * as c from "./onboarding.controller.js";

export const onboardingRouter = Router();
const aiLimiter = limiter("onboarding-ai", 10 * 60_000, 20);

onboardingRouter.get("/", c.state);
onboardingRouter.post("/start", requireManager, c.start);
onboardingRouter.patch("/", requireManager, c.update);
onboardingRouter.post("/analysis", requireManager, aiLimiter, c.analyze);
onboardingRouter.post("/answers", requireManager, aiLimiter, c.answers);
onboardingRouter.get("/market", c.market);
onboardingRouter.post("/preview", requireManager, aiLimiter, c.preview);
onboardingRouter.get("/domains/ideas", requireManager, c.ideas);
onboardingRouter.put("/domains", requireManager, c.saveDomains);
onboardingRouter.post("/launch", requireManager, c.launch);
