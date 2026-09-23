import type { Contact, OrgSettings } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { hourInTz, dayOfWeekInTz } from "../lib/time.js";
import { hasHumanReply, countAutoReplies, VIA_AUTO } from "./conversation.js";
import { isThin, prospectOwnWords, screenHardStop, wantsHumanScheduling } from "./replyText.js";

export const SAFE_AUTO_CLASSES = new Set(["hot", "question", "curious", "review", "referral"]);
export const SOFT_ACK_CLASSES = new Set(["not_now", "away"]);
export const NEVER_AUTO_CLASSES = new Set(["stop", "frustrated", "not_interested", "auto", "moved", "deceased"]);
const HARD_BLOCK_REASONS = ["UNSUBSCRIBED", "BOUNCED", "COMPLAINED", "MANUAL", "REMOVED", "DEAL_CLOSED", "CUSTOMER", "COMPETITOR"] as const;
const DEAD_STATUSES = ["UNSUBSCRIBED", "BOUNCED", "BLOCKLISTED"];

export interface ClassificationForGate {
  class: string;
  confidence?: number;
  draft?: string | null;
  needsHuman?: boolean;
  sentiment?: string;
  hasAttachment?: boolean;
}

export type GatePhase = "enqueue" | "dispatch";

export interface GateDecision {
  ok: boolean;
  reason: string | null;
  escalate: boolean;
  settings?: OrgSettings;
  contact?: Contact;
  turnCount?: number;
}

const deny = (reason: string, extra: Partial<GateDecision> = {}): GateDecision => ({ ok: false, reason, escalate: false, ...extra });

export function inSendWindow(settings: Pick<OrgSettings, "timezone" | "autoReplyWindowStart" | "autoReplyWindowEnd">, at = new Date()): { ok: boolean; why?: string } {
  const dow = dayOfWeekInTz(settings.timezone, at);
  if (dow === 0 || dow === 6) return { ok: false, why: "weekend" };
  const h = hourInTz(settings.timezone, at);
  if (h < settings.autoReplyWindowStart) return { ok: false, why: "early" };
  if (h >= settings.autoReplyWindowEnd) return { ok: false, why: "late" };
  return { ok: true };
}

