import { Prisma, type Onboarding } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { badRequest, conflict, notFound, unprocessable, upstream } from "../../lib/errors.js";
import { brandFromDomain, extractDomain, isValidDomain } from "../../lib/normalize.js";
import { sha256 } from "../../lib/crypto.js";
import { MAX_INBOXES_PER_DOMAIN, SENDS_PER_WARM_INBOX, VOLUME_MAX, VOLUME_MIN, WARMUP_OPTIONS, tldPriceCents } from "../../config/plans.js";
import { getAi, requireAi } from "../../integrations/ai.js";
import { apolloFor, type ApolloPerson } from "../../integrations/apollo.js";
import { fetchSitePages, mailSetup } from "../../integrations/site.js";
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

export type FactKey = "company" | "sell" | "who" | "where" | "proof";

export interface Fact {
  key: FactKey;
  label: string;
  value: string;
  source: string;
}

export interface BuyerGroup {
  id: string;
  name: string;
  why: string;
  pains: string[];
  titles: string[];
  sizes: string[];
  regions: string[];
  keywords: string[];
  on: boolean;
}

export interface Sender {
  first: string;
  last: string;
}

const FACT_LABELS: Record<FactKey, string> = {
  company: "Company name",
  sell: "What you sell",
  who: "Who it's for",
  where: "Where you operate",
  proof: "Proof point",
};

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

const SIZE_BUCKETS: [string, number][] = [
  ["1–10 staff", 10],
  ["11–50 staff", 50],
  ["51–200 staff", 200],
  ["201–1,000 staff", 1000],
  ["1,000+ staff", Number.POSITIVE_INFINITY],
];

const MARKET_TTL_MS = 24 * 3600_000;

const clampList = (v: unknown, n: number, max = 80) =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim().slice(0, max)).filter(Boolean))].slice(0, n) : [];
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

function icpOf(o: Onboarding): Icp {
  const raw = (o.icp ?? {}) as Partial<Icp>;
  return { industries: raw.industries ?? [], titles: raw.titles ?? [], sizes: raw.sizes ?? [], regions: raw.regions ?? [] };
}

export function groupsOf(o: Pick<Onboarding, "groups">): BuyerGroup[] {
  return Array.isArray(o.groups) ? (o.groups as unknown as BuyerGroup[]) : [];
}

function factsOf(o: Pick<Onboarding, "facts">): Fact[] {
  return Array.isArray(o.facts) ? (o.facts as unknown as Fact[]) : [];
}

export function sendersOf(o: Pick<Onboarding, "senders">, fallbackName: string | null): Sender[] {
  const list = Array.isArray(o.senders) ? (o.senders as unknown as Sender[]).filter((s) => s.first?.trim()) : [];
  if (list.length) return list;
  const parts = (fallbackName ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? [{ first: parts[0], last: parts.slice(1).join(" ") }] : [];
}

function icpFromGroups(groups: BuyerGroup[]): Icp {
  const on = groups.filter((g) => g.on);
  const union = (k: "keywords" | "titles" | "sizes" | "regions", n: number) => [...new Set(on.flatMap((g) => g[k]))].slice(0, n);
  return { industries: union("keywords", 12), titles: union("titles", 12), sizes: union("sizes", 7), regions: union("regions", 12) };
}

function summaryFromFacts(facts: Fact[]): string {
  const v = (k: FactKey) => facts.find((f) => f.key === k)?.value?.trim();
  const who = v("who");
  return [v("sell"), who && `For ${who.charAt(0).toLowerCase()}${who.slice(1)}`, v("where")].filter(Boolean).join(" ").slice(0, 1200);
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

function groupFilters(g: BuyerGroup): Record<string, unknown> {
  return apolloFiltersFromIcp({ industries: g.keywords, titles: g.titles, sizes: g.sizes, regions: g.regions });
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
  const campaign = onboarding?.launchedAt
    ? await prisma.campaign.findFirst({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, status: true, smartleadCampaignId: true } })
    : null;
  return {
    onboarding: onboarding
      ? {
          ...onboarding,
          market: undefined,
          icp: icpOf(onboarding),
          facts: factsOf(onboarding),
          groups: groupsOf(onboarding),
          senders: sendersOf(onboarding, settings.senderName),
        }
      : null,
    domains,
    mailboxes,
    subscription,
    campaign,
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
  const changed = !!existing && existing.domain !== domain;
  await prisma.$transaction(async (tx) => {
    if (changed) {
      await tx.sendingDomain.deleteMany({ where: { organizationId: orgId, status: "SELECTED" } });
      await tx.mailbox.deleteMany({ where: { organizationId: orgId, status: "PLANNED" } });
    }
    await tx.onboarding.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, domain, brand, icp: empty },
      update: changed
        ? { domain, brand, icp: empty, summary: null, preview: Prisma.DbNull, facts: Prisma.DbNull, groups: Prisma.DbNull, market: Prisma.DbNull, siteReadable: null, analyzedAt: null, analysisError: null }
        : {},
    });
    await tx.organization.update({ where: { id: orgId }, data: { primaryDomain: domain } });
  });
  return getState(orgId);
}

