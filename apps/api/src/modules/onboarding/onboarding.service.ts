import { Prisma, type Onboarding } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { badRequest, conflict, notFound, unprocessable, upstream } from "../../lib/errors.js";
import { brandFromDomain, extractDomain, isValidDomain } from "../../lib/normalize.js";
import { MAX_INBOXES_PER_DOMAIN, SENDS_PER_WARM_INBOX, VOLUME_MAX, VOLUME_MIN, WARMUP_OPTIONS, tldPriceCents } from "../../config/plans.js";
import { requireAi } from "../../integrations/ai.js";
import { apolloFor } from "../../integrations/apollo.js";
import { fetchSiteText, mailSetup } from "../../integrations/site.js";
import { assertActiveSubscription, dailyVolumeLimit } from "../../domain/entitlements.js";
import { addUsage } from "../../domain/usage.js";
import { getSettings } from "../../domain/settings.js";
import { lintEmail } from "../../domain/personalize.js";
import { provisionCampaign } from "../../domain/provisioning.js";
import { features } from "../../config/env.js";
import { domainIdeas, isDomainTaken, lookalikes } from "./domainIdeas.js";

export interface Icp {
  industries: string[];
  titles: string[];
  sizes: string[];
  regions: string[];
}

export interface PreviewEmail {
  tab: string;
  day: string;
  subject: string;
  body: string;
}

const SIZE_RANGES: Record<string, string> = {
  "1 to 10": "1,10",
  "11 to 50": "11,50",
  "51 to 200": "51,200",
  "201 to 500": "201,500",
  "501 to 1,000": "501,1000",
  "1,001 to 5,000": "1001,5000",
  "5,001+": "5001,1000000",
};
export const SIZE_OPTIONS = Object.keys(SIZE_RANGES);

function icpOf(o: Onboarding): Icp {
  const raw = (o.icp ?? {}) as Partial<Icp>;
  return { industries: raw.industries ?? [], titles: raw.titles ?? [], sizes: raw.sizes ?? [], regions: raw.regions ?? [] };
}

export function apolloFiltersFromIcp(icp: Icp): Record<string, unknown> {
  return {
    person_titles: icp.titles,
    person_seniorities: ["owner", "founder", "c_suite", "partner", "vp", "head", "director"],
    organization_num_employees_ranges: icp.sizes.map((s) => SIZE_RANGES[s]).filter(Boolean),
    person_locations: icp.regions,
    q_organization_keyword_tags: icp.industries,
  };
}

async function load(orgId: string): Promise<Onboarding> {
  const o = await prisma.onboarding.findUnique({ where: { organizationId: orgId } });
  if (!o) throw notFound("Setup");
  return o;
}

export async function getState(orgId: string) {
  const [onboarding, domains, mailboxes, subscription, settings] = await Promise.all([
    prisma.onboarding.findUnique({ where: { organizationId: orgId } }),
    prisma.sendingDomain.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } }),
    prisma.mailbox.findMany({ where: { organizationId: orgId }, orderBy: [{ sendingDomainId: "asc" }, { address: "asc" }] }),
    prisma.subscription.findUnique({ where: { organizationId: orgId }, select: { status: true, planId: true } }),
    getSettings(orgId),
  ]);
  return {
    onboarding: onboarding ? { ...onboarding, icp: icpOf(onboarding) } : null,
    domains,
    mailboxes,
    subscription,
    senderName: settings.senderName,
    aiAvailable: features.ai,
    sizeOptions: SIZE_OPTIONS,
  };
}

export async function start(orgId: string, domainRaw: string) {
  const domain = extractDomain(domainRaw);
  if (!domain || !isValidDomain(domain)) throw badRequest("That doesn't look like a domain. Try something like northwind.io");
  const existing = await prisma.onboarding.findUnique({ where: { organizationId: orgId } });
  if (existing?.paidAt) throw conflict("Setup is already paid for. Change settings from the app instead.");
  const brand = brandFromDomain(domain);
  const empty: Prisma.InputJsonValue = { industries: [], titles: [], sizes: [], regions: [] };
  await prisma.$transaction(async (tx) => {
    if (existing && existing.domain !== domain) {
      await tx.sendingDomain.deleteMany({ where: { organizationId: orgId, status: "SELECTED" } });
      await tx.mailbox.deleteMany({ where: { organizationId: orgId, status: "PLANNED" } });
    }
    await tx.onboarding.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, domain, brand, icp: empty },
      update: existing && existing.domain !== domain ? { domain, brand, icp: empty, summary: null, preview: Prisma.DbNull, analyzedAt: null, analysisError: null } : {},
    });
    await tx.organization.update({ where: { id: orgId }, data: { primaryDomain: domain } });
  });
  return getState(orgId);
}

