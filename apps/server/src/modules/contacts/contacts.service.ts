import type { ContactStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { extractDomain } from "../../lib/normalize.js";
import { partitionCandidates } from "../../domain/dedup.js";
import { parseLeadCsv } from "../../domain/leadImport.js";
import { refreshSourcedCount, resolveImportBatch, weekLabel } from "../../domain/batches.js";
import { getSettings } from "../../domain/settings.js";
import { dateKeyInTz, tzMidnightUtc, addDays } from "../../lib/time.js";
import { LEAD_CLASSES } from "../../domain/needsReply.js";

export const REPLY_CLASSES = ["hot", "question", "review", "curious", "not_now", "away", "referral", "not_interested", "stop", "frustrated", "auto", "moved", "deceased"] as const;
const HIDDEN: ContactStatus[] = ["BLOCKLISTED", "BOUNCED", "UNSUBSCRIBED", "NO_RESPONSE", "REJECTED"];
const SUPPRESSED: ContactStatus[] = ["BLOCKLISTED", "BOUNCED", "UNSUBSCRIBED"];

export interface ContactFilters {
  status?: ContactStatus;
  suppressed?: boolean;
  campaignId?: string;
  batchId?: string;
  tier?: string;
  reply?: string;
  contacted?: boolean;
  search?: string;
}

export function buildWhere(orgId: string, q: ContactFilters, includeReply = true): Prisma.ContactWhereInput {
  const and: Prisma.ContactWhereInput[] = [{ organizationId: orgId }];
  if (q.status) and.push({ status: q.status });
  else if (q.suppressed) and.push({ status: { in: SUPPRESSED } });
  else and.push({ status: { notIn: HIDDEN } });
  if (q.campaignId) and.push({ campaignId: q.campaignId });
  if (q.batchId) and.push({ batchId: q.batchId });
  if (q.tier) and.push({ tier: q.tier.toUpperCase() });
  if (includeReply && q.reply) {
    if (q.reply === "urgent") and.push({ replyUrgent: true });
    else if (q.reply === "lead") and.push({ replyClass: { in: LEAD_CLASSES } });
    else if (q.reply === "replied") and.push({ repliedAt: { not: null } });
    else and.push({ replyClass: q.reply });
  }
  if (q.contacted) and.push({ lastContactedAt: { not: null } });
  if (q.search) {
    const s = q.search.trim();
    and.push({ OR: [{ email: { contains: s, mode: "insensitive" } }, { fullName: { contains: s, mode: "insensitive" } }, { company: { contains: s, mode: "insensitive" } }] });
  }
  return { AND: and };
}

export const listSelect = {
  id: true, email: true, fullName: true, firstName: true, lastName: true, title: true, company: true, website: true, phone: true,
  linkedinUrl: true, location: true, industry: true, status: true, personalizationStatus: true, campaignId: true, batchId: true,
  source: true, photoUrl: true, seniority: true, emailStatus: true, verifyResult: true, replyClass: true, replyUrgent: true,
  followUpAt: true, fitScore: true, tier: true, lastContactedAt: true, repliedAt: true, createdAt: true,
} as const;

export async function list(orgId: string, q: ContactFilters & { page: number; limit: number }) {
  const where = buildWhere(orgId, q);
  const base = buildWhere(orgId, q, false);
  const [rows, total, classes, urgent, replied] = await Promise.all([
    prisma.contact.findMany({
      where,
      select: listSelect,
      orderBy: [{ replyUrgent: "desc" }, { fitScore: "desc" }, { lastContactedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.contact.count({ where }),
    prisma.contact.groupBy({ by: ["replyClass"], where: { AND: [base, { replyClass: { not: null } }] }, _count: { _all: true } }),
    prisma.contact.count({ where: { AND: [base, { replyUrgent: true }] } }),
    prisma.contact.count({ where: { AND: [base, { repliedAt: { not: null } }] } }),
  ]);
  const byClass: Record<string, number> = {};
  for (const c of classes) if (c.replyClass) byClass[c.replyClass] = c._count._all;
  return { rows, total, replyCounts: { byClass, urgent, replied } };
}

export async function stats(orgId: string) {
  const [byStatus, byTier, total, verified, companies] = await Promise.all([
    prisma.contact.groupBy({ by: ["status"], where: { organizationId: orgId }, _count: { _all: true } }),
    prisma.contact.groupBy({ by: ["tier"], where: { organizationId: orgId, tier: { not: null } }, _count: { _all: true } }),
    prisma.contact.count({ where: { organizationId: orgId } }),
    prisma.contact.count({ where: { organizationId: orgId, OR: [{ emailStatus: "verified" }, { verifyResult: { in: ["ok", "catch_all"] } }] } }),
    prisma.company.count({ where: { organizationId: orgId } }),
  ]);
  return {
    total,
    verified,
    companies,
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    byTier: Object.fromEntries(byTier.map((r) => [r.tier, r._count._all])),
  };
}

export async function detail(orgId: string, id: string) {
  const contact = await prisma.contact.findFirst({ where: { id, organizationId: orgId }, include: { campaign: { select: { id: true, name: true } } } });
  if (!contact) throw notFound("Lead");
  const [company, messages] = await Promise.all([
    contact.companyDomain ? prisma.company.findUnique({ where: { organizationId_domain: { organizationId: orgId, domain: contact.companyDomain } } }) : null,
    prisma.message.findMany({ where: { organizationId: orgId, contactId: id }, orderBy: { createdAt: "asc" }, take: 100, select: { id: true, direction: true, subject: true, body: true, intent: true, createdAt: true } }),
  ]);
  return { contact, company, messages };
}

export async function importCsv(orgId: string, text: string, campaignIdRaw?: string) {
  const parsed = parseLeadCsv(text);
  if (!parsed) throw badRequest("We couldn't find an email column in that file");
  const settings = await getSettings(orgId);
  let campaignId: string | null = null;
  if (campaignIdRaw) {
    const c = await prisma.campaign.findFirst({ where: { id: campaignIdRaw, organizationId: orgId, status: "ACTIVE" }, select: { id: true } });
    if (!c) throw badRequest("Choose a running campaign to import into");
    campaignId = c.id;
  } else {
    const c = await prisma.campaign.findFirst({ where: { organizationId: orgId, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true } });
    campaignId = c?.id ?? null;
  }
  const batch = await resolveImportBatch(orgId);
  const { fresh, duplicates, blocked, capped } = await partitionCandidates(
    orgId,
    parsed.leads.map((l) => ({ email: l.email, companyDomain: extractDomain(l.website), lead: l })),
    { perCompanyCap: settings.perCompanyContactCap },
  );
  const data: Prisma.ContactCreateManyInput[] = fresh.map((c) => ({
    organizationId: orgId,
    email: c._email,
    emailNormalized: c._normalized,
    domain: c._normalized.split("@")[1] ?? null,
    companyDomain: c.companyDomain ?? c._domains[0] ?? null,
    firstName: c.lead.firstName,
    lastName: c.lead.lastName,
    fullName: c.lead.fullName,
    title: c.lead.title,
    company: c.lead.company,
    website: c.lead.website,
    phone: c.lead.phone,
    linkedinUrl: c.lead.linkedinUrl,
    location: c.lead.location,
    industry: c.lead.industry,
    campaignId,
    batchId: batch?.id ?? null,
    source: "csv",
    fitScore: 60,
    tier: "A",
  }));
  const inserted = data.length ? (await prisma.contact.createMany({ data, skipDuplicates: true })).count : 0;
  if (batch && inserted) await refreshSourcedCount(orgId, batch.id);
  const parts = [`Your list is in: ${inserted} new ${inserted === 1 ? "person" : "people"} added.`];
  if (batch) parts.push(`They're lined up for the week of ${weekLabel(batch)}; you'll approve that week before anything sends, and uploads go out first.`);
  else parts.push("Their addresses are checked before anything sends, and uploads go out first.");
  const skipped = [
    duplicates.length && `${duplicates.length} already in your lists`,
    blocked.length && `${blocked.length} on your blocklist`,
    capped.length && `${capped.length} held back by the per-company limit`,
  ].filter(Boolean);
  if (skipped.length) parts.push(`Skipped: ${skipped.join(", ")}.`);
  return {
    message: parts.join(" "),
    imported: inserted,
    duplicates: duplicates.length,
    blocked: blocked.length,
    capped: capped.length,
    totalRows: parsed.totalRows,
    skippedRows: parsed.skipped,
    mapped: parsed.mapped,
    campaignId,
    batchId: batch?.id ?? null,
  };
}

export async function daily(orgId: string, dateRaw?: string) {
  const s = await getSettings(orgId);
  const date = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : dateKeyInTz(s.timezone);
  const from = tzMidnightUtc(date, s.timezone);
  const to = tzMidnightUtc(addDays(date, 1), s.timezone);
  const [sent, queued] = await Promise.all([
    prisma.contact.findMany({ where: { organizationId: orgId, lastContactedAt: { gte: from, lt: to } }, select: listSelect, orderBy: { lastContactedAt: "desc" }, take: 2000 }),
    prisma.contact.findMany({ where: { organizationId: orgId, status: { in: ["PERSONALIZED", "QUEUED"] } }, select: listSelect, orderBy: { createdAt: "asc" }, take: 2000 }),
  ]);
  return { date, sent, queued, counts: { sent: sent.length, queued: queued.length }, range: { from, to } };
}
