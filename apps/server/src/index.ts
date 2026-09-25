import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { closeRedis } from "./lib/redis.js";
import { seedPlans } from "./modules/billing/plans.service.js";
import { interruptActiveRuns } from "./modules/analyses/analyses.service.js";

async function main() {
  await prisma.$connect();
  await seedPlans();
  const app = createApp();
  const server = app.listen(env.PORT, "0.0.0.0", () => logger.info({ port: env.PORT }, "api listening"));
  server.requestTimeout = 15 * 60_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 61_000;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    setTimeout(() => process.exit(1), 10_000).unref();
    // Ends any analysis mid-run first, so the page starts a fresh one instead of waiting on a dead one.
    await Promise.race([interruptActiveRuns().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
    server.close(async () => {
      await prisma.$disconnect().catch(() => undefined);
      await closeRedis();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