export async function update(
  orgId: string,
  patch: { summary?: string; icp?: Icp; volume?: number; warmupDays?: number; inboxesPerDomain?: number; provider?: string; senderName?: string },
) {
  const o = await load(orgId);
  if (patch.volume !== undefined && (patch.volume < VOLUME_MIN || patch.volume > VOLUME_MAX)) throw badRequest(`Daily volume must be between ${VOLUME_MIN} and ${VOLUME_MAX}`);
  if (patch.warmupDays !== undefined && !(WARMUP_OPTIONS as readonly number[]).includes(patch.warmupDays)) throw badRequest("Warmup must be 14, 21 or 28 days");
  const icpChanged = patch.icp && JSON.stringify(patch.icp) !== JSON.stringify(icpOf(o));
  await prisma.onboarding.update({
    where: { organizationId: orgId },
    data: {
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.icp ? { icp: patch.icp as unknown as Prisma.InputJsonValue } : {}),
      ...(patch.volume !== undefined ? { volume: patch.volume } : {}),
      ...(patch.warmupDays !== undefined ? { warmupDays: patch.warmupDays } : {}),
      ...(patch.inboxesPerDomain !== undefined ? { inboxesPerDomain: patch.inboxesPerDomain } : {}),
      ...(patch.provider ? { provider: patch.provider } : {}),
      ...(icpChanged || patch.summary !== undefined ? { preview: Prisma.DbNull } : {}),
    },
  });
  if (patch.warmupDays !== undefined) await prisma.mailbox.updateMany({ where: { organizationId: orgId, status: "PLANNED" }, data: { warmupDays: patch.warmupDays } });
  if (patch.senderName !== undefined) await prisma.orgSettings.update({ where: { organizationId: orgId }, data: { senderName: patch.senderName || null } });
  return getState(orgId);
}

interface AnalysisResult {
  summary?: string;
  value_prop?: string;
  industries?: string[];
  titles?: string[];
  sizes?: string[];
  regions?: string[];
  language?: string;
}

const clampList = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, n) : []);

