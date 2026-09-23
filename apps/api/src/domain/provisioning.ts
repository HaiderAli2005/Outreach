import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { unprocessable, upstream } from "../lib/errors.js";
import { smartleadFor, smartleadSchedule } from "../integrations/smartlead.js";
import { getSettings } from "./settings.js";
import { buildSequence, signatureFor } from "./sequence.js";
import { logSystem } from "./systemLog.js";

export interface ProvisionResult {
  smartleadCampaignId: string;
  mailboxes: number;
  created: boolean;
}

export async function provisionCampaign(orgId: string, campaignId: string, mailboxIds: number[]): Promise<ProvisionResult> {
  if (!mailboxIds.length) throw unprocessable("Select at least one mailbox");
  const sl = await smartleadFor(orgId);
  if (!sl) throw unprocessable("Connect Smartlead in Settings → Integrations first");
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, organizationId: orgId } });
  if (!campaign) throw unprocessable("Campaign not found");
  const settings = await getSettings(orgId);
  try {
    let slId = campaign.smartleadCampaignId;
    const created = !slId;
    if (!slId) {
      slId = await sl.createCampaign(`${settings.senderCompany ?? "Aperture"}: ${campaign.name}`.slice(0, 120));
      await sl.saveSequence(slId, buildSequence(signatureFor(settings)));
    }
    await sl
      .setSchedule(slId, smartleadSchedule(settings.timezone, settings.sendingWindowStart, settings.sendingWindowEnd, settings.defaultDailySendCap))
      .catch((e: Error) => logSystem(orgId, "WARN", "smartlead", `Schedule not applied: ${e.message}`));
    await sl
      .setSettings(slId, { bounce_autopause_threshold: "2", auto_pause_domain_leads_on_reply: true, track_settings: ["DONT_TRACK_EMAIL_OPEN", "DONT_TRACK_LINK_CLICK"] })
      .catch((e: Error) => logSystem(orgId, "WARN", "smartlead", `Campaign settings not applied: ${e.message}`));
    await sl.attachMailboxes(slId, mailboxIds);
    await sl
      .registerWebhook(slId, `${env.PUBLIC_API_URL.replace(/\/$/, "")}/api/v1/webhooks/smartlead?token=${encodeURIComponent(env.WEBHOOK_SECRET)}`)
      .catch((e: Error) => logSystem(orgId, "WARN", "smartlead", `Webhook not registered: ${e.message}`));
    await sl.setStatus(slId, "START");
    await prisma.$transaction([
      prisma.campaign.update({ where: { id: campaign.id }, data: { smartleadCampaignId: slId } }),
      prisma.orgSettings.update({ where: { organizationId: orgId }, data: { smartleadDefaultCampaignId: settings.smartleadDefaultCampaignId ?? slId, smartleadMailboxIds: mailboxIds } }),
    ]);
    return { smartleadCampaignId: slId, mailboxes: mailboxIds.length, created };
  } catch (err) {
    if ((err as { status?: number }).status && (err as { status: number }).status < 500 && (err as { code?: string }).code) throw err;
    throw upstream("Smartlead", (err as Error).message);
  }
}
