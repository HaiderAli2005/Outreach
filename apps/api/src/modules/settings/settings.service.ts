import type { AutoReplyMode, IntegrationProvider, OrgSettings, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { badRequest, unprocessable, notConfigured } from "../../lib/errors.js";
import { isValidTimeZone } from "../../lib/time.js";
import { features } from "../../config/env.js";
import { getSettings } from "../../domain/settings.js";
import { logSystem } from "../../domain/systemLog.js";
import { dailyVolumeLimit, subscriptionOf } from "../../domain/entitlements.js";
import { creditPacing, maxDailyLeads, CREDITS_PER_LEAD, WORKING_DAYS_PER_MONTH } from "../../domain/usage.js";
import { credentialStatuses, deleteCredential, setCredential, getCredential } from "../../integrations/credentials.js";
import { verifierFor } from "../../integrations/verifier.js";
import { postToSlack } from "../../integrations/slack.js";

export type SettingsPatch = Partial<
  Pick<
    OrgSettings,
    | "autopilotEnabled" | "weeklyBatchMode" | "autoApproveBatches" | "defaultDailySendCap" | "perMailboxDailyCap" | "blocklistNoReplyDays"
    | "timezone" | "sendingWindowStart" | "sendingWindowEnd" | "language" | "personalizationEnabled" | "requireVerifiedEmail"
    | "monthlyCreditCap" | "dailyCreditCap" | "dailySourceTarget" | "apolloCycleResetDay" | "perCompanyContactCap" | "senderName"
    | "senderCompany" | "senderTitle" | "senderAddress" | "meetingLink" | "valueProp" | "optOutLine" | "browserNotifications"
    | "autoReplyEnabled" | "autoReplyMode" | "autoReplyKillSwitch" | "autoReplyMinConfidence" | "autoReplyMaxTurns" | "autoReplyMaxAutoSends"
    | "autoReplyDailyCap" | "autoReplyThreadGapMinutes" | "autoReplyWindowStart" | "autoReplyWindowEnd" | "autoReplyCanaryCampaigns" | "autoReplySoftAck"
  >
>;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const BOOKING_LINK = /^https:\/\/[^\s]+$/i;

export async function view(orgId: string) {
  const [settings, credentials, sub] = await Promise.all([getSettings(orgId), credentialStatuses(orgId), subscriptionOf(orgId)]);
  return {
    settings,
    credentials,
    limits: {
      planDailyVolume: dailyVolumeLimit(sub),
      maxDailyLeads: maxDailyLeads(settings.monthlyCreditCap, settings.expectedBounceRate),
      creditsPerLead: CREDITS_PER_LEAD,
      workingDaysPerMonth: WORKING_DAYS_PER_MONTH,
    },
    aiAvailable: features.ai,
  };
}

export async function update(orgId: string, patch: SettingsPatch) {
  const current = await getSettings(orgId);
  const data: Prisma.OrgSettingsUpdateInput = { ...patch };

  if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) throw badRequest("Unknown time zone");
  for (const key of ["sendingWindowStart", "sendingWindowEnd"] as const) {
    if (patch[key] !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch[key]))) throw badRequest("Use HH:MM for the sending window");
  }
  if (patch.meetingLink !== undefined && patch.meetingLink && !BOOKING_LINK.test(patch.meetingLink)) throw badRequest("The booking link must start with https://");

  if (patch.autoReplyMinConfidence !== undefined) data.autoReplyMinConfidence = clamp(patch.autoReplyMinConfidence, 0.5, 1);
  if (patch.autoReplyMaxTurns !== undefined) data.autoReplyMaxTurns = clamp(patch.autoReplyMaxTurns, 2, 30);
  if (patch.autoReplyMaxAutoSends !== undefined) data.autoReplyMaxAutoSends = clamp(patch.autoReplyMaxAutoSends, 1, 10);
  if (patch.autoReplyDailyCap !== undefined) data.autoReplyDailyCap = clamp(patch.autoReplyDailyCap, 1, 500);
  if (patch.autoReplyThreadGapMinutes !== undefined) data.autoReplyThreadGapMinutes = clamp(patch.autoReplyThreadGapMinutes, 15, 1440);
  if (patch.autoReplyWindowStart !== undefined) data.autoReplyWindowStart = clamp(patch.autoReplyWindowStart, 6, 12);
  if (patch.autoReplyWindowEnd !== undefined) data.autoReplyWindowEnd = clamp(patch.autoReplyWindowEnd, 13, 22);
  if (patch.perMailboxDailyCap !== undefined) data.perMailboxDailyCap = clamp(patch.perMailboxDailyCap, 1, 60);
  if (patch.blocklistNoReplyDays !== undefined) data.blocklistNoReplyDays = clamp(patch.blocklistNoReplyDays, 3, 60);
  if (patch.apolloCycleResetDay !== undefined) data.apolloCycleResetDay = clamp(patch.apolloCycleResetDay, 1, 28);
  if (patch.perCompanyContactCap !== undefined) data.perCompanyContactCap = clamp(patch.perCompanyContactCap, 1, 10);

  if (patch.defaultDailySendCap !== undefined) {
    const limit = dailyVolumeLimit(await subscriptionOf(orgId));
    data.defaultDailySendCap = clamp(patch.defaultDailySendCap, 1, limit || 1);
  }

  if (patch.autoReplyMode === undefined && patch.autoReplyEnabled !== undefined) {
    if (!patch.autoReplyEnabled) data.autoReplyMode = "OFF";
    else if (current.autoReplyMode === "OFF") data.autoReplyMode = "LIVE";
  }
  const nextMode = (data.autoReplyMode as AutoReplyMode | undefined) ?? current.autoReplyMode;
  const nextEnabled = patch.autoReplyEnabled ?? current.autoReplyEnabled;
  const raising = (data.autoReplyMode === "LIVE" || data.autoReplyMode === "CANARY") && data.autoReplyMode !== current.autoReplyMode;
  if (raising || (patch.autoReplyEnabled === true && !current.autoReplyEnabled)) {
    if (["LIVE", "CANARY"].includes(nextMode)) {
      const link = patch.meetingLink ?? current.meetingLink;
      if (!link || !BOOKING_LINK.test(link)) throw unprocessable("Set a booking link before turning on automatic replies; the agent invites people to book with it.");
      if (!nextEnabled) throw unprocessable("Turn the auto-reply switch on before choosing canary or live.");
      if (nextMode === "CANARY" && !(patch.autoReplyCanaryCampaigns ?? current.autoReplyCanaryCampaigns).length) {
        throw unprocessable("Canary needs at least one campaign to limit the test to.");
      }
      if (!features.ai) throw notConfigured("AI (needed for automatic replies)");
    }
  }
  if (patch.autopilotEnabled === true && !current.autopilotEnabled) {
    const sub = await subscriptionOf(orgId);
    if (!dailyVolumeLimit(sub)) throw unprocessable("An active subscription is needed to switch the autopilot on");
  }

  const updated = await prisma.orgSettings.update({ where: { organizationId: orgId }, data });

  const lowering = (patch.autoReplyEnabled === false && current.autoReplyEnabled) || (["OFF", "SHADOW"].includes(updated.autoReplyMode) && !["OFF", "SHADOW"].includes(current.autoReplyMode));
  let voided = 0;
  if (lowering) {
    voided = (await prisma.autoReplyQueue.updateMany({ where: { organizationId: orgId, status: "PENDING" }, data: { status: "CANCELLED", cancelReason: "switched-off" } })).count;
    if (voided) await logSystem(orgId, "WARN", "auto-reply", `Autonomy lowered from Settings: ${voided} queued repl${voided === 1 ? "y" : "ies"} cancelled`);
  }
  const cap = maxDailyLeads(updated.monthlyCreditCap, updated.expectedBounceRate);
  if (updated.dailySourceTarget > cap) await prisma.orgSettings.update({ where: { organizationId: orgId }, data: { dailySourceTarget: cap } });
  return { ...(await view(orgId)), voidedAutoReplies: voided };
}

