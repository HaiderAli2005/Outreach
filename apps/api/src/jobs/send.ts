import type { Contact } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { dateKeyInTz, mondayOf, tzMidnightUtc, workdaysLeft, dayKeyOf } from "../lib/time.js";
import { isFreeMailDomain } from "../lib/normalize.js";
import { smartleadFor, type SmartleadLead } from "../integrations/smartlead.js";
import { verifierFor } from "../integrations/verifier.js";
import { getSettings } from "../domain/settings.js";
import { blockEmail } from "../domain/suppression.js";
import { personalizeContact } from "../domain/personalize.js";
import { activeSendBatch, closePastBatches } from "../domain/batches.js";
import { dailyVolumeLimit, subscriptionOf } from "../domain/entitlements.js";
import { htmlize } from "../domain/sequence.js";
import { SEND_FLOOR } from "../domain/scoring.js";
import { addUsage } from "../domain/usage.js";
import { logSystem } from "../domain/systemLog.js";
import { recordMessage } from "../domain/messages.js";
import { forEachOrg, autopilotOrgs } from "./runner.js";

const PERSONALIZE_BATCH = 25;
const VERIFY_RETRY_MS = 7 * 86_400_000;
const TIER_ORDER = (c: Pick<Contact, "tier">) => ({ A: 0, B: 1, C: 2 })[c.tier as "A" | "B" | "C"] ?? 3;

const batchApproved = {
  OR: [{ batchId: null }, { batch: { status: { in: ["APPROVED", "SENDING", "DONE"] as ("APPROVED" | "SENDING" | "DONE")[] } } }],
};

export async function verifyNew(orgId: string): Promise<{ good: number; dropped: number }> {
  const verify = await verifierFor(orgId);
  if (!verify) return { good: 0, dropped: 0 };
  const rows = await prisma.contact.findMany({
    where: {
      organizationId: orgId,
      status: "NEW",
      personalizationStatus: "pending",
      fitScore: { gte: SEND_FLOOR },
      ...batchApproved,
      OR: [{ verifyResult: null }, { verifyResult: { notIn: ["ok", "catch_all"] }, OR: [{ verifiedAt: null }, { verifiedAt: { lt: new Date(Date.now() - VERIFY_RETRY_MS) } }] }],
    },
    orderBy: [{ fitScore: "desc" }, { createdAt: "asc" }],
    take: 50,
  });
  let good = 0;
  let dropped = 0;
  for (const c of rows.sort((a, b) => TIER_ORDER(a) - TIER_ORDER(b))) {
    const hadPrior = !!c.verifyResult && c.verifyResult !== "error";
    const v = await verify(c.email);
    if (v.noCredits) {
      await logSystem(orgId, "ERROR", "verify", "Email verification is out of credits. Leads wait unverified until it is topped up.");
      break;
    }
    if (v.transient) continue;
    await addUsage(orgId, "emailsVerified");
    await prisma.contact.update({ where: { id: c.id }, data: { verifyResult: v.result, verifyQuality: v.quality, verifiedAt: new Date() } });
    if (v.bad || (!v.ok && hadPrior)) {
      await prisma.contact.update({ where: { id: c.id }, data: { status: "BOUNCED" } });
      await blockEmail(orgId, c.emailNormalized, "BOUNCED", c.id, { emailOnly: !v.bad });
      dropped++;
    } else if (v.ok) good++;
  }
  return { good, dropped };
}

export async function personalizeNew(orgId: string): Promise<number> {
  const settings = await getSettings(orgId);
  if (!settings.personalizationEnabled) return 0;
  const verifierConfigured = !!(await verifierFor(orgId));
  const rows = await prisma.contact.findMany({
    where: {
      organizationId: orgId,
      status: "NEW",
      personalizationStatus: { in: ["pending", "retry_1", "retry_2"] },
      fitScore: { gte: SEND_FLOOR },
      campaign: { status: "ACTIVE" },
      ...batchApproved,
      ...(verifierConfigured && settings.requireVerifiedEmail ? { verifyResult: { in: ["ok", "catch_all"] } } : {}),
    },
    include: { campaign: { select: { marketBrief: true, language: true } } },
    orderBy: [{ fitScore: "desc" }, { createdAt: "asc" }],
    take: PERSONALIZE_BATCH,
  });
  let done = 0;
  for (const c of rows) {
    const company = c.companyDomain ? await prisma.company.findUnique({ where: { organizationId_domain: { organizationId: orgId, domain: c.companyDomain } }, select: { description: true } }) : null;
    const r = await personalizeContact(c, settings, { marketBrief: c.campaign?.marketBrief, companyDescription: company?.description, language: c.campaign?.language });
    await addUsage(orgId, "aiCalls");
    if (r.status === "failed") {
      const attempt = c.personalizationStatus === "retry_2" ? 3 : c.personalizationStatus === "retry_1" ? 2 : 1;
      if (attempt < 3) {
        await prisma.contact.update({ where: { id: c.id }, data: { personalizationStatus: `retry_${attempt}` } });
        continue;
      }
    }
    await prisma.contact.update({
      where: { id: c.id },
      data: { personalization: r.body, messageSubject: r.subject, followup2: r.followup2, followup3: r.followup3, personalizationStatus: r.status === "failed" ? "fallback" : r.status, status: "PERSONALIZED" },
    });
    done++;
  }
  return done;
}