export async function evaluateGates(args: {
  orgId: string;
  contactId: string;
  result?: ClassificationForGate | null;
  rawBody?: string;
  phase?: GatePhase;
  nudge?: boolean;
  triggerMessageId?: string | null;
}): Promise<GateDecision> {
  const { orgId, contactId, result = null, rawBody = "", phase = "enqueue", nudge = false, triggerMessageId = null } = args;
  if (env.AUTO_REPLY_KILL === "1") return deny("kill-switch-env");
  const settings = await prisma.orgSettings.findUnique({ where: { organizationId: orgId } });
  if (!settings) return deny("no-settings");
  if (settings.autoReplyKillSwitch) return deny("kill-switch", { settings });
  if (settings.autoReplyMode === "OFF") return deny("mode-off", { settings });
  if (!settings.autoReplyEnabled) return deny("auto-reply-disabled", { settings });

  const contact = await prisma.contact.findFirst({ where: { id: contactId, organizationId: orgId } });
  if (!contact) return deny("contact-gone", { settings });
  if (contact.neverAuto) return deny("never-auto", { settings, contact });
  if (contact.autoReplyStatus !== "AUTO") return deny(`status-${contact.autoReplyStatus.toLowerCase()}`, { settings, contact });
  if (DEAD_STATUSES.includes(contact.status)) return deny(`suppressed-${contact.status.toLowerCase()}`, { settings, contact });

  const hardBlock = await prisma.blocklistEntry.findFirst({
    where: {
      organizationId: orgId,
      reason: { in: [...HARD_BLOCK_REASONS] },
      OR: [
        { entryType: "EMAIL", value: contact.emailNormalized },
        ...(contact.companyDomain ? [{ entryType: "DOMAIN" as const, value: contact.companyDomain }] : []),
      ],
    },
    select: { reason: true },
  });
  if (hardBlock) return deny(`blocklisted-${hardBlock.reason.toLowerCase()}`, { settings, contact });
  if (contact.meetingBookedAt) return deny("meeting-booked", { settings, contact });
  if (!contact.smartleadCampaignId || !contact.smartleadLeadId) return deny("no-smartlead-thread", { settings, contact });
  if (contact.handoffAt) return deny("handed-off", { settings, contact });
  if (await hasHumanReply(orgId, contactId)) return deny("human-replied", { settings, contact, escalate: true });

  const turnCount = contact.messageCount;
  if (turnCount + 1 > settings.autoReplyMaxTurns) return deny("turn-cap", { settings, contact, turnCount, escalate: true });
  if ((await countAutoReplies(orgId, contactId)) >= settings.autoReplyMaxAutoSends) return deny("auto-send-cap", { settings, contact, turnCount, escalate: true });

  if (phase === "dispatch" && triggerMessageId) {
    const newest = await prisma.message.findFirst({ where: { organizationId: orgId, contactId }, orderBy: { createdAt: "desc" }, select: { id: true, direction: true } });
    if (newest && newest.id !== triggerMessageId) {
      return deny(newest.direction === "OUTBOUND" ? "answered-since" : "superseded", { settings, contact, turnCount });
    }
  }

  const now = Date.now();
  const lastAuto = await prisma.message.findFirst({
    where: { organizationId: orgId, contactId, direction: "OUTBOUND", via: VIA_AUTO },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (lastAuto) {
    const since = now - lastAuto.createdAt.getTime();
    if (since < settings.autoReplyThreadGapMinutes * 60_000) return deny(`thread-gap:${Math.round(since / 60_000)}m`, { settings, contact, turnCount });
    if (since < 24 * 3_600_000) return deny("thread-24h-cap", { settings, contact, turnCount });
  }
  const burst = await prisma.message.count({ where: { organizationId: orgId, contactId, direction: "INBOUND", createdAt: { gt: new Date(now - 3_600_000) } } });
  if (burst >= 3) return deny("inbound-burst", { settings, contact, turnCount, escalate: true });

  const sentToday = await prisma.message.count({ where: { organizationId: orgId, direction: "OUTBOUND", via: VIA_AUTO, createdAt: { gt: new Date(now - 86_400_000) } } });
  if (sentToday >= settings.autoReplyDailyCap) return deny("daily-cap", { settings, contact, turnCount });

  if (settings.autoReplyMode === "CANARY" && !(contact.campaignId && settings.autoReplyCanaryCampaigns.includes(contact.campaignId))) {
    return deny("not-in-canary", { settings, contact, turnCount });
  }
  if (phase === "dispatch") {
    const w = inSendWindow(settings);
    if (!w.ok) return deny(`window-${w.why}`, { settings, contact, turnCount });
  }

  if (result) {
    const cls = result.class;
    const isSoft = SOFT_ACK_CLASSES.has(cls);
    if (NEVER_AUTO_CLASSES.has(cls)) return deny(`never-auto-class:${cls}`, { settings, contact, turnCount });
    if (!SAFE_AUTO_CLASSES.has(cls) && !isSoft) return deny(`unsafe-class:${cls}`, { settings, contact, turnCount });
    if (isSoft && !settings.autoReplySoftAck && !nudge) return deny(`soft-ack-disabled:${cls}`, { settings, contact, turnCount });
    if (!isSoft && !result.draft) return deny("no-draft", { settings, contact, turnCount, escalate: true });
    if (result.hasAttachment) return deny("attachment", { settings, contact, turnCount, escalate: !isSoft });

    const own = prospectOwnWords(rawBody);
    const hs = screenHardStop(own);
    if (hs.hit) return deny(`hard-stop:${hs.marker}`, { settings, contact, turnCount, escalate: true });
    if (!nudge) {
      if (wantsHumanScheduling(own)) return deny("wants-scheduling", { settings, contact, turnCount, escalate: !isSoft });
      if (!isSoft && isThin(own)) return deny("thin-content", { settings, contact, turnCount, escalate: true });
      const conf = Number(result.confidence ?? 0);
      if (!isSoft && conf < settings.autoReplyMinConfidence) return deny(`low-confidence:${conf.toFixed(2)}`, { settings, contact, turnCount, escalate: true });
      if (result.needsHuman) return deny("needs-human", { settings, contact, turnCount, escalate: true });
      if (result.sentiment === "negative") return deny("negative-sentiment", { settings, contact, turnCount, escalate: true });
    }
  }
  return { ok: true, reason: null, escalate: false, settings, contact, turnCount };
}

export async function escalateToHuman(orgId: string, contactId: string, reason: string): Promise<void> {
  const c = await prisma.contact.findFirst({ where: { id: contactId, organizationId: orgId }, select: { handoffAt: true } });
  if (!c) return;
  await prisma.contact.update({
    where: { id: contactId },
    data: { autoReplyStatus: "MANUAL", replyUrgent: true, lastEscalationReason: reason.slice(0, 64), handoffAt: c.handoffAt ?? new Date() },
  });
}

export function computeSendAfter(settings: OrgSettings, turnCount: number): Date {
  const firstTurn = turnCount <= 2;
  const minMs = (firstTurn ? 4 : 10) * 60_000;
  const maxMs = (firstTurn ? 12 : 40) * 60_000;
  let at = new Date(Date.now() + Math.max(90_000, minMs + Math.random() * (maxMs - minMs)));
  for (let i = 0; i < 24 * 14 * 2 && !inSendWindow(settings, at).ok; i++) at = new Date(at.getTime() + 30 * 60_000);
  return new Date(at.getTime() + Math.floor(Math.random() * 15 * 60_000));
}