export interface OnboardingPatch {
  facts?: { key: FactKey; value: string }[];
  groups?: { id: string; on: boolean }[];
  volume?: number;
  warmupDays?: number;
  inboxesPerDomain?: number;
  provider?: string;
  fastStart?: boolean;
  senders?: Sender[];
}

export async function update(orgId: string, patch: OnboardingPatch) {
  const o = await load(orgId);
  if (patch.volume !== undefined && (patch.volume < VOLUME_MIN || patch.volume > VOLUME_MAX)) throw badRequest(`Daily volume must be between ${VOLUME_MIN} and ${VOLUME_MAX}`);
  if (patch.warmupDays !== undefined && !(WARMUP_OPTIONS as readonly number[]).includes(patch.warmupDays)) throw badRequest("Warmup must be 14, 21 or 28 days");
  if ((patch.senders || patch.fastStart !== undefined) && o.paidAt) throw conflict("Inboxes are already paid for");
  const data: Prisma.OnboardingUpdateInput = {};
  let company: string | undefined;
  let contentChanged = false;

  if (patch.facts) {
    const facts = factsOf(o).map((f) => {
      const next = patch.facts!.find((x) => x.key === f.key);
      return next ? { ...f, value: next.value.trim().slice(0, 400) } : f;
    });
    data.facts = facts as unknown as Prisma.InputJsonValue;
    data.summary = summaryFromFacts(facts);
    company = facts.find((f) => f.key === "company")?.value.trim().slice(0, 120) || undefined;
    if (company) data.brand = company;
    contentChanged = true;
  }
  if (patch.groups) {
    const groups = groupsOf(o).map((g) => {
      const t = patch.groups!.find((x) => x.id === g.id);
      return t ? { ...g, on: t.on } : g;
    });
    data.groups = groups as unknown as Prisma.InputJsonValue;
    data.icp = icpFromGroups(groups) as unknown as Prisma.InputJsonValue;
    contentChanged = true;
  }
  if (contentChanged) data.preview = Prisma.DbNull;
  if (patch.volume !== undefined) data.volume = patch.volume;
  if (patch.warmupDays !== undefined) data.warmupDays = patch.warmupDays;
  if (patch.inboxesPerDomain !== undefined) data.inboxesPerDomain = patch.inboxesPerDomain;
  if (patch.provider) data.provider = patch.provider;
  if (patch.fastStart !== undefined) data.fastStart = patch.fastStart;
  let senders: Sender[] | null = null;
  if (patch.senders) {
    senders = patch.senders
      .map((s) => ({ first: clip(s.first, 60), last: clip(s.last, 60) }))
      .filter((s) => s.first)
      .slice(0, 3);
    if (!senders.length) throw badRequest("Add at least one sender name");
    data.senders = senders as unknown as Prisma.InputJsonValue;
  }
  await prisma.onboarding.update({ where: { organizationId: orgId }, data });
  if (patch.warmupDays !== undefined) await prisma.mailbox.updateMany({ where: { organizationId: orgId, status: "PLANNED" }, data: { warmupDays: patch.warmupDays } });
  if (senders || company) {
    await prisma.orgSettings.update({
      where: { organizationId: orgId },
      data: { ...(senders ? { senderName: `${senders[0].first} ${senders[0].last}`.trim() } : {}), ...(company ? { senderCompany: company } : {}) },
    });
  }
  return getState(orgId);
}

interface AiFact {
  value?: string;
  source?: string;
}

interface AiGroup {
  name?: string;
  why?: string;
  pains?: unknown;
  titles?: unknown;
  sizes?: unknown;
  regions?: unknown;
  keywords?: unknown;
}

