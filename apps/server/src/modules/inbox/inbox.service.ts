import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { conflict, notFound, unprocessable, upstream } from "../../lib/errors.js";
import { smartleadFor } from "../../integrations/smartlead.js";
import { getSettings } from "../../domain/settings.js";
import { activeOnly, leadClassOrUnread, LEAD_CLASSES } from "../../domain/needsReply.js";
import { blockEmail, isOptedOut } from "../../domain/suppression.js";
import { cancelQueuedReplies, markHandoff, markNeverAuto, VIA_INBOX } from "../../domain/conversation.js";
import { recordMessage } from "../../domain/messages.js";
import { ctaLine, htmlize, replySignature, signatureFor } from "../../domain/sequence.js";
import { cleanInboundReply } from "../../domain/replyText.js";

export const INBOX_FILTERS = ["all", "needs", "replied", "sent"] as const;
export const REPLY_FILTERS = ["urgent", "lead", "hot", "question", "review", "curious", "not_now", "away", "moved", "auto"] as const;
const LINKABLE = new Set(["hot", "question", "curious", "review", "not_now"]);

function stateWhere(filter: string, explicitClass: boolean): Prisma.ContactWhereInput {
  switch (filter) {
    case "needs":
      return { AND: [{ lastMessageDirection: "INBOUND" }, ...(explicitClass ? [] : [leadClassOrUnread]), activeOnly] };
    case "replied":
      return { hasInbound: true, OR: [{ lastMessageDirection: { not: "INBOUND" } }, { handledAt: { not: null } }] };
    case "sent":
      return { OR: [{ lastMessageDirection: { not: "INBOUND" } }, { lastMessageDirection: null }] };
    default:
      return {};
  }
}

function replyWhere(reply: string | undefined): Prisma.ContactWhereInput {
  if (!reply) return {};
  if (reply === "urgent") return { replyUrgent: true };
  if (reply === "lead") return { replyClass: { in: LEAD_CLASSES } };
  return { replyClass: reply };
}

export async function list(orgId: string, q: { filter: string; reply?: string; page: number; limit: number }) {
  const base: Prisma.ContactWhereInput = {
    organizationId: orgId,
    messageCount: { gt: 0 },
    OR: [{ status: { notIn: ["BLOCKLISTED", "BOUNCED", "UNSUBSCRIBED", "NO_RESPONSE"] } }, { hasInbound: true }],
  };
  const explicitClass = !!q.reply && !["urgent", "lead"].includes(q.reply);
  const rw = replyWhere(q.reply);
  const where: Prisma.ContactWhereInput = { AND: [base, stateWhere(q.filter, explicitClass), rw] };
  const countState = stateWhere(q.filter, false);

  const [rows, total, all, needs, replied, sent, urgent, byClassRows] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: [{ lastMessageDirection: { sort: "asc", nulls: "last" } }, { replyUrgent: "desc" }, { lastMessageAt: { sort: "desc", nulls: "last" } }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      select: {
        id: true, fullName: true, email: true, company: true, title: true, photoUrl: true, status: true, tier: true, fitScore: true,
        replyClass: true, replyUrgent: true, followUpAt: true, aiDraft: true, repliedAt: true, lastMessageAt: true,
        lastMessageDirection: true, lastMessagePreview: true, messageCount: true, hasInbound: true, handledAt: true,
      },
    }),
    prisma.contact.count({ where }),
    prisma.contact.count({ where: { AND: [base, rw] } }),
    prisma.contact.count({ where: { AND: [base, stateWhere("needs", explicitClass), rw] } }),
    prisma.contact.count({ where: { AND: [base, stateWhere("replied", false), rw] } }),
    prisma.contact.count({ where: { AND: [base, stateWhere("sent", false), rw] } }),
    prisma.contact.count({ where: { AND: [base, countState, { replyUrgent: true }] } }),
    prisma.contact.groupBy({ by: ["replyClass"], where: { AND: [base, countState, { replyClass: { not: null } }] }, _count: { _all: true } }),
  ]);
  const byClass: Record<string, number> = {};
  for (const r of byClassRows) if (r.replyClass) byClass[r.replyClass] = r._count._all;
  return {
    rows: rows.map(({ aiDraft, ...r }) => ({ ...r, hasDraft: !!aiDraft, needsReply: r.lastMessageDirection === "INBOUND" && !r.handledAt })),
    total,
    counts: { all, needs, replied, sent, urgent, byClass },
  };
}

