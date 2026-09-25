import { prisma } from "../../lib/prisma.js";
import { unprocessable } from "../../lib/errors.js";
import { smartleadFor } from "../../integrations/smartlead.js";
import { getCredential } from "../../integrations/credentials.js";
import { features } from "../../config/env.js";
import { assertActiveSubscription } from "../../domain/entitlements.js";
import { getSettings } from "../../domain/settings.js";
import { logSystem } from "../../domain/systemLog.js";

async function smartleadCampaignIds(orgId: string, defaultId: string | null): Promise<string[]> {
  const ids = new Set<string>();
  const [campaigns, contacts] = await Promise.all([
    prisma.campaign.findMany({ where: { organizationId: orgId, smartleadCampaignId: { not: null } }, select: { smartleadCampaignId: true } }),
    prisma.contact.findMany({ where: { organizationId: orgId, status: "CONTACTED", smartleadCampaignId: { not: null } }, distinct: ["smartleadCampaignId"], select: { smartleadCampaignId: true } }),
  ]);
  for (const c of campaigns) if (c.smartleadCampaignId) ids.add(c.smartleadCampaignId);
  for (const c of contacts) if (c.smartleadCampaignId) ids.add(c.smartleadCampaignId);
  if (defaultId) ids.add(defaultId);
  return [...ids];
}

export async function stop(orgId: string) {
  await prisma.orgSettings.update({ where: { organizationId: orgId }, data: { autopilotEnabled: false, autoReplyMode: "OFF" } });
  const cancelled = await prisma.autoReplyQueue.updateMany({ where: { organizationId: orgId, status: "PENDING" }, data: { status: "CANCELLED", cancelReason: "outreach-stopped" } });
  const s = await getSettings(orgId);
  let paused = 0;
  const sl = await smartleadFor(orgId);
  if (sl) {
    for (const id of await smartleadCampaignIds(orgId, s.smartleadDefaultCampaignId)) {
      try {
        await sl.setStatus(id, "PAUSED");
        paused++;
      } catch (err) {
        await logSystem(orgId, "ERROR", "engine", `Could not pause Smartlead campaign ${id}: ${(err as Error).message}`);
      }
    }
  }
  return { stopped: true, smartleadCampaignsPaused: paused, autoRepliesCancelled: cancelled.count };
}

export async function start(orgId: string) {
  await assertActiveSubscription(orgId);
  const apollo = await getCredential(orgId, "APOLLO");
  if (!apollo || !features.ai) throw unprocessable("Can't start yet: a connection is missing. Finish Settings → Integrations first.");
  await prisma.orgSettings.update({ where: { organizationId: orgId }, data: { autopilotEnabled: true } });
  const s = await getSettings(orgId);
  let resumed = 0;
  const sl = await smartleadFor(orgId);
  if (sl) {
    for (const id of await smartleadCampaignIds(orgId, s.smartleadDefaultCampaignId)) {
      try {
        await sl.setStatus(id, "START");
        resumed++;
      } catch (err) {
        await logSystem(orgId, "ERROR", "engine", `Could not resume Smartlead campaign ${id}: ${(err as Error).message}`);
      }
    }
  }
  return { started: true, smartleadCampaignsResumed: resumed };
}