interface AnalysisResult {
  company?: AiFact;
  sell?: AiFact;
  who?: AiFact;
  where?: AiFact;
  proof?: AiFact;
  value_prop?: string;
  language?: string;
  groups?: AiGroup[];
}

function cleanGroups(raw: AiGroup[] | undefined, fallbackRegions: string[]): BuyerGroup[] {
  return (Array.isArray(raw) ? raw : [])
    .map((g, i) => {
      const regions = clampList(g.regions, 4);
      return {
        id: `g${i + 1}`,
        name: clip(g.name, 80),
        why: clip(g.why, 300),
        pains: clampList(g.pains, 3, 120),
        titles: clampList(g.titles, 5),
        sizes: clampList(g.sizes, 3).filter((s) => SIZE_OPTIONS.includes(s)),
        regions: regions.length ? regions : fallbackRegions.slice(0, 4),
        keywords: clampList(g.keywords, 5),
        on: true,
      };
    })
    .filter((g) => g.name && g.titles.length)
    .slice(0, 3);
}

const GROUP_SPEC = `"groups": [2 or 3 distinct buyer groups, each {
    "name": "short label for the kind of company, e.g. 'E-commerce brands shipping in volume'",
    "why": "one plain sentence on why they buy",
    "pains": ["exactly 3 short pain points"],
    "titles": ["2 or 3 job titles that sign off on it"],
    "sizes": ["1 or 2 values chosen ONLY from: ${SIZE_OPTIONS.map((s) => `'${s}'`).join(", ")}"],
    "regions": ["1 to 3 countries"],
    "keywords": ["2 to 4 short industry keywords a B2B database would use"]
  }]`;