export async function saveCredential(orgId: string, provider: IntegrationProvider, value: string) {
  if (provider === "SLACK_WEBHOOK" && !/^https:\/\/hooks\.slack\.com\/services\//.test(value)) throw badRequest("That isn't a Slack incoming webhook URL");
  if (value.length < 8) throw badRequest("That key looks too short");
  await setCredential(orgId, provider, value);
  return credentialStatuses(orgId);
}

export async function removeCredential(orgId: string, provider: IntegrationProvider) {
  await deleteCredential(orgId, provider);
  return credentialStatuses(orgId);
}

export async function killAutoReply(orgId: string) {
  await prisma.orgSettings.update({ where: { organizationId: orgId }, data: { autoReplyKillSwitch: true, autoReplyMode: "OFF" } });
  const cancelled = (await prisma.autoReplyQueue.updateMany({ where: { organizationId: orgId, status: "PENDING" }, data: { status: "CANCELLED", cancelReason: "kill-switch" } })).count;
  await logSystem(orgId, "WARN", "auto-reply", "Automatic replies were switched off with the kill switch", { cancelled });
  void postToSlack(orgId, `:octagonal_sign: Automatic replies switched OFF. ${cancelled} queued repl${cancelled === 1 ? "y" : "ies"} cancelled.`);
  return { killed: true, cancelled };
}

export async function releaseKillSwitch(orgId: string) {
  await prisma.orgSettings.update({ where: { organizationId: orgId }, data: { autoReplyKillSwitch: false } });
  return { released: true };
}

export async function autoReplyMetrics(orgId: string) {
  const s = await getSettings(orgId);
  const day = new Date(Date.now() - 86_400_000);
  const week = new Date(Date.now() - 7 * 86_400_000);
  const [sent24, sent7d, queued, failed7d, handedOff7d, booked7d, wouldSend, skips, escalations, negative] = await Promise.all([
    prisma.message.count({ where: { organizationId: orgId, direction: "OUTBOUND", via: "auto-reply", createdAt: { gt: day } } }),
    prisma.message.count({ where: { organizationId: orgId, direction: "OUTBOUND", via: "auto-reply", createdAt: { gt: week } } }),
    prisma.autoReplyQueue.count({ where: { organizationId: orgId, status: "PENDING" } }),
    prisma.autoReplyQueue.count({ where: { organizationId: orgId, status: "FAILED", createdAt: { gt: week } } }),
    prisma.contact.count({ where: { organizationId: orgId, autoReplyStatus: "MANUAL", handoffAt: { gt: week } } }),
    prisma.contact.count({ where: { organizationId: orgId, meetingBookedAt: { gt: week } } }),
    prisma.autoReplyDecision.groupBy({ by: ["replyClass"], where: { organizationId: orgId, wouldSend: true, createdAt: { gt: week } }, _count: { _all: true } }),
    prisma.autoReplyDecision.groupBy({ by: ["skipReason"], where: { organizationId: orgId, wouldSend: false, createdAt: { gt: week } }, _count: { _all: true }, orderBy: { _count: { skipReason: "desc" } }, take: 25 }),
    prisma.contact.groupBy({ by: ["lastEscalationReason"], where: { organizationId: orgId, lastEscalationReason: { not: null }, handoffAt: { gt: week } }, _count: { _all: true } }),
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM "Message" m
      WHERE m."organizationId" = ${orgId} AND m.direction = 'INBOUND' AND m.intent IN ('stop','frustrated','not_interested') AND m."createdAt" > ${week}
        AND EXISTS (SELECT 1 FROM "Message" p WHERE p."contactId" = m."contactId" AND p.direction = 'OUTBOUND' AND p.via = 'auto-reply'
                    AND p."createdAt" < m."createdAt" AND p."createdAt" > m."createdAt" - interval '3 days')`,
  ]);
  return {
    mode: s.autoReplyMode,
    enabled: s.autoReplyEnabled,
    killSwitch: s.autoReplyKillSwitch,
    sent: { last24h: sent24, last7d: sent7d },
    queued,
    failed7d,
    handedOff7d,
    meetingsBooked7d: booked7d,
    negativeAfterAutoReply7d: Number(negative[0]?.n ?? 0),
    wouldSendByClass: wouldSend.map((r) => ({ key: r.replyClass, count: r._count._all })),
    skipReasons: skips.map((r) => ({ key: r.skipReason, count: r._count._all })),
    escalationReasons: escalations.map((r) => ({ key: r.lastEscalationReason, count: r._count._all })),
  };
}

export async function verifyEmail(orgId: string, email: string) {
  const verify = await verifierFor(orgId);
  if (!verify) throw notConfigured("MillionVerifier");
  return verify(email);
}

export async function autopilotStatus(orgId: string) {
  const s = await getSettings(orgId);
  const [sub, pacing, apollo, smartlead, verifier, campaigns, csvQueued] = await Promise.all([
    subscriptionOf(orgId),
    creditPacing(orgId, s),
    getCredential(orgId, "APOLLO"),
    getCredential(orgId, "SMARTLEAD"),
    getCredential(orgId, "MILLIONVERIFIER"),
    prisma.campaign.count({ where: { organizationId: orgId, status: "ACTIVE" } }),
    prisma.contact.count({ where: { organizationId: orgId, source: "csv", status: { in: ["NEW", "PERSONALIZED", "QUEUED"] } } }),
  ]);
  const mailboxes = s.smartleadMailboxIds.length;
  const ceiling = mailboxes ? mailboxes * s.perMailboxDailyCap : null;
  const readiness = [
    { key: "subscription", label: "Active subscription", ok: dailyVolumeLimit(sub) > 0 },
    { key: "ai", label: "AI writing", ok: features.ai },
    { key: "apollo", label: "Lead sourcing (Apollo)", ok: !!apollo },
    { key: "smartlead", label: "Sending (Smartlead)", ok: !!smartlead },
    { key: "mailboxes", label: "Mailboxes connected", ok: mailboxes > 0 },
    { key: "verifier", label: "Email verification", ok: !!verifier, optional: true },
    { key: "campaign", label: "A running campaign", ok: campaigns > 0 },
    { key: "meeting", label: "Booking link", ok: !!s.meetingLink, optional: true },
  ];
  return {
    on: s.autopilotEnabled,
    readiness,
    ready: readiness.filter((r) => !r.optional).every((r) => r.ok),
    sending: { mailboxes, perMailbox: s.perMailboxDailyCap, ceiling, dailyTarget: s.defaultDailySendCap, csvQueued },
    sourcing: { dailyTarget: s.dailySourceTarget, pacing },
  };
}
