import { prisma } from "../lib/prisma.js";
import { runReplyIntelligence, enqueueAutoReply, type Classification } from "../domain/replyIntelligence.js";
import { returnNudge } from "../domain/sequence.js";
import { getSettings } from "../domain/settings.js";
import { forEachOrg, payingOrgs } from "./runner.js";

export async function classifySweep(orgId: string, limit = 10): Promise<number> {
  const pending = await prisma.message.findMany({
    where: {
      organizationId: orgId,
      direction: "INBOUND",
      intent: null,
      classifyAttempts: { lt: 3 },
      createdAt: { gte: new Date(Date.now() - 14 * 86_400_000) },
      OR: [{ classifyStartedAt: null }, { classifyStartedAt: { lt: new Date(Date.now() - 3 * 60_000) } }],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, contactId: true, createdAt: true },
    take: 200,
  });
  const newestPerContact = new Map<string, string>();
  const superseded: string[] = [];
  for (const m of pending) {
    if (newestPerContact.has(m.contactId)) superseded.push(m.id);
    else newestPerContact.set(m.contactId, m.id);
  }
  if (superseded.length) await prisma.message.updateMany({ where: { id: { in: superseded } }, data: { intent: "superseded" } });
  let n = 0;
  for (const id of [...newestPerContact.values()].slice(0, limit)) {
    if (await runReplyIntelligence(orgId, id)) n++;
  }
  return n;
}

export async function followUpSweep(orgId: string): Promise<{ due: number; queued: number }> {
  const due = await prisma.contact.findMany({
    where: { organizationId: orgId, replyClass: { in: ["away", "not_now"] }, replyUrgent: false, followUpAt: { lte: new Date() }, status: "REPLIED" },
    select: { id: true, replyClass: true, campaignId: true },
  });
  if (!due.length) return { due: 0, queued: 0 };
  await prisma.contact.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { replyUrgent: true, followUpAt: null } });
  const settings = await getSettings(orgId);
  let queued = 0;
  for (const c of due) {
    const trigger = await prisma.message.findFirst({ where: { organizationId: orgId, contactId: c.id, direction: "INBOUND" }, orderBy: { createdAt: "desc" }, select: { id: true, body: true } });
    if (!trigger) continue;
    const campaign = c.campaignId ? await prisma.campaign.findUnique({ where: { id: c.campaignId }, select: { language: true } }) : null;
    const language = campaign?.language ?? settings.language;
    const result: Classification = {
      class: c.replyClass!,
      confidence: 1,
      draft: returnNudge(language),
      followUpAt: null,
      referral: null,
      newEmail: null,
      language,
      sentiment: "neutral",
      needsHuman: false,
      summary: null,
      hasAttachment: false,
    };
    const r = await enqueueAutoReply(orgId, c.id, trigger.id, result, trigger.body ?? "", { phase: "nudge", bodyOverride: returnNudge(language) });
    if (r.queued) queued++;
  }
  return { due: due.length, queued };
}

export function runReplySyncJob() {
  return forEachOrg("reply-sync", payingOrgs, async (orgId) => ({ classified: await classifySweep(orgId), followUps: await followUpSweep(orgId) }));
}