export async function analyze(orgId: string) {
  const o = await load(orgId);
  const ai = requireAi();
  const [site, mail] = await Promise.all([fetchSiteText(o.domain, 6000), mailSetup(o.domain).catch(() => ({ hasMx: false, hasSpf: false }))]);
  const prompt = `You are a B2B go-to-market strategist. Read this company's website and describe who is most likely to buy from it, for a cold email campaign.

DOMAIN: ${o.domain}
TITLE: ${site.title ?? "(unknown)"}
META DESCRIPTION: ${site.description ?? "(none)"}
WEBSITE TEXT:
${site.text || "(the site could not be read; infer carefully from the domain and say so in the summary)"}

Return STRICT JSON:
{
  "summary": "2 or 3 plain sentences: what the company sells and who it is for. No hype.",
  "value_prop": "one sentence describing the outcome the company delivers for its customers",
  "industries": ["3 to 5 industries or markets that buy this, short labels like 'B2B SaaS', 'E-commerce brands'"],
  "titles": ["3 to 5 job titles that sign off on it, like 'Founder or CEO', 'Head of Growth'"],
  "sizes": ["1 to 3 values chosen ONLY from: ${SIZE_OPTIONS.map((s) => `'${s}'`).join(", ")}"],
  "regions": ["1 to 3 countries or regions where the buyers are"],
  "language": "two-letter code for the language outreach should be written in"
}
Only use facts supported by the website text. Never invent customers, numbers or claims.`;
  let result: AnalysisResult | null;
  try {
    result = await ai.generateJSON<AnalysisResult>(prompt, { maxTokens: 900, temperature: 0.3 });
    await addUsage(orgId, "aiCalls");
  } catch (err) {
    await prisma.onboarding.update({ where: { organizationId: orgId }, data: { analysisError: (err as Error).message.slice(0, 300) } });
    throw upstream("AI analysis", "the analysis could not be completed, please retry");
  }
  if (!result?.summary) {
    await prisma.onboarding.update({ where: { organizationId: orgId }, data: { analysisError: "empty analysis" } });
    throw upstream("AI analysis", "the analysis came back empty, please retry");
  }
  const icp: Icp = {
    industries: clampList(result.industries, 6),
    titles: clampList(result.titles, 6),
    sizes: clampList(result.sizes, 3).filter((s) => SIZE_OPTIONS.includes(s)),
    regions: clampList(result.regions, 4),
  };
  const language = /^[a-z]{2}$/.test(String(result.language ?? "")) ? String(result.language) : "en";
  await prisma.$transaction([
    prisma.onboarding.update({
      where: { organizationId: orgId },
      data: { summary: String(result.summary).slice(0, 1200), icp: icp as unknown as Prisma.InputJsonValue, analyzedAt: new Date(), analysisError: null, preview: Prisma.DbNull },
    }),
    prisma.orgSettings.update({
      where: { organizationId: orgId },
      data: {
        valueProp: result.value_prop ? String(result.value_prop).slice(0, 500) : undefined,
        language,
        brandProfile: { company: o.brand, domain: o.domain, summary: String(result.summary).slice(0, 1200), valueProp: result.value_prop ?? null, audience: icp } as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);
  return { ...(await getState(orgId)), scan: { pagesRead: site.text ? 1 : 0, siteTitle: site.title, hasMx: mail.hasMx, hasSpf: mail.hasSpf } };
}

export async function reach(orgId: string) {
  const o = await load(orgId);
  const apollo = await apolloFor(orgId);
  if (!apollo) return { available: false, total: null as number | null };
  try {
    const r = await apollo.searchPeople(apolloFiltersFromIcp(icpOf(o)), 1, 1);
    await addUsage(orgId, "searches");
    return { available: true, total: r.totalEntries };
  } catch {
    return { available: false, total: null };
  }
}

export async function preview(orgId: string) {
  const o = await load(orgId);
  if (!o.summary) throw unprocessable("Run the business analysis first");
  const settings = await getSettings(orgId);
  const icp = icpOf(o);
  const ai = requireAi();
  const prompt = `Write a three step cold email sequence for ${o.brand} (${o.domain}).

WHAT THEY DO: ${o.summary}
VALUE: ${settings.valueProp ?? ""}
AUDIENCE: industries ${icp.industries.join(", ") || "any"}; titles ${icp.titles.join(", ") || "decision makers"}; regions ${icp.regions.join(", ") || "any"}.
LANGUAGE: ${settings.language === "en" ? "English" : settings.language}.

Use the literal merge tokens {{first_name}}, {{company}} and, at most once, {{similar_company}} where a real prospect's details will go.
Email 1 (day 1): 50 to 90 words, a specific reason to talk, one low-pressure question.
Email 2 (day 3): 30 to 60 words, same thread, a different angle.
Email 3 (day 7): 25 to 45 words, a polite last note that leaves the door open.
Plain text, no links, no em-dashes, no invented customers or numbers, no sign-off (a signature is added).
Return STRICT JSON: {"emails":[{"subject":"...","body":"..."},{"subject":"...","body":"..."},{"subject":"...","body":"..."}]}`;
  const out = await ai.generateJSON<{ emails?: { subject?: string; body?: string }[] }>(prompt, { maxTokens: 900, temperature: 0.7 });
  await addUsage(orgId, "aiCalls");
  const emails = (out?.emails ?? []).slice(0, 3);
  if (emails.length < 3 || emails.some((e) => !e.body)) throw upstream("AI preview", "the preview could not be written, please retry");
  const meta: [string, string][] = [["Intro", "Day 1"], ["Follow up", "Day 3"], ["Last note", "Day 7"]];
  const previewEmails: PreviewEmail[] = emails.map((e, i) => ({
    tab: meta[i][0],
    day: meta[i][1],
    subject: i === 0 ? lintEmail(String(e.subject ?? ""), 12) : `Re: ${lintEmail(String(emails[0].subject ?? ""), 12)}`,
    body: lintEmail(String(e.body ?? ""), 120),
  }));
  await prisma.onboarding.update({ where: { organizationId: orgId }, data: { preview: previewEmails as unknown as Prisma.InputJsonValue } });
  return getState(orgId);
}

export async function ideas(orgId: string, offset: number, limit: number) {
  const o = await load(orgId);
  return domainIdeas(o.domain, offset, limit);
}

function addressesFor(domain: string, senderName: string | null, count: number): string[] {
  const parts = (senderName ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
  const f = parts[0] ?? "hello";
  const l = parts[1] ?? "";
  const locals = l ? [f, `${f}.${l[0]}`, `${f[0]}.${l}`, `${f}${l[0]}`, `${f}.${l}`] : [f, `${f}.team`, `${f}1`, `${f}.hq`, `${f}2`];
  return locals.slice(0, count).map((x) => `${x}@${domain}`);
}

export async function saveDomains(orgId: string, selections: { name: string; inboxes: number }[]) {
  const o = await load(orgId);
  if (o.paidAt) throw conflict("Domains are already paid for");
  const allowed = new Set(lookalikes(o.domain).map((d) => d.name));
  const unique = [...new Map(selections.map((s) => [s.name.toLowerCase(), s])).values()];
  for (const s of unique) {
    if (!allowed.has(s.name.toLowerCase())) throw badRequest(`${s.name} is not one of the suggested sending domains`);
    if (s.inboxes < 1 || s.inboxes > MAX_INBOXES_PER_DOMAIN) throw badRequest(`Each domain can have 1 to ${MAX_INBOXES_PER_DOMAIN} inboxes`);
  }
  const taken: string[] = [];
  for (const s of unique) if (await isDomainTaken(s.name.toLowerCase())) taken.push(s.name);
  if (taken.length) throw unprocessable(`Already registered by someone else: ${taken.join(", ")}`, { taken });
  const settings = await getSettings(orgId);
  await prisma.$transaction(async (tx) => {
    await tx.mailbox.deleteMany({ where: { organizationId: orgId, status: "PLANNED" } });
    await tx.sendingDomain.deleteMany({ where: { organizationId: orgId, status: "SELECTED" } });
    for (const s of unique) {
      const name = s.name.toLowerCase();
      const domain = await tx.sendingDomain.create({ data: { organizationId: orgId, name, priceCents: tldPriceCents(name) ?? 0, forwardTo: o.domain } });
      await tx.mailbox.createMany({
        data: addressesFor(name, settings.senderName, s.inboxes).map((address) => ({
          organizationId: orgId,
          sendingDomainId: domain.id,
          address,
          provider: o.provider,
          warmupDays: o.warmupDays,
          dailyLimit: SENDS_PER_WARM_INBOX,
        })),
        skipDuplicates: true,
      });
    }
  });
  return getState(orgId);
}

export async function launch(orgId: string) {
  const o = await load(orgId);
  const sub = await assertActiveSubscription(orgId);
  const settings = await getSettings(orgId);
  const icp = icpOf(o);
  const volume = Math.min(o.volume, dailyVolumeLimit(sub));
  let campaign = await prisma.campaign.findFirst({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } });
  if (!campaign) {
    campaign = await prisma.campaign.create({
      data: {
        organizationId: orgId,
        name: `${o.brand}: first campaign`,
        niche: icp.industries.slice(0, 3).join(", ") || null,
        marketBrief: o.summary,
        status: "ACTIVE",
        language: settings.language,
        apolloFilters: apolloFiltersFromIcp(icp) as Prisma.InputJsonValue,
        dailySendCap: volume,
      },
    });
  }
  await prisma.orgSettings.update({
    where: { organizationId: orgId },
    data: {
      defaultDailySendCap: volume,
      dailySourceTarget: Math.max(20, Math.min(volume, 1000)),
      autopilotEnabled: true,
      senderCompany: settings.senderCompany ?? o.brand,
    },
  });
  const missing: string[] = [];
  let provisioned: { smartleadCampaignId: string; mailboxes: number } | null = null;
  if (settings.smartleadMailboxIds.length && !campaign.smartleadCampaignId) {
    try {
      provisioned = await provisionCampaign(orgId, campaign.id, settings.smartleadMailboxIds);
    } catch (err) {
      missing.push(`Sending could not be provisioned yet: ${(err as Error).message}`);
    }
  } else if (!settings.smartleadMailboxIds.length) {
    missing.push("Connect your sending mailboxes in Settings → Sending so the campaign can start sending");
  }
  if (!features.ai) missing.push("AI personalization is not configured on this server");
  await prisma.onboarding.update({ where: { organizationId: orgId }, data: { launchedAt: new Date() } });
  return { campaignId: campaign.id, provisioned, missing, state: await getState(orgId) };
}