async function saveAnalysis(orgId: string, o: Onboarding, facts: Fact[], groups: BuyerGroup[], valueProp: string | null, language: string, siteReadable: boolean) {
  const icp = icpFromGroups(groups);
  const summary = summaryFromFacts(facts);
  const company = facts.find((f) => f.key === "company")?.value || o.brand;
  await prisma.$transaction([
    prisma.onboarding.update({
      where: { organizationId: orgId },
      data: {
        brand: company.slice(0, 120),
        summary,
        facts: facts as unknown as Prisma.InputJsonValue,
        groups: groups as unknown as Prisma.InputJsonValue,
        icp: icp as unknown as Prisma.InputJsonValue,
        siteReadable,
        analyzedAt: new Date(),
        analysisError: null,
        preview: Prisma.DbNull,
        market: Prisma.DbNull,
      },
    }),
    prisma.orgSettings.update({
      where: { organizationId: orgId },
      data: {
        valueProp: valueProp ? valueProp.slice(0, 500) : undefined,
        language,
        senderCompany: company.slice(0, 160),
        brandProfile: { company, domain: o.domain, summary, valueProp, audience: icp, groups: groups.map((g) => g.name) } as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);
}

export async function analyze(orgId: string) {
  const o = await load(orgId);
  const ai = requireAi();
  const [site, mail] = await Promise.all([fetchSitePages(o.domain), mailSetup(o.domain).catch(() => ({ hasMx: false, hasSpf: false }))]);
  const scan = { pagesRead: site.pages.length, siteTitle: site.home?.title ?? null, hasMx: mail.hasMx, hasSpf: mail.hasSpf };
  if (!site.pages.length) {
    await prisma.onboarding.update({ where: { organizationId: orgId }, data: { siteReadable: false, analysisError: "The site could not be read" } });
    return { ...(await getState(orgId)), scan };
  }
  const corpus = site.pages.map((p) => `--- PAGE ${p.path}${p.title ? ` (${p.title})` : ""}\n${p.text}`).join("\n\n").slice(0, 14_000);
  const paths = site.pages.map((p) => p.path);
  const prompt = `You are a B2B go-to-market strategist. Read this company's website and describe what it sells and who is most likely to buy it, for a cold email campaign.

DOMAIN: ${o.domain}
HOMEPAGE TITLE: ${site.home?.title ?? "(none)"}
META DESCRIPTION: ${site.home?.description ?? "(none)"}
PAGES READ: ${paths.join(", ")}

${corpus}

Every fact must come from the pages above. For each fact give "source": the page path it came from (one of ${paths.map((p) => `"${p}"`).join(", ")}), or "homepage title" for the company name when it comes from the title. Leave "value" empty if the pages don't say it.
Return STRICT JSON:
{
  "company": {"value": "the company's name as written on the site", "source": "..."},
  "sell": {"value": "one plain sentence on what they sell", "source": "..."},
  "who": {"value": "one plain sentence on who it's for", "source": "..."},
  "where": {"value": "where they operate or sell into", "source": "..."},
  "proof": {"value": "one proof point quoted or closely paraphrased from the site (a result, a customer type, a certification)", "source": "..."},
  "value_prop": "one sentence describing the outcome the company delivers",
  "language": "two-letter code for the language outreach should be written in",
  ${GROUP_SPEC}
}
Never invent customers, numbers or claims. Plain words, no hype, no em-dashes.`;
  let result: AnalysisResult | null;
  try {
    result = await ai.generateJSON<AnalysisResult>(prompt, { maxTokens: 1600, temperature: 0.3 });
    await addUsage(orgId, "aiCalls");
  } catch (err) {
    await prisma.onboarding.update({ where: { organizationId: orgId }, data: { siteReadable: true, analysisError: (err as Error).message.slice(0, 300) } });
    throw upstream("AI analysis", "the analysis could not be completed, please retry");
  }
  const facts: Fact[] = [];
  for (const key of ["company", "sell", "who", "where", "proof"] as FactKey[]) {
    const f = result?.[key];
    const value = clip(f?.value, 400);
    if (!value) continue;
    const src = clip(f?.source, 60);
    facts.push({ key, label: FACT_LABELS[key], value, source: src === "homepage title" || paths.includes(src) ? src : "/" });
  }
  if (!facts.some((f) => f.key === "company")) facts.unshift({ key: "company", label: FACT_LABELS.company, value: o.brand, source: "from your domain" });
  const groups = cleanGroups(result?.groups, []);
  if (!facts.some((f) => f.key === "sell") || !groups.length) {
    await prisma.onboarding.update({ where: { organizationId: orgId }, data: { siteReadable: true, analysisError: "empty analysis" } });
    throw upstream("AI analysis", "the analysis came back empty, please retry");
  }
  const language = /^[a-z]{2}$/.test(String(result?.language ?? "")) ? String(result!.language) : "en";
  await saveAnalysis(orgId, o, facts, groups, result?.value_prop ? String(result.value_prop) : null, language, true);
  return { ...(await getState(orgId)), scan };
}

function titlesFrom(who: string): string[] {
  const head = who.split(/\s+(?:at|in|for|from)\s+/i)[0] ?? who;
  return head
    .split(/,|\band\b|\//i)
    .map((x) => x.trim().replace(/(manager|director|owner|founder|head|lead|officer|partner)s\b/i, "$1"))
    .filter(Boolean)
    .slice(0, 3)
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1));
}

export async function answers(orgId: string, input: { sell: string; who: string; regions: string[] }) {
  const o = await load(orgId);
  const regions = clampList(input.regions, 9);
  if (!regions.length) throw badRequest("Pick at least one country");
  const facts: Fact[] = [
    { key: "company", label: FACT_LABELS.company, value: o.brand, source: "from your domain" },
    { key: "sell", label: FACT_LABELS.sell, value: clip(input.sell, 400), source: "from your answers" },
    { key: "who", label: FACT_LABELS.who, value: clip(input.who, 400), source: "from your answers" },
    { key: "where", label: FACT_LABELS.where, value: regions.join(", "), source: "from your answers" },
  ];
  const ai = getAi();
  let groups: BuyerGroup[] = [];
  let valueProp: string | null = null;
  if (ai) {
    const prompt = `A company told us about its business. Suggest who is most likely to buy from it, for a cold email campaign.

COMPANY: ${o.brand} (${o.domain})
WHAT THEY SELL: ${facts[1].value}
WHO BUYS IT: ${facts[2].value}
COUNTRIES: ${regions.join(", ")}

Return STRICT JSON:
{
  "value_prop": "one sentence describing the outcome the company delivers",
  ${GROUP_SPEC.replace("2 or 3", "1 or 2")}
}
Keep the first group closest to what they told us. Only use the countries listed. Never invent customers or numbers.`;
    try {
      const r = await ai.generateJSON<{ value_prop?: string; groups?: AiGroup[] }>(prompt, { maxTokens: 900, temperature: 0.3 });
      await addUsage(orgId, "aiCalls");
      groups = cleanGroups(r?.groups, regions).map((g) => {
        const inList = g.regions.filter((x) => regions.includes(x));
        return { ...g, regions: inList.length ? inList : regions.slice(0, 3) };
      });
      valueProp = r?.value_prop ? String(r.value_prop) : null;
    } catch {
      groups = [];
    }
  }
  if (!groups.length) {
    const titles = titlesFrom(facts[2].value);
    groups = [
      {
        id: "g1",
        name: facts[2].value.slice(0, 80),
        why: `They need ${facts[1].value.charAt(0).toLowerCase()}${facts[1].value.slice(1).replace(/\.$/, "")}.`,
        pains: [],
        titles: titles.length ? titles : ["Founder or CEO"],
        sizes: [],
        regions: regions.slice(0, 3),
        keywords: [],
        on: true,
      },
    ];
  }
  await saveAnalysis(orgId, o, facts, groups, valueProp, (await getSettings(orgId)).language, o.siteReadable ?? false);
  return getState(orgId);
}

function groupsKey(groups: BuyerGroup[]): string {
  return sha256(JSON.stringify(groups.filter((g) => g.on).map((g) => [g.id, g.titles, g.sizes, g.regions, g.keywords])));
}

function seniorityOf(p: ApolloPerson): string {
  const s = `${p.seniority ?? ""} ${p.title ?? ""}`.toLowerCase();
  if (/founder|owner|c_suite|chief|ceo|coo|cfo|cto|partner|managing director|president/.test(s)) return "Founder or C-level";
  if (/vp|vice president|director|head/.test(s)) return "Head or director";
  return "Manager";
}

function sizeOf(n: number | undefined): string | null {
  if (!n) return null;
  return SIZE_BUCKETS.find(([, max]) => n <= max)?.[0] ?? null;
}

function tally(items: (string | null | undefined)[], top: number): [string, number][] {
  const m = new Map<string, number>();
  for (const x of items) if (x) m.set(x, (m.get(x) ?? 0) + 1);
  const all = [...m.entries()].sort((a, b) => b[1] - a[1]);
  if (all.length <= top) return all;
  return [...all.slice(0, top - 1), ["Other", all.slice(top - 1).reduce((s, x) => s + x[1], 0)]];
}

export interface MarketView {
  available: boolean;
  reason: string | null;
  groups: { id: string; count: number | null; verified: number | null }[];
  people: number | null;
  verified: number | null;
  sample: { size: number; byCountry: [string, number][]; bySize: [string, number][]; bySeniority: [string, number][] };
  prospects: { firstName: string; lastInitial: string; title: string | null; company: string | null; country: string | null; hasEmail: boolean }[];
  checkedAt: string;
}

export async function market(orgId: string, refresh = false): Promise<MarketView> {
  const o = await load(orgId);
  const groups = groupsOf(o).filter((g) => g.on);
  const empty = (reason: string): MarketView => ({
    available: false,
    reason,
    groups: groups.map((g) => ({ id: g.id, count: null, verified: null })),
    people: null,
    verified: null,
    sample: { size: 0, byCountry: [], bySize: [], bySeniority: [] },
    prospects: [],
    checkedAt: new Date().toISOString(),
  });
  if (!groups.length) return empty("no-groups");
  const key = groupsKey(groupsOf(o));
  const cached = o.market as unknown as (MarketView & { key: string }) | null;
  if (!refresh && cached?.key === key && Date.now() - new Date(cached.checkedAt).getTime() < MARKET_TTL_MS) {
    const { key: _key, ...rest } = cached;
    void _key;
    return rest;
  }
  const apollo = await apolloFor(orgId);
  if (!apollo) return empty("not-connected");
  try {
    const counts: MarketView["groups"] = [];
    const sample: ApolloPerson[] = [];
    for (const g of groups) {
      const f = groupFilters(g);
      const all = await apollo.searchPeople(f, 1, 25);
      const ver = await apollo.searchPeople({ ...f, contact_email_status: ["verified"] }, 1, 1);
      await addUsage(orgId, "searches", 2);
      counts.push({ id: g.id, count: all.totalEntries, verified: ver.totalEntries });
      sample.push(...all.people);
    }
    const sum = (k: "count" | "verified") => (counts.every((c) => c[k] !== null) ? counts.reduce((s, c) => s + (c[k] ?? 0), 0) : null);
    const step = Math.max(1, Math.floor(sample.length / 12));
    const view: MarketView = {
      available: true,
      reason: null,
      groups: counts,
      people: sum("count"),
      verified: sum("verified"),
      sample: {
        size: sample.length,
        byCountry: tally(sample.map((p) => p.country ?? p.organization?.country), 5),
        bySize: SIZE_BUCKETS.map(([label]) => [label, sample.filter((p) => sizeOf(p.organization?.estimated_num_employees) === label).length] as [string, number]).filter(([, n]) => n > 0),
        bySeniority: tally(sample.map(seniorityOf), 3),
      },
      prospects: sample
        .filter((_, i) => i % step === 0)
        .slice(0, 12)
        .map((p) => ({
          firstName: p.first_name ?? (p.name ?? "").split(" ")[0] ?? "",
          lastInitial: (p.last_name ?? (p.name ?? "").split(" ")[1] ?? "").charAt(0).toUpperCase(),
          title: p.title ?? null,
          company: p.organization?.name ?? p.organization_name ?? null,
          country: p.country ?? p.organization?.country ?? null,
          hasEmail: p.email_status === "verified" || !!(p as { has_email?: boolean }).has_email,
        })),
      checkedAt: new Date().toISOString(),
    };
    await prisma.onboarding.update({ where: { organizationId: orgId }, data: { market: { ...view, key } as unknown as Prisma.InputJsonValue } });
    return view;
  } catch {
    return empty("lookup-failed");
  }
}

export async function preview(orgId: string) {
  const o = await load(orgId);
  if (!o.summary) throw unprocessable("Run the business analysis first");
  const settings = await getSettings(orgId);
  const groups = groupsOf(o).filter((g) => g.on);
  const icp = icpOf(o);
  const ai = requireAi();
  const audience = groups.length
    ? groups.map((g) => `- ${g.name}: ${g.why} Pains: ${g.pains.join("; ") || "n/a"}. Titles: ${g.titles.join(", ")}.`).join("\n")
    : `titles ${icp.titles.join(", ") || "decision makers"}; regions ${icp.regions.join(", ") || "any"}`;
  const prompt = `Write a three step cold email sequence for ${o.brand} (${o.domain}).

WHAT THEY DO: ${o.summary}
VALUE: ${settings.valueProp ?? ""}
AUDIENCE:
${audience}
LANGUAGE: ${settings.language === "en" ? "English" : settings.language}.

Use the literal merge tokens {{first_name}}, {{company}} and, at most once, {{similar_company}} where a real prospect's details will go.
Email 1 (day 1): 50 to 90 words, a specific reason to talk tied to one pain point, one low-pressure question.
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

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");

export function addressesFor(domain: string, senders: Sender[], count: number, domainIndex: number): string[] {
  const list = senders.map((s) => ({ f: slug(s.first), l: slug(s.last) })).filter((s) => s.f);
  const people = list.length ? list : [{ f: "hello", l: "" }];
  const n = people.length;
  const out: string[] = [];
  for (let j = 0; j < count; j++) {
    const p = domainIndex * 3 + j;
    const { f, l } = people[p % n];
    const form = Math.floor(p / n) % 5;
    const local = l ? [f, `${f}.${l[0]}`, `${f}${l[0]}`, `${f[0]}.${l}`, `${f}.${l}`][form] : [f, `hello.${f}`, `${f}.team`, `hi.${f}`, `${f}.mail`][form];
    out.push(`${local}@${domain}`);
  }
  return out;
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
  const senders = sendersOf(o, settings.senderName);
  await prisma.$transaction(async (tx) => {
    await tx.mailbox.deleteMany({ where: { organizationId: orgId, status: "PLANNED" } });
    await tx.sendingDomain.deleteMany({ where: { organizationId: orgId, status: "SELECTED" } });
    for (const [i, s] of unique.entries()) {
      const name = s.name.toLowerCase();
      const domain = await tx.sendingDomain.create({ data: { organizationId: orgId, name, priceCents: tldPriceCents(name) ?? 0, forwardTo: o.domain } });
      await tx.mailbox.createMany({
        data: addressesFor(name, senders, s.inboxes, i).map((address) => ({
          organizationId: orgId,
          sendingDomainId: domain.id,
          address,
          provider: o.provider,
          warmupDays: o.fastStart ? 0 : o.warmupDays,
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
        niche: groupsOf(o).filter((g) => g.on).map((g) => g.name).slice(0, 3).join(", ") || icp.industries.slice(0, 3).join(", ") || null,
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
  if (!o.launchedAt) await prisma.onboarding.update({ where: { organizationId: orgId }, data: { launchedAt: new Date() } });
  return { campaignId: campaign.id, provisioned, missing, state: await getState(orgId) };
}
