import type { Contact, Prisma, WebhookProvider } from "@prisma/client";
import { prisma, isUniqueViolation } from "../../lib/prisma.js";
import { normalizeEmail } from "../../lib/normalize.js";
import { sha256 } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { blockEmail } from "../../domain/suppression.js";
import { cancelQueuedReplies, markHandoff, markNeverAuto } from "../../domain/conversation.js";
import { recordMessage } from "../../domain/messages.js";
import { recordInboundReply } from "../../domain/replyIngest.js";
import { runReplyIntelligence } from "../../domain/replyIntelligence.js";
import { logSystem } from "../../domain/systemLog.js";
import { postToSlack } from "../../integrations/slack.js";

type Body = Record<string, unknown>;
const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));

async function claim(provider: WebhookProvider, body: Body, type: string, orgId: string | null): Promise<string | null> {
  const externalId = sha256(JSON.stringify(body)).slice(0, 48);
  const existing = await prisma.webhookEvent.findUnique({ where: { provider_externalId: { provider, externalId } }, select: { id: true } });
  if (existing) return null;
  try {
    const row = await prisma.webhookEvent.create({ data: { provider, externalId, type: type.slice(0, 80), organizationId: orgId, payload: body as Prisma.InputJsonValue } });
    return row.id;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

async function finish(id: string, status: "PROCESSED" | "IGNORED" | "FAILED", error?: string) {
  await prisma.webhookEvent.update({ where: { id }, data: { status, processedAt: new Date(), error: error?.slice(0, 1000) ?? null } }).catch(() => undefined);
}

export async function orgForSmartleadCampaign(slCampaignId: string | null): Promise<string | null> {
  if (!slCampaignId) return null;
  const campaign = await prisma.campaign.findUnique({ where: { smartleadCampaignId: slCampaignId }, select: { organizationId: true } });
  if (campaign) return campaign.organizationId;
  const settings = await prisma.orgSettings.findFirst({ where: { smartleadDefaultCampaignId: slCampaignId }, select: { organizationId: true } });
  if (settings) return settings.organizationId;
  const contacts = await prisma.contact.findMany({ where: { smartleadCampaignId: slCampaignId }, distinct: ["organizationId"], select: { organizationId: true }, take: 2 });
  return contacts.length === 1 ? contacts[0].organizationId : null;
}

export async function orgForWebhookToken(token: string): Promise<string | null> {
  if (!token || token.length < 16) return null;
  const org = await prisma.organization.findUnique({ where: { webhookToken: token }, select: { id: true } });
  return org?.id ?? null;
}

export async function handleSmartlead(body: Body, tokenOrgId: string | null = null): Promise<{ status: string; messageId?: string }> {
  const event = String(body.event_type ?? body.event ?? body.type ?? "").toUpperCase();
  const leadEmail = str(body.sl_lead_email ?? body.lead_email ?? body.to_email ?? body.email);
  const { normalized } = normalizeEmail(leadEmail);
  const slLeadId = str(body.sl_email_lead_id ?? body.lead_id ?? body.sl_lead_id);
  const slCampaignId = str(body.campaign_id ?? body.sl_campaign_id);
  const resolved = await orgForSmartleadCampaign(slCampaignId);
  if (tokenOrgId && resolved && resolved !== tokenOrgId) return { status: "ignored" };
  const orgId = resolved ?? tokenOrgId;
  const eventId = await claim("SMARTLEAD", body, event || "UNKNOWN", orgId);
  if (!eventId) return { status: "duplicate" };
  if (!orgId) {
    await finish(eventId, "IGNORED", "no organization for campaign");
    return { status: "ignored" };
  }
  try {
    let contact: Contact | null = normalized.includes("@")
      ? await prisma.contact.findUnique({ where: { organizationId_emailNormalized: { organizationId: orgId, emailNormalized: normalized } } })
      : null;
    if (!contact && slLeadId) contact = await prisma.contact.findFirst({ where: { organizationId: orgId, smartleadLeadId: slLeadId } });
    if (contact && (slLeadId || slCampaignId)) {
      contact = await prisma.contact.update({
        where: { id: contact.id },
        data: { smartleadLeadId: slLeadId ?? contact.smartleadLeadId, smartleadCampaignId: slCampaignId ?? contact.smartleadCampaignId },
      });
    }

    if (event.includes("UNSUBSCRIB")) {
      if (normalized.includes("@")) await blockEmail(orgId, normalized, "UNSUBSCRIBED", contact?.id ?? null);
      if (contact) {
        await prisma.contact.update({ where: { id: contact.id }, data: { status: "UNSUBSCRIBED" } });
        await cancelQueuedReplies(orgId, contact.id, "unsubscribed");
        await markNeverAuto(orgId, contact.id, "unsubscribed");
      }
      await finish(eventId, "PROCESSED");
      return { status: "unsubscribed" };
    }
    if (event.includes("BOUNCE")) {
      if (normalized.includes("@")) await blockEmail(orgId, normalized, "BOUNCED", contact?.id ?? null);
      if (contact) {
        await prisma.contact.update({ where: { id: contact.id }, data: { status: "BOUNCED" } });
        await cancelQueuedReplies(orgId, contact.id, "bounced");
        await markNeverAuto(orgId, contact.id, "bounced");
      }
      await finish(eventId, "PROCESSED");
      return { status: "bounced" };
    }
    if (event.includes("SENT")) {
      if (!contact) {
        await finish(eventId, "IGNORED", "unknown contact");
        return { status: "ignored" };
      }
      if (event.includes("MANUAL_REPLY")) {
        const echo = await prisma.message.findFirst({
          where: { organizationId: orgId, contactId: contact.id, direction: "OUTBOUND", via: { in: ["auto-reply", "inbox"] }, createdAt: { gt: new Date(Date.now() - 15 * 60_000) } },
          select: { id: true },
        });
        if (echo) {
          await finish(eventId, "IGNORED", "echo of our own send");
          return { status: "echo" };
        }
        const replyMessage = (body.reply_message ?? {}) as Body;
        const manualBody = str(replyMessage.text ?? replyMessage.html ?? body.body ?? body.message);
        await prisma.contact.update({ where: { id: contact.id }, data: { replyUrgent: false, aiDraft: null, aiDraftAt: null, followUpAt: null, lastContactedAt: new Date() } });
        if (manualBody) {
          await recordMessage(prisma, { organizationId: orgId, contactId: contact.id, campaignId: contact.campaignId, direction: "OUTBOUND", via: "smartlead-manual", subject: str(body.subject) ?? "Reply", body: manualBody });
        }
        await markHandoff(orgId, contact.id, "owner-replied-externally");
        await cancelQueuedReplies(orgId, contact.id, "human-replied");
        await finish(eventId, "PROCESSED");
        return { status: "manual-reply" };
      }
      const keep = ["REPLIED", "UNSUBSCRIBED", "BOUNCED", "BLOCKLISTED"].includes(contact.status);
      await prisma.contact.update({
        where: { id: contact.id },
        data: { lastContactedAt: new Date(), firstContactedAt: contact.firstContactedAt ?? new Date(), ...(keep ? {} : { status: "CONTACTED" }) },
      });
      await finish(eventId, "PROCESSED");
      return { status: "sent" };
    }

    const replyMessage = (body.reply_message ?? {}) as Body;
    const replyBody = str(replyMessage.text ?? replyMessage.html ?? body.reply_body ?? body.preview_text ?? body.body ?? body.message) ?? "";
    const isReply = /REPL/.test(event) || (!event && !!replyBody);
    if (!isReply) {
      await finish(eventId, "IGNORED", `event ${event || "unknown"}`);
      return { status: "ignored" };
    }
    if (!contact) {
      await logSystem(orgId, "WARN", "webhook", `A reply arrived from ${leadEmail ?? "an unknown address"} who is not one of your leads`);
      await finish(eventId, "IGNORED", "reply from unknown contact");
      return { status: "ignored" };
    }
    const attachments = Array.isArray(replyMessage.attachments) ? replyMessage.attachments : Array.isArray(body.attachments) ? body.attachments : [];
    const { messageId, duplicate } = await recordInboundReply({
      orgId,
      contact,
      subject: str(body.subject ?? replyMessage.subject),
      body: replyBody,
      statsId: str(body.email_stats_id ?? body.stats_id),
      smartleadMessageId: str(replyMessage.message_id ?? body.message_id),
      meta: { attachments, campaign_name: str(body.campaign_name) } as Prisma.InputJsonValue,
    });
    await finish(eventId, "PROCESSED");
    if (!duplicate) {
      void runReplyIntelligence(orgId, messageId).catch((err: Error) => logger.error({ err: err.message, orgId }, "inline classification failed"));
    }
    return { status: duplicate ? "duplicate-reply" : "reply", messageId };
  } catch (err) {
    await finish(eventId, "FAILED", (err as Error).message);
    throw err;
  }
}

export async function handleCalendly(orgToken: string, body: Body): Promise<{ status: string }> {
  const org = await prisma.organization.findUnique({ where: { webhookToken: orgToken }, select: { id: true } });
  if (!org) return { status: "unknown-organization" };
  const event = String(body.event ?? body.event_type ?? "").toLowerCase();
  const eventId = await claim("CALENDLY", body, event || "unknown", org.id);
  if (!eventId) return { status: "duplicate" };
  const payload = ((body.payload ?? body.data ?? {}) as Body) ?? {};
  const invitee = (payload.invitee ?? {}) as Body;
  const { normalized } = normalizeEmail(str(payload.email ?? invitee.email ?? payload.invitee_email));
  if (!normalized.includes("@")) {
    await finish(eventId, "IGNORED", "no invitee email");
    return { status: "ignored" };
  }
  const contact = await prisma.contact.findUnique({ where: { organizationId_emailNormalized: { organizationId: org.id, emailNormalized: normalized } } });
  if (!contact) {
    await finish(eventId, "IGNORED", "not a lead");
    return { status: "ignored" };
  }
  if (event.includes("cancel")) {
    await prisma.contact.update({ where: { id: contact.id }, data: { meetingBookedAt: null, replyUrgent: true } });
    await markHandoff(org.id, contact.id, "meeting-cancelled");
    void postToSlack(org.id, `:warning: ${contact.email} cancelled their booked meeting. Flagged for you.`);
    await finish(eventId, "PROCESSED");
    return { status: "cancelled" };
  }
  await prisma.contact.update({ where: { id: contact.id }, data: { meetingBookedAt: new Date(), replyUrgent: false, aiDraft: null, aiDraftAt: null, followUpAt: null } });
  await markHandoff(org.id, contact.id, "meeting-booked");
  await cancelQueuedReplies(org.id, contact.id, "meeting-booked");
  await logSystem(org.id, "INFO", "meeting", `Meeting booked by ${contact.email}`, { contactId: contact.id });
  void postToSlack(org.id, `:tada: *Meeting booked* by ${contact.email}. Automatic replies are now off for this prospect.`);
  await finish(eventId, "PROCESSED");
  return { status: "booked" };
}

export async function handleApollo(orgToken: string, body: Body): Promise<{ status: string; updated: number }> {
  const org = await prisma.organization.findUnique({ where: { webhookToken: orgToken }, select: { id: true } });
  if (!org) return { status: "unknown-organization", updated: 0 };
  const people = (body.people ?? body.matches ?? body.contacts ?? (body.person ? [body.person] : body.email ? [body] : [])) as Body[];
  let updated = 0;
  for (const m of people) {
    const email = str(m?.email);
    if (!email) continue;
    const { normalized } = normalizeEmail(email);
    const apolloId = str(m.id);
    const r = await prisma.contact.updateMany({
      where: { organizationId: org.id, OR: [{ emailNormalized: normalized }, ...(apolloId ? [{ apolloId }] : [])], status: { in: ["NEW"] } },
      data: { emailStatus: str(m.email_status) ?? "verified" },
    });
    updated += r.count;
  }
  return { status: "ok", updated };
}