export async function pushQueue(orgId: string): Promise<{ pushed: number; reason?: string }> {
  const settings = await getSettings(orgId);
  const sl = await smartleadFor(orgId);
  if (!sl) return { pushed: 0, reason: "smartlead-not-configured" };
  const sub = await subscriptionOf(orgId);
  const tz = settings.timezone;
  const dayKey = dateKeyInTz(tz);
  const mailboxes = settings.smartleadMailboxIds.length;
  const physical = mailboxes ? mailboxes * settings.perMailboxDailyCap : settings.defaultDailySendCap;
  const planLimit = dailyVolumeLimit(sub);

  let batchId: string | null = null;
  let batchQuotaLeft = Number.POSITIVE_INFINITY;
  let catchUp = 0;
  const today = tzMidnightUtc(dayKey, tz);
  if (settings.weeklyBatchMode) {
    await closePastBatches(orgId, dayKey);
    const batch = await activeSendBatch(orgId, dayKey);
    if (batch) {
      batchId = batch.id;
      if (batch.status === "APPROVED") await prisma.weeklyBatch.update({ where: { id: batch.id }, data: { status: "SENDING" } });
      const [pushedToday, remaining] = await Promise.all([
        prisma.message.count({ where: { organizationId: orgId, direction: "OUTBOUND", via: "sequence", createdAt: { gte: today }, contact: { batchId: batch.id } } }),
        prisma.contact.count({ where: { organizationId: orgId, batchId: batch.id, status: { in: ["NEW", "PERSONALIZED", "QUEUED"] } } }),
      ]);
      const days = Math.max(1, workdaysLeft(dayKeyOf(batch.weekStart), dayKey));
      const fairShare = Math.ceil((remaining + pushedToday) / days);
      batchQuotaLeft = Math.max(0, fairShare - pushedToday);
      catchUp += fairShare;
    }
    const leftovers = await prisma.contact.count({ where: { organizationId: orgId, batch: { status: "DONE" }, status: { in: ["NEW", "PERSONALIZED", "QUEUED"] } } });
    if (leftovers) catchUp += Math.ceil(leftovers / Math.max(1, workdaysLeft(mondayOf(dayKey), dayKey)));
  }
  const target = Math.min(settings.defaultDailySendCap, planLimit || settings.defaultDailySendCap);
  const cap = Math.min(physical, planLimit || physical, Math.max(target, catchUp));
  const already = await prisma.message.count({ where: { organizationId: orgId, direction: "OUTBOUND", via: "sequence", createdAt: { gte: today } } });
  const remaining = Math.max(0, cap - already);
  if (!remaining) return { pushed: 0, reason: "daily-cap-reached" };

  let pool = await prisma.contact.findMany({
    where: {
      organizationId: orgId,
      status: { in: ["PERSONALIZED", "QUEUED"] },
      fitScore: { gte: SEND_FLOOR },
      campaign: { status: "ACTIVE" },
      OR: [{ verifyResult: null }, { verifyResult: { in: ["ok", "catch_all"] } }],
      AND: [batchApproved],
    },
    orderBy: [{ fitScore: "desc" }, { createdAt: "asc" }],
    take: Math.min(500, remaining * 4 + 20),
  });
  pool.sort((a, b) => Number(b.batchId === batchId) - Number(a.batchId === batchId) || Number(b.source === "csv") - Number(a.source === "csv") || TIER_ORDER(a) - TIER_ORDER(b));
  if (!pool.length) return { pushed: 0, reason: "nothing-sendable" };

  const talking = new Set(
    (await prisma.contact.findMany({ where: { organizationId: orgId, status: "REPLIED" }, select: { companyDomain: true, domain: true } }))
      .flatMap((r) => [r.companyDomain, r.domain])
      .filter((d): d is string => !!d && !isFreeMailDomain(d)),
  );
  pool = pool.filter((c) => ![c.companyDomain, c.domain].some((d) => d && talking.has(d)));

  const picked: Contact[] = [];
  for (const c of pool) {
    if (picked.length >= remaining) break;
    if (batchId && c.batchId === batchId) {
      if (batchQuotaLeft <= 0) continue;
      batchQuotaLeft--;
    }
    picked.push(c);
  }
  if (!picked.length) return { pushed: 0, reason: "quota" };

  const groups = new Map<string, Contact[]>();
  const campaigns = new Map(
    (await prisma.campaign.findMany({ where: { organizationId: orgId, id: { in: [...new Set(picked.map((c) => c.campaignId!).filter(Boolean))] } }, select: { id: true, smartleadCampaignId: true } })).map((c) => [c.id, c.smartleadCampaignId]),
  );
  for (const c of picked) {
    const slId = c.smartleadCampaignId ?? (c.campaignId ? campaigns.get(c.campaignId) : null) ?? settings.smartleadDefaultCampaignId;
    if (!slId) continue;
    groups.set(slId, [...(groups.get(slId) ?? []), c]);
  }
  if (!groups.size) {
    await logSystem(orgId, "WARN", "send", "Leads are ready but no sending campaign is provisioned. Connect mailboxes in Settings → Sending.");
    return { pushed: 0, reason: "no-smartlead-campaign" };
  }

  let pushed = 0;
  for (const [slId, list] of groups) {
    try {
      const status = await sl.getCampaignStatus(slId);
      if (status === "PAUSED" || status === "COMPLETED") {
        await sl.setStatus(slId, "START");
        await logSystem(orgId, "WARN", "smartlead", `Sending campaign ${slId} was ${status.toLowerCase()} and was restarted before pushing new leads`);
      }
    } catch {
      /* keepalive is best effort */
    }
    for (let i = 0; i < list.length; i += 400) {
      const slice = list.slice(i, i + 400);
      const leads: SmartleadLead[] = slice.map((c) => ({
        email: c.email,
        first_name: c.firstName,
        last_name: c.lastName,
        company_name: c.company,
        website: c.website,
        location: c.location,
        custom_fields: {
          ai_subject: c.messageSubject ?? "",
          ai_body: htmlize(c.personalization),
          ai_followup2: htmlize(c.followup2),
          ai_followup3: htmlize(c.followup3),
          meeting_link: settings.meetingLink ?? "",
        },
      }));
      let ids: Map<string, string>;
      try {
        ids = await sl.addLeads(slId, leads);
      } catch (err) {
        const status = (err as { status?: number }).status ?? 0;
        const rejected = status >= 400 && status < 500 && status !== 408 && status !== 429;
        if (!rejected) {
          await prisma.contact.updateMany({
            where: { id: { in: slice.map((c) => c.id) } },
            data: { status: "CONTACTED", smartleadCampaignId: slId, lastContactedAt: new Date() },
          });
          await logSystem(orgId, "CRITICAL", "smartlead", `Push outcome unknown for ${slice.length} lead(s) on campaign ${slId}. They are marked contacted so nobody can be emailed twice; check the campaign and re-queue them if they are missing.`, {
            contactIds: slice.map((c) => c.id).slice(0, 50),
          });
        } else {
          await logSystem(orgId, "ERROR", "smartlead", `Smartlead rejected ${slice.length} lead(s): ${(err as Error).message}`);
        }
        break;
      }
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        for (const c of slice) {
          await tx.contact.update({
            where: { id: c.id },
            data: {
              status: "CONTACTED",
              smartleadCampaignId: slId,
              smartleadLeadId: ids.get(c.emailNormalized) ?? ids.get(c.email.toLowerCase()) ?? c.smartleadLeadId,
              firstContactedAt: c.firstContactedAt ?? now,
              lastContactedAt: now,
            },
          });
          await recordMessage(tx, { organizationId: orgId, contactId: c.id, campaignId: c.campaignId, direction: "OUTBOUND", via: "sequence", subject: c.messageSubject, body: c.personalization, createdAt: now });
        }
      });
      pushed += slice.length;
    }
  }
  return { pushed };
}

export async function runSendForOrg(orgId: string) {
  const verified = await verifyNew(orgId);
  const personalized = await personalizeNew(orgId);
  const push = await pushQueue(orgId);
  return { verified, personalized, push };
}

export function runSendJob() {
  return forEachOrg("send", autopilotOrgs, runSendForOrg);
}
