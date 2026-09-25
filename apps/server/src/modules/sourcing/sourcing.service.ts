import { prisma } from "../../lib/prisma.js";
import { notConfigured, notFound, unprocessable } from "../../lib/errors.js";
import { assertActiveSubscription } from "../../domain/entitlements.js";
import { getSettings } from "../../domain/settings.js";
import { creditPacing } from "../../domain/usage.js";
import { searchPreview, sourceForCampaign } from "../../domain/sourcing.js";
import { resolveImportBatch } from "../../domain/batches.js";

export async function search(orgId: string, body: { campaignId?: string; filters?: Record<string, unknown>; page: number }) {
  let filters = body.filters ?? {};
  if (body.campaignId) {
    const c = await prisma.campaign.findFirst({ where: { id: body.campaignId, organizationId: orgId } });
    if (!c) throw notFound("Campaign");
    filters = (c.apolloFilters ?? {}) as Record<string, unknown>;
  }
  const r = await searchPreview(orgId, filters, body.page, 25);
  if (!r) throw notConfigured("Apollo");
  return {
    totalEntries: r.totalEntries,
    people: r.people.map((p) => ({
      id: p.id,
      name: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" "),
      title: p.title,
      company: p.organization?.name ?? p.organization_name,
      location: [p.city, p.country].filter(Boolean).join(", "),
    })),
  };
}

export async function importNow(orgId: string, campaignId: string, maxEnrich: number) {
  await assertActiveSubscription(orgId);
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, organizationId: orgId } });
  if (!campaign) throw notFound("Campaign");
  if (campaign.status !== "ACTIVE") throw unprocessable("Resume the campaign before sourcing into it");
  const s = await getSettings(orgId);
  const pacing = await creditPacing(orgId, s);
  const allowance = pacing.unlimited ? maxEnrich : Math.min(maxEnrich, pacing.allowanceToday ?? 0);
  if (allowance <= 0) throw unprocessable("Today's lead credit allowance is used up");
  const batch = await resolveImportBatch(orgId);
  return sourceForCampaign(orgId, campaign, { maxEnrich: allowance, batchId: batch?.id ?? null });
}

export async function usage(orgId: string) {
  const s = await getSettings(orgId);
  const days = await prisma.usageCounter.findMany({ where: { organizationId: orgId }, orderBy: { day: "desc" }, take: 31 });
  return { pacing: await creditPacing(orgId, s), days };
}
