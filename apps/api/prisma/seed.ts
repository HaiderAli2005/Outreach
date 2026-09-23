import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { PLAN_DEFINITIONS } from "../src/config/plans.js";

const prisma = new PrismaClient();

async function main() {
  for (const p of PLAN_DEFINITIONS) {
    await prisma.plan.upsert({
      where: { id: p.id },
      create: { id: p.id, name: p.name, maxDailyVolume: p.maxDailyVolume, priceMonthlyCents: p.priceMonthlyCents, maxCampaigns: p.maxCampaigns, features: p.features, stripePriceId: p.stripePriceId ?? null, sortOrder: p.sortOrder },
      update: { name: p.name, maxDailyVolume: p.maxDailyVolume, priceMonthlyCents: p.priceMonthlyCents, maxCampaigns: p.maxCampaigns, features: p.features, stripePriceId: p.stripePriceId ?? null, sortOrder: p.sortOrder },
    });
  }
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.upsert({
      where: { email },
      create: { email, name: "Platform admin", passwordHash, isPlatformAdmin: true },
      update: { isPlatformAdmin: true },
    });
    console.log(`platform admin ready: ${email}`);
  }
  console.log(`plans seeded: ${PLAN_DEFINITIONS.map((p) => p.id).join(", ")}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
