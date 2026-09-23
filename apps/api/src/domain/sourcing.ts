import type { Campaign, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { extractDomain, isFreeMailDomain } from "../lib/normalize.js";
import { apolloFor, type ApolloPerson } from "../integrations/apollo.js";
import { partitionCandidates } from "./dedup.js";
import { scoreContact } from "./scoring.js";
import { addUsage } from "./usage.js";
import { brandProfileOf, getSettings } from "./settings.js";
import { refreshSourcedCount } from "./batches.js";

export interface SourcingResult {
  searched: number;
  enriched: number;
  inserted: number;
  duplicates: number;
  blocked: number;
  capped: number;
  noEmail: number;
  saturated: boolean;
}

function orgDomain(p: ApolloPerson): string | null {
  return extractDomain(p.organization?.primary_domain ?? p.organization?.website_url ?? null);
}

export async function searchPreview(orgId: string, filters: Record<string, unknown>, page = 1, perPage = 25) {
  const apollo = await apolloFor(orgId);
  if (!apollo) return null;
  const r = await apollo.searchPeople(filters, page, perPage);
  await addUsage(orgId, "searches");
  return r;
}

export async function sourceForCampaign(orgId: string, campaign: Campaign, opts: { maxEnrich: number; batchId: string | null }): Promise<SourcingResult> {
  const result: SourcingResult = { searched: 0, enriched: 0, inserted: 0, duplicates: 0, blocked: 0, capped: 0, noEmail: 0, saturated: false };
  const apollo = await apolloFor(orgId);
  if (!apollo || opts.maxEnrich <= 0) return result;
  const settings = await getSettings(orgId);
  const audience = brandProfileOf(settings).audience;
  const filters = (campaign.apolloFilters ?? {}) as Record<string, unknown>;
  const perPage = 25;
  const { people } = await apollo.searchPeople(filters, campaign.sourcePage, perPage);
  await addUsage(orgId, "searches");
  result.searched = people.length;
  if (people.length < perPage) result.saturated = true;

  const apolloIds = people.map((p) => p.id).filter((x): x is string => !!x);
  const known = new Set(
    (await prisma.contact.findMany({ where: { organizationId: orgId, apolloId: { in: apolloIds } }, select: { apolloId: true } })).map((c) => c.apolloId),
  );
  const domains = [...new Set(people.map(orgDomain).filter((d): d is string => !!d && !isFreeMailDomain(d)))];
  const blockedDomains = new Set(
    (await prisma.blocklistEntry.findMany({ where: { organizationId: orgId, entryType: "DOMAIN", value: { in: domains } }, select: { value: true } })).map((b) => b.value),
  );
  const toEnrich = people.filter((p) => p.id && !known.has(p.id) && !blockedDomains.has(orgDomain(p) ?? "")).slice(0, opts.maxEnrich);
  result.duplicates += people.length - toEnrich.length;

  const enriched: ApolloPerson[] = [];
  for (let i = 0; i < toEnrich.length; i += 10) {
    const chunk = toEnrich.slice(i, i + 10);
    const matches = await apollo.bulkEnrich(chunk.map((p) => ({ id: p.id })));
    enriched.push(...matches);
  }
  result.enriched = enriched.length;
  await addUsage(orgId, "peopleEnriched", enriched.length);

  const withEmail = enriched.filter((p) => p.email && p.email_status !== "unavailable");
  result.noEmail = enriched.length - withEmail.length;
  const { fresh, duplicates, blocked, capped } = await partitionCandidates(
    orgId,
    withEmail.map((p) => ({ email: p.email!, companyDomain: orgDomain(p), person: p })),
    { perCompanyCap: settings.perCompanyContactCap },
  );
  result.duplicates += duplicates.length;
  result.blocked += blocked.length;
  result.capped += capped.length;

  for (const c of fresh) {
    const p = c.person;
    const org = p.organization;
    const domain = orgDomain(p);
    if (domain) {
      await prisma.company.upsert({
        where: { organizationId_domain: { organizationId: orgId, domain } },
        create: {
          organizationId: orgId,
          domain,
          name: org?.name ?? null,
          website: org?.website_url ?? null,
          industry: org?.industry ?? null,
          employees: org?.estimated_num_employees ?? null,
          description: org?.short_description ?? null,
          linkedinUrl: org?.linkedin_url ?? null,
          city: org?.city ?? null,
          country: org?.country ?? null,
        },
        update: {},
      });
    }
    const { fitScore, tier } = scoreContact(
      { title: p.title, seniority: p.seniority, emailStatus: p.email_status, employees: org?.estimated_num_employees, industry: org?.industry, website: org?.website_url, linkedinUrl: p.linkedin_url },
      audience,
    );
    try {
      await prisma.contact.create({
        data: {
          organizationId: orgId,
          email: c._email,
          emailNormalized: c._normalized,
          domain: c._normalized.split("@")[1] ?? null,
          companyDomain: domain,
          firstName: p.first_name ?? null,
          lastName: p.last_name ?? null,
          fullName: p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || null),
          title: p.title ?? null,
          headline: p.headline ?? null,
          seniority: p.seniority ?? null,
          company: org?.name ?? p.organization_name ?? null,
          website: org?.website_url ?? null,
          linkedinUrl: p.linkedin_url ?? null,
          photoUrl: p.photo_url ?? null,
          city: p.city ?? null,
          country: p.country ?? null,
          location: [p.city, p.country].filter(Boolean).join(", ") || null,
          industry: org?.industry ?? null,
          apolloId: p.id ?? null,
          emailStatus: p.email_status ?? null,
          campaignId: campaign.id,
          batchId: opts.batchId,
          source: "apollo",
          fitScore,
          tier,
          raw: { apollo: { id: p.id, org: org?.id ?? null } } as Prisma.InputJsonValue,
        },
      });
      result.inserted++;
    } catch {
      result.duplicates++;
    }
  }

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: result.saturated ? { sourcePage: 1, saturatedAt: new Date() } : { sourcePage: { increment: 1 } },
  });
  if (opts.batchId && result.inserted) await refreshSourcedCount(orgId, opts.batchId);
  return result;
}