async function loadContact(orgId: string, contactId: string) {
  const c = await prisma.contact.findFirst({ where: { id: contactId, organizationId: orgId } });
  if (!c) throw notFound("Conversation");
  return c;
}

export async function thread(orgId: string, contactId: string) {
  const contact = await loadContact(orgId, contactId);
  const [messages, settings, campaign, pending] = await Promise.all([
    prisma.message.findMany({ where: { organizationId: orgId, contactId }, orderBy: { createdAt: "asc" } }),
    getSettings(orgId),
    contact.campaignId ? prisma.campaign.findFirst({ where: { id: contact.campaignId, organizationId: orgId }, select: { id: true, name: true, language: true } }) : null,
    prisma.autoReplyQueue.findFirst({ where: { organizationId: orgId, contactId, status: "PENDING" }, orderBy: { createdAt: "desc" } }),
  ]);
  const view = messages.map((m) => {
    const meta = (m.meta ?? {}) as Record<string, unknown>;
    const attachments = Array.isArray(meta.attachments)
      ? (meta.attachments as Record<string, unknown>[])
          .filter((a) => a && (a.file_url || a.url))
          .map((a) => ({ url: String(a.file_url ?? a.url), name: String(a.file_name ?? a.name ?? "attachment") }))
      : [];
    return {
      id: m.id,
      direction: m.direction,
      via: m.via,
      subject: m.subject,
      body: m.direction === "INBOUND" ? cleanInboundReply(m.body) : m.body,
      intent: m.intent,
      createdAt: m.createdAt,
      attachments,
    };
  });
  const firstOut = messages.find((m) => m.direction === "OUTBOUND");
  const language = pending?.language ?? campaign?.language ?? settings.language;
  let draft = contact.aiDraft;
  let includeLink = false;
  if (draft) {
    includeLink = !!settings.meetingLink && (pending ? pending.includeLink : !contact.linkSentAt && LINKABLE.has(contact.replyClass ?? ""));
    if (includeLink && settings.meetingLink && !draft.includes(settings.meetingLink)) draft = `${draft}\n\n${ctaLine(language)}\n${settings.meetingLink}`;
  }
  return {
    contact: { ...contact, aiDraft: draft, raw: undefined },
    campaign,
    messages: view,
    email: {
      fromCompany: settings.senderCompany,
      fromName: settings.senderName,
      subject: firstOut?.subject ?? contact.messageSubject,
      signature: signatureFor(settings).replace("%sender-name%", settings.senderName ?? settings.senderCompany ?? ""),
      sentAt: firstOut?.createdAt ?? contact.firstContactedAt,
    },
    autoReply: pending
      ? {
          sendAfter: pending.sendAfter,
          includeLink: pending.includeLink,
          language: pending.language,
          mode: settings.autoReplyMode,
          willSend: settings.autoReplyEnabled && settings.autoReplyMode === "LIVE" && !settings.autoReplyKillSwitch,
        }
      : null,
  };
}

