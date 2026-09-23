import { prisma } from "../lib/prisma.js";
import { smartleadFor } from "../integrations/smartlead.js";
import { getSettings } from "../domain/settings.js";
import { blockEmail, pauseInFlight } from "../domain/suppression.js";
import { forEachOrg, autopilotOrgs } from "./runner.js";

export async function reconcile(orgId: string): Promise<number> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT c.id FROM "Contact" c
    JOIN "BlocklistEntry" b ON b."organizationId" = c."organizationId" AND (
      (b."entryType" = 'EMAIL' AND b.value = c."emailNormalized") OR
      (b."entryType" = 'DOMAIN' AND b.reason <> 'NO_RESPONSE' AND (b.value = c."companyDomain" OR b.value = c.domain))
    )
    WHERE c."organizationId" = ${orgId}
      AND c.status NOT IN ('BLOCKLISTED','UNSUBSCRIBED','BOUNCED')
      AND b.reason IN ('MANUAL','UNSUBSCRIBED','BOUNCED','COMPLAINED','NO_RESPONSE','REMOVED','DEAL_CLOSED','COMPETITOR','CUSTOMER')
      AND NOT (b.reason = 'NO_RESPONSE' AND c."repliedAt" IS NOT NULL)
      AND NOT (b."entryType" = 'DOMAIN' AND c.status = 'REPLIED')
    LIMIT 5000`;
  if (!ids.length) return 0;
  const r = await prisma.contact.updateMany({ where: { id: { in: ids.map((x) => x.id) }, status: { notIn: ["BLOCKLISTED", "UNSUBSCRIBED", "BOUNCED"] } }, data: { status: "BLOCKLISTED" } });
  return r.count;
}

export async function retireNonResponders(orgId: string): Promise<{ retired: number; skippedUnsent: number; skippedUnreadable: number }> {
  const s = await getSettings(orgId);
  const cutoff = new Date(Date.now() - s.blocklistNoReplyDays * 86_400_000);
  const rows = await prisma.contact.findMany({
    where: { organizationId: orgId, status: "CONTACTED", repliedAt: null, firstContactedAt: { lte: cutoff }, lastContactedAt: { lte: cutoff } },
    select: { id: true, emailNormalized: true, smartleadCampaignId: true, smartleadLeadId: true },
    take: 5000,
  });
  if (!rows.length) return { retired: 0, skippedUnsent: 0, skippedUnreadable: 0 };
  const sl = await smartleadFor(orgId);
  const statuses = new Map<string, Map<string, string> | null>();
  if (sl) {
    for (const campaignId of new Set(rows.map((r) => r.smartleadCampaignId).filter((x): x is string => !!x))) {
      statuses.set(campaignId, await sl.leadStatusMap(campaignId).catch(() => null));
    }
  }
  let retired = 0;
  let skippedUnsent = 0;
  let skippedUnreadable = 0;
  for (const c of rows) {
    if (c.smartleadCampaignId) {
      const map = statuses.get(c.smartleadCampaignId);
      if (!map) {
        skippedUnreadable++;
        continue;
      }
      const st = c.smartleadLeadId ? map.get(c.smartleadLeadId) : undefined;
      if (!st || st === "STARTED") {
        skippedUnsent++;
        continue;
      }
    }
    await prisma.contact.update({ where: { id: c.id }, data: { status: "BLOCKLISTED" } });
    await blockEmail(orgId, c.emailNormalized, "NO_RESPONSE", c.id, { emailOnly: true });
    await pauseInFlight(orgId, [c]);
    retired++;
  }
  return { retired, skippedUnsent, skippedUnreadable };
}

export function runBlocklistJob() {
  return forEachOrg("blocklist", autopilotOrgs, async (orgId) => ({ reconciled: await reconcile(orgId), ...(await retireNonResponders(orgId)) }));
}
