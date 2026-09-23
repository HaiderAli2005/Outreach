import { prisma } from "../../lib/prisma.js";
import {
  INBOX_PRICE_CENTS,
  MAX_INBOXES_PER_DOMAIN,
  PLAN_DEFINITIONS,
  SENDS_PER_WARM_INBOX,
  TLD_PRICES_CENTS,
  VOLUME_MAX,
  VOLUME_MIN,
  WARMUP_OPTIONS,
  WARMUP_START_PER_INBOX,
} from "../../config/plans.js";

export async function seedPlans(): Promise<void> {
  for (const p of PLAN_DEFINITIONS) {
    await prisma.plan.upsert({
      where: { id: p.id },
      create: { id: p.id, name: p.name, maxDailyVolume: p.maxDailyVolume, priceMonthlyCents: p.priceMonthlyCents, maxCampaigns: p.maxCampaigns, features: p.features, stripePriceId: p.stripePriceId ?? null, sortOrder: p.sortOrder },
      update: { name: p.name, maxDailyVolume: p.maxDailyVolume, priceMonthlyCents: p.priceMonthlyCents, maxCampaigns: p.maxCampaigns, features: p.features, stripePriceId: p.stripePriceId ?? null, sortOrder: p.sortOrder },
    });
  }
}

export async function catalogue() {
  const plans = await prisma.plan.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } });
  return {
    plans: plans.map((p) => ({ id: p.id, name: p.name, maxDailyVolume: p.maxDailyVolume, priceMonthlyCents: p.priceMonthlyCents, maxCampaigns: p.maxCampaigns, features: p.features as string[] })),
    sizing: {
      sendsPerWarmInbox: SENDS_PER_WARM_INBOX,
      warmupStartPerInbox: WARMUP_START_PER_INBOX,
      inboxPriceCents: INBOX_PRICE_CENTS,
      maxInboxesPerDomain: MAX_INBOXES_PER_DOMAIN,
      warmupOptions: WARMUP_OPTIONS,
      volumeMin: VOLUME_MIN,
      volumeMax: VOLUME_MAX,
      tldPricesCents: TLD_PRICES_CENTS,
    },
  };
}