export async function reply(orgId: string, contactId: string, bodyRaw: string) {
  const body = bodyRaw.trim();
  const c = await loadContact(orgId, contactId);
  if (c.status === "UNSUBSCRIBED" || (await isOptedOut(orgId, c.emailNormalized, c.companyDomain ?? c.domain))) {
    throw conflict("This person opted out. Their thread stays visible for reference, but we do not email them again.");
  }
  if (!c.smartleadCampaignId || !c.smartleadLeadId) throw unprocessable("There is no sending thread for this lead yet.");
  const sl = await smartleadFor(orgId);
  if (!sl) throw unprocessable("Connect Smartlead in Settings → Integrations to reply from here");
  const settings = await getSettings(orgId);

  const history = await sl.messageHistory(c.smartleadCampaignId, c.smartleadLeadId).catch((e: Error) => {
    throw upstream("Smartlead", e.message);
  });
  const isOut = (m: { type?: string; direction?: string }) => /sent|out/i.test(String(m.direction ?? m.type ?? ""));
  const isIn = (m: { type?: string; direction?: string }) => /receiv|reply|in/i.test(String(m.direction ?? m.type ?? ""));
  const outbound = [...history].reverse().find(isOut);
  const inbound = [...history].reverse().find(isIn);
  const statsId = outbound?.email_stats_id ?? outbound?.stats_id;
  if (!statsId) throw unprocessable("No sent message in the thread to reply against.");

  await markHandoff(orgId, c.id, "inbox-reply");
  await cancelQueuedReplies(orgId, c.id, "human-replied");

  const signed = `${body}\n\n${replySignature(settings)}`;
  try {
    await sl.replyToThread(c.smartleadCampaignId, {
      emailStatsId: statsId,
      emailBody: htmlize(signed),
      replyMessageId: inbound?.message_id ?? inbound?.stats_id ?? null,
      replyEmailTime: inbound?.time ?? null,
      replyEmailBody: inbound?.email_body ?? inbound?.body ?? null,
      toEmail: c.email,
      toFirstName: c.firstName,
      toLastName: c.lastName,
      addSignature: false,
    });
  } catch (err) {
    throw upstream("Smartlead", (err as Error).message);
  }
  try {
    await prisma.$transaction(async (tx) => {
      await recordMessage(tx, { organizationId: orgId, contactId: c.id, campaignId: c.campaignId, direction: "OUTBOUND", via: VIA_INBOX, subject: "Reply", body });
      await tx.contact.update({
        where: { id: c.id },
        data: {
          aiDraft: null,
          aiDraftAt: null,
          replyUrgent: false,
          followUpAt: null,
          ...(settings.meetingLink && signed.includes(settings.meetingLink) && !c.linkSentAt ? { linkSentAt: new Date() } : {}),
        },
      });
    });
  } catch {
    // The email is delivered; bookkeeping failure must not be reported as a failed send.
  }
  return { sent: true };
}

export async function dealClosed(orgId: string, contactId: string) {
  const c = await loadContact(orgId, contactId);
  await blockEmail(orgId, c.emailNormalized, "DEAL_CLOSED", c.id);
  await prisma.contact.update({ where: { id: c.id }, data: { status: "BLOCKLISTED", aiDraft: null, aiDraftAt: null, replyUrgent: false, followUpAt: null } });
  await markNeverAuto(orgId, c.id, "deal-closed");
  await cancelQueuedReplies(orgId, c.id, "deal-closed");
  return { closed: true, name: c.fullName ?? c.email };
}

export async function handled(orgId: string, contactId: string) {
  const r = await prisma.contact.updateMany({ where: { id: contactId, organizationId: orgId }, data: { handledAt: new Date() } });
  if (!r.count) throw notFound("Conversation");
  return { handled: true };
}

export async function remove(orgId: string, contactId: string) {
  const c = await loadContact(orgId, contactId);
  await blockEmail(orgId, c.emailNormalized, "REMOVED", c.id, { emailOnly: true });
  await prisma.contact.update({
    where: { id: c.id },
    data: { status: "BLOCKLISTED", aiDraft: null, aiDraftAt: null, replyUrgent: false, followUpAt: null, handledAt: new Date() },
  });
  await markNeverAuto(orgId, c.id, "removed");
  await cancelQueuedReplies(orgId, c.id, "removed");
  return { removed: true, blocked: c.emailNormalized, name: c.fullName ?? c.email };
}
