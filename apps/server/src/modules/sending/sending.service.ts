import { prisma } from "../../lib/prisma.js";
import { unprocessable, upstream } from "../../lib/errors.js";
import { smartleadFor } from "../../integrations/smartlead.js";
import { getSettings } from "../../domain/settings.js";
import { provisionCampaign } from "../../domain/provisioning.js";

export async function mailboxes(orgId: string) {
  const [sl, settings, planned] = await Promise.all([
    smartleadFor(orgId),
    getSettings(orgId),
    prisma.mailbox.findMany({ where: { organizationId: orgId }, orderBy: { address: "asc" }, include: { sendingDomain: { select: { name: true, status: true } } } }),
  ]);
  const base = { attached: settings.smartleadMailboxIds, planned, defaultCampaignId: settings.smartleadDefaultCampaignId };
  if (!sl) return { connected: false, accounts: [], ...base };
  try {
    const accounts = await sl.listMailboxes();
    return { connected: true, accounts: accounts.map((a) => ({ ...a, attached: settings.smartleadMailboxIds.includes(a.id) })), ...base };
  } catch (err) {
    throw upstream("Smartlead", (err as Error).message);
  }
}

export async function provision(orgId: string, mailboxIds: number[], campaignId?: string) {
  const campaign = campaignId
    ? await prisma.campaign.findFirst({ where: { id: campaignId, organizationId: orgId } })
    : await prisma.campaign.findFirst({ where: { organizationId: orgId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  if (!campaign) throw unprocessable("Create or resume a campaign first");
  return provisionCampaign(orgId, campaign.id, mailboxIds);
}
