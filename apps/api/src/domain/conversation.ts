import { prisma, type Db } from "../lib/prisma.js";

export const VIA_AUTO = "auto-reply";
export const VIA_INBOX = "inbox";
export const VIA_SMARTLEAD_MANUAL = "smartlead-manual";
export const HUMAN_VIA = [VIA_INBOX, VIA_SMARTLEAD_MANUAL];

export async function markHandoff(orgId: string, contactId: string, reason: string, db: Db = prisma): Promise<void> {
  await db.contact.updateMany({
    where: { id: contactId, organizationId: orgId },
    data: { autoReplyStatus: "MANUAL", handoffAt: new Date(), lastEscalationReason: reason.slice(0, 64) },
  });
}

export async function markNeverAuto(orgId: string, contactId: string, reason: string, db: Db = prisma): Promise<void> {
  await db.contact.updateMany({
    where: { id: contactId, organizationId: orgId },
    data: { neverAuto: true, autoReplyStatus: "MANUAL", lastEscalationReason: reason.slice(0, 64) },
  });
}

export async function cancelQueuedReplies(orgId: string, contactId: string, reason: string, db: Db = prisma): Promise<number> {
  const r = await db.autoReplyQueue.updateMany({
    where: { organizationId: orgId, contactId, status: "PENDING" },
    data: { status: "CANCELLED", cancelReason: reason.slice(0, 64) },
  });
  return r.count;
}

export async function hasHumanReply(orgId: string, contactId: string): Promise<boolean> {
  const n = await prisma.message.count({ where: { organizationId: orgId, contactId, direction: "OUTBOUND", via: { in: HUMAN_VIA } } });
  return n > 0;
}

export async function countAutoReplies(orgId: string, contactId: string): Promise<number> {
  return prisma.message.count({ where: { organizationId: orgId, contactId, direction: "OUTBOUND", via: VIA_AUTO } });
}
