import type { AutoReplyQueue } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { smartleadFor } from "../integrations/smartlead.js";
import { evaluateGates, escalateToHuman } from "../domain/autoReplyGate.js";
import { getSettings } from "../domain/settings.js";
import { recordMessage } from "../domain/messages.js";
import { htmlize, replySignature } from "../domain/sequence.js";
import { logSystem } from "../domain/systemLog.js";
import { VIA_AUTO } from "../domain/conversation.js";
import { forEachOrg, payingOrgs } from "./runner.js";

const MAX_ATTEMPTS = 6;
const MAX_AGE_MS = 48 * 3_600_000;

async function cancel(row: AutoReplyQueue, reason: string) {
  await prisma.autoReplyQueue.update({ where: { id: row.id }, data: { status: "CANCELLED", cancelReason: reason.slice(0, 64) } });
}

export async function dispatchOne(row: AutoReplyQueue): Promise<string> {
  const orgId = row.organizationId;
  if (Date.now() - row.createdAt.getTime() > MAX_AGE_MS) {
    await cancel(row, "stale");
    return "stale";
  }
  const trigger = row.triggerMessageId.replace(/^nudge:/, "");
  const trig = await prisma.message.findUnique({ where: { id: trigger }, select: { body: true } });
  const gate = await evaluateGates({ orgId, contactId: row.contactId, phase: "dispatch", nudge: row.triggerMessageId.startsWith("nudge:"), triggerMessageId: trigger, rawBody: trig?.body ?? "" });
  if (!gate.ok) {
    if (gate.reason?.startsWith("window-")) {
      await prisma.autoReplyQueue.update({ where: { id: row.id }, data: { status: "PENDING", claimedAt: null } });
      return "outside-window";
    }
    await cancel(row, gate.reason ?? "gate");
    if (gate.escalate) await escalateToHuman(orgId, row.contactId, gate.reason ?? "gate");
    return `cancelled:${gate.reason}`;
  }
  const contact = gate.contact!;
  const sl = await smartleadFor(orgId);
  if (!sl) {
    await cancel(row, "no-smartlead");
    return "no-smartlead";
  }
  const settings = await getSettings(orgId);
  try {
    const history = await sl.messageHistory(contact.smartleadCampaignId!, contact.smartleadLeadId!);
    const out = [...history].reverse().find((m) => /sent|out/i.test(String(m.direction ?? m.type ?? "")));
    const inbound = [...history].reverse().find((m) => /receiv|reply|in/i.test(String(m.direction ?? m.type ?? "")));
    const statsId = out?.email_stats_id ?? out?.stats_id;
    if (!statsId) throw new Error("no sent message to reply against");
    const signed = `${row.draft}\n\n${replySignature(settings)}`;
    await sl.replyToThread(contact.smartleadCampaignId!, {
      emailStatsId: statsId,
      emailBody: htmlize(signed),
      replyMessageId: inbound?.message_id ?? null,
      replyEmailTime: inbound?.time ?? null,
      replyEmailBody: inbound?.email_body ?? inbound?.body ?? null,
      toEmail: contact.email,
      toFirstName: contact.firstName,
      toLastName: contact.lastName,
      addSignature: false,
    });
  } catch (err) {
    const attempts = row.attempts + 1;
    await prisma.autoReplyQueue.update({
      where: { id: row.id },
      data: { attempts, lastError: (err as Error).message.slice(0, 250), status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING", claimedAt: null, sendAfter: new Date(Date.now() + 5 * 60_000 * attempts) },
    });
    if (attempts >= MAX_ATTEMPTS) {
      await escalateToHuman(orgId, contact.id, "send-failed");
      await logSystem(orgId, "ERROR", "auto-reply", `An automatic reply to ${contact.email} failed ${attempts} times and was handed to you`);
    }
    return "error";
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await recordMessage(tx, { organizationId: orgId, contactId: contact.id, campaignId: contact.campaignId, direction: "OUTBOUND", via: VIA_AUTO, subject: "Reply", body: row.draft, createdAt: now });
    await tx.autoReplyQueue.update({ where: { id: row.id }, data: { status: "SENT", sentAt: now } });
    await tx.contact.update({
      where: { id: contact.id },
      data: { autoReplyCount: { increment: 1 }, lastAutoReplyAt: now, replyUrgent: false, aiDraft: null, aiDraftAt: null, ...(row.includeLink && !contact.linkSentAt ? { linkSentAt: now } : {}) },
    });
  });
  return "sent";
}

export async function dispatchForOrg(orgId: string) {
  await prisma.autoReplyQueue.updateMany({ where: { organizationId: orgId, status: "SENDING", claimedAt: { lt: new Date(Date.now() - 10 * 60_000) } }, data: { status: "PENDING", claimedAt: null } });
  const due = await prisma.autoReplyQueue.findMany({ where: { organizationId: orgId, status: "PENDING", sendAfter: { lte: new Date() } }, orderBy: { sendAfter: "asc" }, take: 5 });
  const results: string[] = [];
  for (const row of due) {
    const claimed = await prisma.autoReplyQueue.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "SENDING", claimedAt: new Date() } });
    if (!claimed.count) continue;
    results.push(await dispatchOne(row));
  }
  return results;
}

export function runAutoReplyDispatchJob() {
  return forEachOrg("auto-reply-dispatch", { ...payingOrgs, autoReplyQueue: { some: { status: "PENDING", sendAfter: { lte: new Date() } } } }, dispatchForOrg);
}
