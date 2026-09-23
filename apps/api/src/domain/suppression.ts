import type { BlockReason, ContactStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { extractDomain, isFreeMailDomain, normalizeEmail } from "../lib/normalize.js";
import { smartleadFor } from "../integrations/smartlead.js";
import { logger } from "../lib/logger.js";

interface InFlight {
  id: string;
  emailNormalized: string;
  smartleadCampaignId: string | null;
  smartleadLeadId: string | null;
}

const inFlightSelect = { id: true, emailNormalized: true, smartleadCampaignId: true, smartleadLeadId: true } as const;

export async function pauseInFlight(orgId: string, rows: InFlight[]): Promise<void> {
  const withCampaign = rows.filter((r) => r.smartleadCampaignId);
  if (!withCampaign.length) return;
  const sl = await smartleadFor(orgId).catch(() => null);
  if (!sl) return;
  for (const r of withCampaign) {
    try {
      let leadId = r.smartleadLeadId;
      if (!leadId) {
        leadId = await sl.findLeadId(r.emailNormalized);
        if (leadId) await prisma.contact.update({ where: { id: r.id }, data: { smartleadLeadId: leadId } });
      }
      if (leadId) await sl.pauseLead(r.smartleadCampaignId!, leadId);
    } catch (err) {
      logger.warn({ orgId, contactId: r.id, err: (err as Error).message }, "smartlead pause failed");
    }
  }
}

const HARD_STATUSES: ContactStatus[] = ["BLOCKLISTED", "UNSUBSCRIBED", "BOUNCED"];

async function suppressTarget(orgId: string, normalized: string, contactId: string | null): Promise<number> {
  const where = {
    organizationId: orgId,
    status: { notIn: HARD_STATUSES },
    OR: [{ emailNormalized: normalized }, ...(contactId ? [{ id: contactId }] : [])],
  };
  const targets = await prisma.contact.findMany({ where, select: inFlightSelect });
  if (!targets.length) return 0;
  await prisma.contact.updateMany({ where: { id: { in: targets.map((t) => t.id) } }, data: { status: "BLOCKLISTED" } });
  await pauseInFlight(orgId, targets);
  return targets.length;
}

export interface BlockResult {
  type: "EMAIL" | "DOMAIN" | null;
  value: string | null;
}

export async function blockEmail(
  orgId: string,
  email: string,
  reason: BlockReason,
  contactId: string | null = null,
  opts: { emailOnly?: boolean } = {},
): Promise<BlockResult> {
  const { normalized, domain } = normalizeEmail(email);
  if (!normalized.includes("@")) return { type: null, value: null };
  const dom = (domain ?? extractDomain(email) ?? "").toLowerCase();

  if (dom && !isFreeMailDomain(dom) && !opts.emailOnly) {
    await prisma.blocklistEntry.upsert({
      where: { organizationId_entryType_value: { organizationId: orgId, entryType: "DOMAIN", value: dom } },
      create: { organizationId: orgId, entryType: "DOMAIN", value: dom, reason, contactId },
      update: { reason },
    });
    const siblings = await prisma.contact.findMany({
      where: { organizationId: orgId, OR: [{ companyDomain: dom }, { domain: dom }], status: "CONTACTED", smartleadCampaignId: { not: null } },
      select: inFlightSelect,
    });
    await prisma.contact.updateMany({
      where: { organizationId: orgId, OR: [{ companyDomain: dom }, { domain: dom }], status: { notIn: ["REPLIED", "UNSUBSCRIBED", "BOUNCED"] } },
      data: { status: "BLOCKLISTED" },
    });
    await pauseInFlight(orgId, siblings);
    await suppressTarget(orgId, normalized, contactId);
    return { type: "DOMAIN", value: dom };
  }

  await prisma.blocklistEntry.upsert({
    where: { organizationId_entryType_value: { organizationId: orgId, entryType: "EMAIL", value: normalized } },
    create: { organizationId: orgId, entryType: "EMAIL", value: normalized, reason, contactId },
    update: { reason },
  });
  const mid = await prisma.contact.findMany({
    where: { organizationId: orgId, emailNormalized: normalized, status: "CONTACTED", smartleadCampaignId: { not: null } },
    select: inFlightSelect,
  });
  await prisma.contact.updateMany({
    where: { organizationId: orgId, emailNormalized: normalized, status: { notIn: ["REPLIED", "UNSUBSCRIBED", "BOUNCED"] } },
    data: { status: "BLOCKLISTED" },
  });
  await pauseInFlight(orgId, mid);
  await suppressTarget(orgId, normalized, contactId);
  return { type: "EMAIL", value: normalized };
}

export async function isOptedOut(orgId: string, emailNormalized: string, domain: string | null): Promise<boolean> {
  const n = await prisma.blocklistEntry.count({
    where: {
      organizationId: orgId,
      reason: { in: ["UNSUBSCRIBED", "COMPLAINED"] },
      OR: [{ entryType: "EMAIL", value: emailNormalized }, ...(domain ? [{ entryType: "DOMAIN" as const, value: domain }] : [])],
    },
  });
  return n > 0;
}
