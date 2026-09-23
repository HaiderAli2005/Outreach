import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { getSettings } from "../../domain/settings.js";
import { dateKeyInTz, dayKeyOf, dayOfWeekInTz, mondayOf, tzMidnightUtc, addDays } from "../../lib/time.js";
import { batchStats, pendingReviewBatches, weekLabel } from "../../domain/batches.js";
import { needsReplyWhere, activeOnly } from "../../domain/needsReply.js";
import { subscriptionOf, dailyVolumeLimit, isActive } from "../../domain/entitlements.js";

async function weekStats(orgId: string, from: Date, to?: Date) {
  const range = to ? { gte: from, lt: to } : { gte: from };
  const [sent, replies, found, companies] = await Promise.all([
    prisma.message.count({ where: { organizationId: orgId, direction: "OUTBOUND", createdAt: range } }),
    prisma.message.count({ where: { organizationId: orgId, direction: "INBOUND", createdAt: range } }),
    prisma.contact.count({ where: { organizationId: orgId, status: { not: "REJECTED" }, createdAt: range } }),
    prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT c."companyDomain") AS n FROM "Message" m JOIN "Contact" c ON c.id = m."contactId"
      WHERE m."organizationId" = ${orgId} AND m.direction = 'OUTBOUND' AND m."createdAt" >= ${from}
      ${to ? Prisma.sql`AND m."createdAt" < ${to}` : Prisma.empty}`),
  ]);
  return { sent, replies, found, companies: Number(companies[0]?.n ?? 0) };
}

export async function cockpit(orgId: string) {
  const s = await getSettings(orgId);
  const tz = s.timezone;
  const dayKey = dateKeyInTz(tz);
  const today = tzMidnightUtc(dayKey, tz);
  const weekStart = tzMidnightUtc(mondayOf(dayKey), tz);
  const lastWeekStart = new Date(weekStart.getTime() - 7 * 86_400_000);
  const sub = await subscriptionOf(orgId);
  const mailboxes = s.smartleadMailboxIds.length;
  const capacity = mailboxes ? mailboxes * s.perMailboxDailyCap : s.defaultDailySendCap;
  const todayTarget = Math.min(capacity, s.defaultDailySendCap, dailyVolumeLimit(sub) || s.defaultDailySendCap);

  const [todaySent, pending, repliesWaiting, urgentReplies, latest, thisWeek, prevWeek, journey, markets] = await Promise.all([
    prisma.message.count({ where: { organizationId: orgId, direction: "OUTBOUND", createdAt: { gte: today } } }),
    pendingReviewBatches(orgId),
    prisma.contact.count({ where: needsReplyWhere(orgId) }),
    prisma.contact.count({ where: { organizationId: orgId, replyUrgent: true, ...activeOnly } }),
    prisma.contact.findMany({
      where: { organizationId: orgId, hasInbound: true, status: { notIn: ["BLOCKLISTED", "BOUNCED", "UNSUBSCRIBED", "NO_RESPONSE"] } },
      orderBy: [{ replyUrgent: "desc" }, { lastMessageAt: "desc" }],
      take: 6,
      select: { id: true, fullName: true, email: true, company: true, replyClass: true, replyUrgent: true, lastMessageAt: true, lastMessageDirection: true, lastMessagePreview: true },
    }),
    weekStats(orgId, weekStart),
    weekStats(orgId, lastWeekStart, weekStart),
    Promise.all([
      prisma.contact.count({ where: { organizationId: orgId, status: { not: "REJECTED" } } }),
      prisma.contact.count({ where: { organizationId: orgId, status: { not: "REJECTED" }, personalizationStatus: "done" } }),
      prisma.contact.count({ where: { organizationId: orgId, firstContactedAt: { not: null } } }),
      prisma.contact.count({ where: { organizationId: orgId, repliedAt: { not: null } } }),
    ]),
    prisma.$queryRaw<{ id: string; name: string; replies: bigint; contacted: bigint }[]>`
      SELECT ca.id, ca.name,
             COUNT(*) FILTER (WHERE c."repliedAt" IS NOT NULL) AS replies,
             COUNT(*) FILTER (WHERE c."firstContactedAt" IS NOT NULL) AS contacted
      FROM "Campaign" ca LEFT JOIN "Contact" c ON c."campaignId" = ca.id
      WHERE ca."organizationId" = ${orgId} AND ca.status IN ('ACTIVE','PAUSED')
      GROUP BY ca.id, ca.name
      HAVING COUNT(*) FILTER (WHERE c."firstContactedAt" IS NOT NULL) > 0
      ORDER BY replies DESC, contacted DESC LIMIT 5`,
  ]);

  const from7 = tzMidnightUtc(addDays(dayKey, -6), tz);
  const hb = await prisma.$queryRaw<{ d: Date; sent: bigint; replies: bigint }[]>`
    SELECT (m."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date AS d,
           COUNT(*) FILTER (WHERE m.direction = 'OUTBOUND') AS sent,
           COUNT(*) FILTER (WHERE m.direction = 'INBOUND') AS replies
    FROM "Message" m WHERE m."organizationId" = ${orgId} AND m."createdAt" >= ${from7}
    GROUP BY 1 ORDER BY 1`;
  const hbMap = new Map(hb.map((r) => [dayKeyOf(new Date(r.d)), r]));
  const heartbeat = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(dayKey, i - 6);
    const row = hbMap.get(d);
    return { day: d, sent: Number(row?.sent ?? 0), replies: Number(row?.replies ?? 0) };
  });

  const pendingWeeks = [];
  for (const b of pending.slice(0, 3)) {
    const st = await batchStats(orgId, b.id);
    pendingWeeks.push({ batchId: b.id, weekStart: dayKeyOf(b.weekStart), label: weekLabel(b), sendable: st.sendable, total: st.total });
  }

  const [recentReplies, recentApprovals] = await Promise.all([
    prisma.message.findMany({
      where: { organizationId: orgId, direction: "INBOUND" },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { createdAt: true, contact: { select: { fullName: true, company: true } } },
    }),
    prisma.weeklyBatch.findMany({ where: { organizationId: orgId, updatedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } }, orderBy: { updatedAt: "desc" }, take: 6 }),
  ]);
  const activity: { type: string; at: Date; title: string }[] = [];
  for (const r of recentReplies) activity.push({ type: "reply", at: r.createdAt, title: `${r.contact.fullName ?? "Someone"}${r.contact.company ? ` at ${r.contact.company}` : ""} replied` });
  for (const d of heartbeat.filter((h) => h.sent > 0)) activity.push({ type: "sent", at: new Date(`${d.day}T17:00:00Z`), title: `Sent ${d.sent} email${d.sent === 1 ? "" : "s"}` });
  for (const b of recentApprovals) {
    if (b.approvedAt) activity.push({ type: "approved", at: b.approvedAt, title: `You approved the leads for the week of ${weekLabel(b)}` });
    if (b.status === "REVIEW") activity.push({ type: "review", at: b.updatedAt, title: `The week of ${weekLabel(b)} is ready for review` });
  }
  activity.sort((a, b) => b.at.getTime() - a.at.getTime());

  const dow = dayOfWeekInTz(tz);
  let state = "running";
  if (!isActive(sub)) state = "unpaid";
  else if (!s.autopilotEnabled) state = "paused";
  else if (pendingWeeks.length) state = "reviewing";
  else if (dow === 0 || dow === 6) state = "resting";

  return {
    engine: { on: s.autopilotEnabled, state, todaySent, todayTarget, dayKey, weekday: dow, window: `${s.sendingWindowStart}–${s.sendingWindowEnd}`, timezone: tz },
    needsYou: { pendingWeeks, repliesWaiting, urgentReplies, latestReplies: latest },
    week: thisWeek,
    lastWeek: prevWeek,
    heartbeat,
    journey: { found: journey[0], written: journey[1], contacted: journey[2], replied: journey[3] },
    activity: activity.slice(0, 14),
    markets: markets.map((m) => {
      const contacted = Number(m.contacted);
      const replies = Number(m.replies);
      return { id: m.id, name: m.name, contacted, replies, replyRate: contacted ? Math.round((1000 * replies) / contacted) / 10 : 0 };
    }),
    subscription: sub ? { status: sub.status, plan: sub.plan.name } : null,
  };
}

export async function navCounts(orgId: string) {
  const [inboxAwaiting, leadsPending, activeCampaigns, blocklist, latest, systemAlerts, settings, sub] = await Promise.all([
    prisma.contact.count({ where: needsReplyWhere(orgId) }),
    prisma.contact.count({ where: { organizationId: orgId, batch: { status: "REVIEW" }, status: { notIn: ["REJECTED", "BLOCKLISTED", "BOUNCED", "UNSUBSCRIBED"] } } }),
    prisma.campaign.count({ where: { organizationId: orgId, status: "ACTIVE" } }),
    prisma.blocklistEntry.count({ where: { organizationId: orgId } }),
    prisma.message.findFirst({ where: { organizationId: orgId, direction: "INBOUND" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.systemLog.count({ where: { organizationId: orgId, resolvedAt: null, level: { in: ["ERROR", "CRITICAL"] } } }),
    getSettings(orgId),
    subscriptionOf(orgId),
  ]);
  return {
    inboxAwaiting,
    leadsPending,
    activeCampaigns,
    blocklist,
    latestReplyAt: latest?.createdAt ?? null,
    systemAlerts,
    browserNotifications: settings.browserNotifications,
    autopilotEnabled: settings.autopilotEnabled,
    subscriptionStatus: sub?.status ?? null,
  };
}
