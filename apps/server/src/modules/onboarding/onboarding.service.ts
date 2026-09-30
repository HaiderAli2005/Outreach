import { Prisma, type Onboarding } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { badRequest, conflict, notFound, unprocessable, upstream } from "../../lib/errors.js";
import { brandFromDomain, extractDomain, isValidDomain } from "../../lib/normalize.js";
import { sha256 } from "../../lib/crypto.js";
import { MAX_INBOXES_PER_DOMAIN, SENDS_PER_WARM_INBOX, VOLUME_MAX, VOLUME_MIN, WARMUP_OPTIONS, tldPriceCents } from "../../config/plans.js";
import { getAi, requireAi } from "../../integrations/ai.js";
import { apolloFor, type ApolloPerson } from "../../integrations/apollo.js";
import { fetchSitePages, mailSetup, type SiteHooks, type SitePage } from "../../integrations/site.js";
import { assertActiveSubscription, dailyVolumeLimit } from "../../domain/entitlements.js";
import { addUsage } from "../../domain/usage.js";
import { getSettings } from "../../domain/settings.js";
import { lintEmail } from "../../domain/personalize.js";
import { provisionCampaign } from "../../domain/provisioning.js";
import { features } from "../../config/env.js";
import { domainIdeas, isDomainTaken, lookalikes } from "./domainIdeas.js";
import { ALLOWED_COMPANY_SIZES, ANALYSIS_SCHEMA, ANALYSIS_SYSTEM, PROMPT_VERSION, analysisUserPrompt, type PromptPage, type Signals } from "./analysisPrompt.js";
import { groundAnalysis, numbersIn, sourceFor } from "./grounding.js";
import {
  KEYWORD_PROBLEM_MESSAGE,
  customerWarning,
  keywordProblem,
  kwNorm,
  normalizeDomain,
  sellerTerms,
  validateAnalysis,
  type Analysis,
  type Audience,
  type BrandDetail,
} from "./analysisValidate.js";
import { extractSignals } from "./signals.js";
import { logger } from "../../lib/logger.js";
import { logSystem } from "../../domain/systemLog.js";
import { env } from "../../config/env.js";

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
  priority: number;
  name: string;
  description: string;
  why: string;
  goals: string[];
  pains: string[];
  objections: string[];
  titles: string[];
  includeSimilarTitles: boolean;
  seniorities: string[];
  sizes: string[];
  regions: string[];
  keywords: string[];
  keywordSuggestions: string[];
  revenueRange: { min: number | null; max: number | null };
  technologies: string[];
  signals: { hiringForTitles: string[]; headcountGrowthPctMin: number | null; recentlyFunded: boolean };
  lookalikeDomains: string[];
  excludeDomains: string[];
  on: boolean;
}

export interface StoredAnalysis {
  promptVersion: string;
  createdAt: string;
  source: "site" | "answers";
  confidence: number;
  lowConfidence: boolean;
  brandDetail: BrandDetail;
  warning: string | null;
  targetAudience: Audience[];
  signals: Signals | null;
  repairsMade: string[];
}

export const LOW_CONFIDENCE = 0.4;
/** Below this, or with no usable audience, the site gave too little to guess from and the three questions are shown. Between the two, the audiences are kept as a best guess. */
export const UNUSABLE_CONFIDENCE = 0.2;
export const DEFAULT_SENIORITIES = ["owner", "founder", "c_suite", "partner", "vp", "head", "director"];

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

const LEGACY_SIZE: Record<string, string> = { ...SIZE_RANGES, "5,001+": "5001," };

export function normalizeGroup(raw: Partial<BuyerGroup>, i: number): BuyerGroup {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    id: raw.id ?? `g${i + 1}`,
    priority: raw.priority ?? i + 1,
    name: raw.name ?? "",
    description: raw.description ?? "",
    why: raw.why ?? "",
    goals: list(raw.goals),
    pains: list(raw.pains),
    objections: list(raw.objections),
    titles: list(raw.titles),
    includeSimilarTitles: raw.includeSimilarTitles !== false,
    seniorities: list(raw.seniorities),
    sizes: list(raw.sizes).map((x) => ((ALLOWED_COMPANY_SIZES as readonly string[]).includes(x) ? x : LEGACY_SIZE[x] ?? "")).filter(Boolean),
    regions: list(raw.regions),
    keywords: list(raw.keywords),
    keywordSuggestions: list(raw.keywordSuggestions),
    revenueRange: raw.revenueRange ?? { min: null, max: null },
    technologies: list(raw.technologies),
    signals: raw.signals ?? { hiringForTitles: [], headcountGrowthPctMin: null, recentlyFunded: false },
    lookalikeDomains: list(raw.lookalikeDomains),
    excludeDomains: list(raw.excludeDomains),
    on: raw.on !== false,
  };
}

export function groupsOf(o: Pick<Onboarding, "groups">): BuyerGroup[] {
  return Array.isArray(o.groups) ? (o.groups as unknown as Partial<BuyerGroup>[]).map(normalizeGroup) : [];
}

function analysisOf(o: Pick<Onboarding, "analysis">): StoredAnalysis | null {
  return o.analysis && typeof o.analysis === "object" ? (o.analysis as unknown as StoredAnalysis) : null;
}

function audienceToGroup(a: Audience): BuyerGroup {
  return {
    id: a.id,
    priority: a.priority,
    name: a.name,
    description: a.description,
    why: a.why_they_buy,
    goals: a.goals,
    pains: a.pain_points,
    objections: a.objections,
    titles: a.titles,
    includeSimilarTitles: a.include_similar_titles,
    seniorities: a.seniorities,
    sizes: a.company_sizes,
    regions: a.countries,
    keywords: a.keywords,
    keywordSuggestions: a.keyword_suggestions ?? [],
    revenueRange: a.revenue_range,
    technologies: a.technologies,
    signals: { hiringForTitles: a.signals.hiring_for_titles, headcountGrowthPctMin: a.signals.headcount_growth_pct_min, recentlyFunded: a.signals.recently_funded },
    lookalikeDomains: a.lookalike_domains,
    excludeDomains: a.exclude_domains,
    on: true,
  };
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

function sizeRange(s: string): string | null {
  if (s === "5001,") return "5001,1000000";
  if ((ALLOWED_COMPANY_SIZES as readonly string[]).includes(s)) return s;
  return SIZE_RANGES[s] ?? null;
}

export function apolloFiltersFromIcp(icp: Icp): Record<string, unknown> {
  return {
    person_titles: icp.titles,
    person_seniorities: DEFAULT_SENIORITIES,
    organization_num_employees_ranges: icp.sizes.map(sizeRange).filter(Boolean),
    person_locations: icp.regions,
    q_organization_keyword_tags: icp.industries,
  };
}


export function filtersForGroups(groups: BuyerGroup[]): Record<string, unknown> {
  const union = (pick: (g: BuyerGroup) => string[]) => [...new Set(groups.flatMap(pick))];
  const f: Record<string, unknown> = {
    person_titles: union((g) => g.titles),
    include_similar_titles: groups.some((g) => g.includeSimilarTitles),
    person_seniorities: union((g) => g.seniorities).length ? union((g) => g.seniorities) : DEFAULT_SENIORITIES,
    organization_num_employees_ranges: union((g) => g.sizes).map(sizeRange).filter(Boolean),
    person_locations: union((g) => g.regions),
    q_organization_keyword_tags: union((g) => g.keywords),
  };
  // Technologies stay on the audience card but are not sent: Apollo needs its own technology ids, and a guessed one
  // silently returns zero people.
  const hiring = union((g) => g.signals.hiringForTitles);
  if (hiring.length) f.q_organization_job_titles = hiring;
  if (groups.length === 1) {
    const r = groups[0].revenueRange;
    if (r.min != null || r.max != null) f.revenue_range = { ...(r.min != null ? { min: r.min } : {}), ...(r.max != null ? { max: r.max } : {}) };
  }
  return f;
}

function groupFilters(g: BuyerGroup): Record<string, unknown> {
  return filtersForGroups([g]);
}

async function load(orgId: string): Promise<Onboarding> {
  const o = await prisma.onboarding.findUnique({ where: { organizationId: orgId } });
  if (!o) throw notFound("Setup");
  return o;
}

function analysisSummary(o: Onboarding) {
  const a = analysisOf(o);
  if (!a) return null;
  return {
    promptVersion: a.promptVersion,
    source: a.source,
    confidence: a.confidence,
    lowConfidence: a.lowConfidence,
    brandDetail: a.brandDetail,
    // Older analyses may hold notes the model wrote for itself; only a customer-facing warning is shown.
    warning: customerWarning(a.warning),
    repairsMade: a.repairsMade,
  };
}

export async function getState(orgId: string) {
  const [onboarding, domains, mailboxes, subscription, settings] = await Promise.all([
    prisma.onboarding.findUnique({ where: { organizationId: orgId } }),
    prisma.sendingDomain.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } }),
    prisma.mailbox.findMany({ where: { organizationId: orgId }, orderBy: [{ sendingDomainId: "asc" }, { address: "asc" }] }),
    prisma.subscription.findUnique({ where: { organizationId: orgId }, select: { status: true, planId: true } }),
    getSettings(orgId),
  ]);
  const run = onboarding
    ? await prisma.analysisRun.findFirst({ where: { organizationId: orgId, domain: onboarding.domain }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, lastSeq: true, createdAt: true, error: true } })
    : null;
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
          analysis: analysisSummary(onboarding),
          senders: sendersOf(onboarding, settings.senderName),
        }
      : null,
    domains,
    mailboxes,
    subscription,
    campaign,
    senderName: settings.senderName,
    aiAvailable: features.ai,
    analysisStream: features.analysisStream,
    analysisRun: run,
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
        ? { domain, brand, icp: empty, summary: null, preview: Prisma.DbNull, facts: Prisma.DbNull, groups: Prisma.DbNull, analysis: Prisma.DbNull, market: Prisma.DbNull, siteReadable: null, analyzedAt: null, analysisError: null }
        : {},
    });
    await tx.organization.update({ where: { id: orgId }, data: { primaryDomain: domain } });
  });
  return getState(orgId);
}

export interface OnboardingPatch {
  facts?: { key: FactKey; value: string }[];
  groups?: { id: string; on?: boolean; keywords?: string[] }[];
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
      if (!t) return g;
      const next = { ...g, on: t.on ?? g.on };
      if (t.keywords) Object.assign(next, editKeywords(o, g, t.keywords));
      return next;
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

export const MAX_KEYWORDS = 5;

/** Applies a user's keyword edit to one group, using the same rules as the analysis prompt. */
function editKeywords(o: Onboarding, g: BuyerGroup, raw: string[]): Pick<BuyerGroup, "keywords" | "keywordSuggestions"> {
  const keywords = [...new Set(raw.map(kwNorm).filter(Boolean))];
  if (!keywords.length) throw badRequest("Keep at least one keyword in this audience, or it would search every company.");
  if (keywords.length > MAX_KEYWORDS) throw badRequest(`An audience can have up to ${MAX_KEYWORDS} keywords. Remove one first, or split this audience.`);
  const bd = analysisOf(o)?.brandDetail;
  const seller = sellerTerms(bd?.offerings ?? [], bd?.company_name ?? o.brand, o.domain);
  for (const k of keywords) {
    if (g.keywords.includes(k)) continue;
    const problem = keywordProblem(k, seller);
    if (problem) throw badRequest(`"${k}" ${KEYWORD_PROBLEM_MESSAGE[problem]}`);
  }
  const removed = g.keywords.filter((k) => !keywords.includes(k));
  const keywordSuggestions = [...new Set([...removed, ...g.keywordSuggestions])].filter((k) => !keywords.includes(k)).slice(0, 8);
  return { keywords, keywordSuggestions };
}

const pathOf = (source: string, domain: string) => {
  try {
    const u = new URL(source);
    return normalizeDomain(u.hostname) === normalizeDomain(domain) ? u.pathname || "/" : source;
  } catch {
    return source;
  }
};

function factsFromBrand(bd: BrandDetail, o: Onboarding, answered?: { sell: string; who: string; regions: string[] }): Fact[] {
  // A fact only points at a page when a checked piece of evidence from that page says it; otherwise it is a summary of the site.
  const from = (value: string) => {
    const src = sourceFor(value, bd.evidence);
    return src ? pathOf(src, o.domain) : "from your site";
  };
  const facts: Fact[] = [{ key: "company", label: FACT_LABELS.company, value: bd.company_name || o.brand, source: bd.company_name ? "from your site" : "from your domain" }];
  if (answered) {
    facts.push({ key: "sell", label: FACT_LABELS.sell, value: answered.sell, source: "from your answers" });
    facts.push({ key: "who", label: FACT_LABELS.who, value: answered.who, source: "from your answers" });
    facts.push({ key: "where", label: FACT_LABELS.where, value: answered.regions.join(", "), source: "from your answers" });
  } else {
    if (bd.one_liner) facts.push({ key: "sell", label: FACT_LABELS.sell, value: bd.one_liner, source: from(bd.one_liner) });
    if (bd.customer_types.length) facts.push({ key: "who", label: FACT_LABELS.who, value: bd.customer_types.join(", "), source: from(bd.customer_types.join(" ")) });
    if (bd.geographies.length) facts.push({ key: "where", label: FACT_LABELS.where, value: bd.geographies.join(", "), source: from(bd.geographies.join(" ")) });
  }
  const proof = bd.proof[0];
  if (proof) facts.push({ key: "proof", label: FACT_LABELS.proof, value: proof.text, source: pathOf(proof.source, o.domain) });
  return facts;
}

async function saveAnalysis(orgId: string, o: Onboarding, facts: Fact[], groups: BuyerGroup[], stored: StoredAnalysis | null, valueProp: string | null, language: string, siteReadable: boolean) {
  const icp = icpFromGroups(groups);
  const summary = summaryFromFacts(facts);
  const company = facts.find((f) => f.key === "company")?.value || o.brand;
  const bd = stored?.brandDetail;
  await prisma.$transaction([
    prisma.onboarding.update({
      where: { organizationId: orgId },
      data: {
        brand: company.slice(0, 120),
        summary,
        facts: facts as unknown as Prisma.InputJsonValue,
        groups: groups as unknown as Prisma.InputJsonValue,
        analysis: stored ? (stored as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
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
        brandProfile: {
          company,
          domain: o.domain,
          summary,
          valueProp,
          audience: icp,
          groups: groups.map((g) => g.name),
          offerings: bd?.offerings ?? [],
          brandVoice: bd?.brand_voice ?? null,
          namedCustomers: bd?.named_customers ?? [],
          differentiators: bd?.differentiators.map((d) => d.text) ?? [],
        } as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);
}

async function runAnalysis(orgId: string, domain: string, pages: PromptPage[], signals: Signals): Promise<{ analysis: Analysis; repairs: string[] }> {
  const ai = requireAi();
  const prompt = analysisUserPrompt({ domain, today: new Date().toISOString().slice(0, 10), pages, signals, searchResults: [] });
  // Reasoning budget included: the analysis reads up to 10 pages and checks its own work before answering.
  // Low reasoning effort: measured the same quality here at a fraction of the wait, and the grounding check below does the policing.
  const opts = { system: ANALYSIS_SYSTEM, maxTokens: 24_000, temperature: 0.2, effort: "low" as const, schema: ANALYSIS_SCHEMA, model: env.OPENAI_ANALYSIS_MODEL };
  let raw = await ai.generateJSON<Record<string, unknown>>(prompt, opts);
  await addUsage(orgId, "aiCalls");
  const repairs: string[] = [];
  if (!raw) {
    repairs.push("model output was not valid JSON, retried once");
    raw = await ai.generateJSON<Record<string, unknown>>(prompt, opts);
    await addUsage(orgId, "aiCalls");
  }
  if (!raw) throw new Error("model output was not valid JSON twice");
  const checked = validateAnalysis(raw, domain, signals.language, signals.country);
  // Then every fact is checked against the pages that were read, so nothing the site doesn't say reaches the user.
  const grounded = groundAnalysis(checked.analysis, pages, signals, domain);
  return { analysis: grounded.analysis, repairs: [...repairs, ...checked.repairs, ...grounded.repairs] };
}

export function aiErrorReason(err: unknown): string {
  const e = (err ?? {}) as { status?: number; code?: string; error?: { code?: string; type?: string }; message?: string; cause?: { code?: string } };
  const code = e.code ?? e.error?.code ?? e.error?.type ?? "";
  if (e.status === 401) return "OpenAI rejected the API key. Check OPENAI_API_KEY in apps/server/.env.";
  if (e.status === 429 && /quota|billing/i.test(`${code} ${e.message ?? ""}`)) return "Your OpenAI account has no credit left. Add credit at platform.openai.com, then try again.";
  if (e.status === 429) return "OpenAI is rate limiting this key. Wait a minute and try again.";
  if (e.status === 404 || /model_not_found/i.test(code)) return `The model "${env.OPENAI_MODEL}" isn't available on your OpenAI account. Change OPENAI_MODEL in apps/server/.env.`;
  if (e.status === 403) return "This OpenAI key isn't allowed to use that model or region.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|fetch failed|Connection error/i.test(`${e.cause?.code ?? ""} ${e.message ?? ""}`)) return "Couldn't reach OpenAI from this computer. Check the internet connection or firewall.";
  if (/not valid JSON/i.test(e.message ?? "")) return "The AI returned an unreadable answer twice. Try again.";
  return (e.message ?? "The AI call failed").slice(0, 200);
}

function storedFrom(result: { analysis: Analysis; repairs: string[] }, source: StoredAnalysis["source"], signals: Signals | null): StoredAnalysis {
  const c = result.analysis.brand_detail.confidence;
  return {
    promptVersion: PROMPT_VERSION,
    createdAt: new Date().toISOString(),
    source,
    confidence: c,
    lowConfidence: source === "site" && c < LOW_CONFIDENCE,
    brandDetail: result.analysis.brand_detail,
    warning: result.analysis.warning,
    targetAudience: result.analysis.target_audience,
    signals,
    repairsMade: result.repairs,
  };
}

/** Progress callbacks for the analysis. They only report; the work and the stored result are the same with or without them. */
export interface AnalyzeHooks {
  site?: SiteHooks;
  pages?: (pages: SitePage[]) => void;
  signals?: (signals: Signals) => void;
  analysed?: (result: { analysis: Analysis; repairs: string[] }, stored: StoredAnalysis) => void;
}

export type AnalyzeOutcome = "ok" | "low-confidence" | "unreadable";

export async function analyzeCore(orgId: string, hooks: AnalyzeHooks = {}) {
  const o = await load(orgId);
  requireAi();
  const [site, mail] = await Promise.all([fetchSitePages(o.domain, hooks.site), mailSetup(o.domain).catch(() => ({ hasMx: false, hasSpf: false }))]);
  const scan = { pagesRead: site.pages.length, siteTitle: site.home?.title ?? null, hasMx: mail.hasMx, hasSpf: mail.hasSpf };
  hooks.pages?.(site.pages);
  if (!site.pages.length) {
    await prisma.onboarding.update({ where: { organizationId: orgId }, data: { siteReadable: false, analysisError: "The site could not be read" } });
    return { scan, outcome: "unreadable" as AnalyzeOutcome };
  }
  const signals = extractSignals(o.domain, site.home, site.pages);
  hooks.signals?.(signals);
  const pages: PromptPage[] = site.pages.map((p) => ({ url: p.path, text: p.title ? `${p.title}. ${p.text}` : p.text }));
  let result: { analysis: Analysis; repairs: string[] };
  try {
    result = await runAnalysis(orgId, o.domain, pages, signals);
  } catch (err) {
    const reason = aiErrorReason(err);
    logger.warn({ orgId, domain: o.domain, reason, err: (err as Error)?.message }, "business analysis failed");
    await prisma.onboarding.update({ where: { organizationId: orgId }, data: { siteReadable: true, analysisError: reason.slice(0, 300) } });
    throw upstream("AI analysis", reason);
  }
  const stored = storedFrom(result, "site", signals);
  hooks.analysed?.(result, stored);
  const current = await prisma.onboarding.findUnique({ where: { organizationId: orgId }, select: { domain: true } });
  if (current?.domain !== o.domain) throw conflict(`The setup switched to ${current?.domain ?? "another domain"} while ${o.domain} was being analysed`);
  const groups = result.analysis.target_audience.map(audienceToGroup);
  if (stored.lowConfidence && (stored.confidence < UNUSABLE_CONFIDENCE || !groups.length)) {
    await prisma.onboarding.update({
      where: { organizationId: orgId },
      data: { siteReadable: true, analysis: stored as unknown as Prisma.InputJsonValue, analysisError: "low-confidence", analyzedAt: null },
    });
    return { scan, outcome: "low-confidence" as AnalyzeOutcome };
  }
  if (!groups.length) {
    await prisma.onboarding.update({ where: { organizationId: orgId }, data: { siteReadable: true, analysis: stored as unknown as Prisma.InputJsonValue, analysisError: "empty analysis" } });
    throw upstream("AI analysis", "the analysis came back without a usable audience, please retry");
  }
  const bd = result.analysis.brand_detail;
  await saveAnalysis(orgId, o, factsFromBrand(bd, o), groups, stored, bd.one_liner || null, bd.language, true);
  return { scan, outcome: "ok" as AnalyzeOutcome };
}

export async function analyze(orgId: string) {
  const { scan } = await analyzeCore(orgId);
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
  const regions = [...new Set(clampList(input.regions, 9))];
  if (!regions.length) throw badRequest("Pick at least one country");
  const answered = { sell: clip(input.sell, 400), who: clip(input.who, 400), regions };
  const ai = getAi();
  const settings = await getSettings(orgId);
  let aiFailure: string | null = null;
  if (ai) {
    const pages: PromptPage[] = [{ url: "user-answers", text: `What we sell: ${answered.sell}\nWho buys it: ${answered.who}\nCountries we sell into: ${regions.join(", ")}` }];
    const previous = analysisOf(o)?.signals ?? null;
    const signals: Signals = previous ?? { country: null, language: null, currency: null, named_customers: [], testimonial_titles: [] };
    try {
      const result = await runAnalysis(orgId, o.domain, pages, signals);
      for (const a of result.analysis.target_audience) {
        const kept = a.countries.filter((c) => regions.includes(c));
        if (kept.length !== a.countries.length) result.repairs.push(`${a.id}.countries: limited to the countries you picked`);
        a.countries = kept.length ? kept : regions.slice(0, 3);
      }
      const groups = result.analysis.target_audience.map(audienceToGroup);
      if (groups.length) {
        const bd = result.analysis.brand_detail;
        const stored = storedFrom(result, "answers", signals);
        await saveAnalysis(orgId, o, factsFromBrand(bd, o, answered), groups, stored, bd.one_liner || null, settings.language, o.siteReadable ?? false);
        return getState(orgId);
      }
    } catch (err) {
      aiFailure = aiErrorReason(err);
      logger.warn({ orgId, domain: o.domain, reason: aiFailure }, "analysis from answers failed, using the answers only");
    }
  }
  const titles = titlesFrom(answered.who);
  const group = normalizeGroup(
    {
      id: "seg_1",
      name: answered.who.slice(0, 80),
      description: answered.who,
      why: `They need ${answered.sell.charAt(0).toLowerCase()}${answered.sell.slice(1).replace(/\.$/, "")}.`,
      titles: titles.length ? titles : ["Founder", "Chief Executive Officer"],
      seniorities: DEFAULT_SENIORITIES,
      regions: regions.slice(0, 3),
      excludeDomains: [normalizeDomain(o.domain)],
    },
    0,
  );
  const facts: Fact[] = [
    { key: "company", label: FACT_LABELS.company, value: o.brand, source: "from your domain" },
    { key: "sell", label: FACT_LABELS.sell, value: answered.sell, source: "from your answers" },
    { key: "who", label: FACT_LABELS.who, value: answered.who, source: "from your answers" },
    { key: "where", label: FACT_LABELS.where, value: regions.join(", "), source: "from your answers" },
  ];
  await saveAnalysis(orgId, o, facts, [group], null, null, settings.language, o.siteReadable ?? false);
  if (aiFailure) await prisma.onboarding.update({ where: { organizationId: orgId }, data: { analysisError: `answers-only: ${aiFailure}`.slice(0, 300) } });
  return getState(orgId);
}

function groupsKey(groups: BuyerGroup[]): string {
  return sha256(JSON.stringify(groups.filter((g) => g.on).map((g) => [g.id, groupFilters(g), g.excludeDomains])));
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

export interface MarketCompany {
  audienceId: string;
  name: string;
  domain: string | null;
  country: string | null;
  employees: number | null;
  description: string | null;
  /** Matching people at this company inside the sample, and their titles. */
  people: number;
  titles: string[];
}

export interface MarketPerson {
  audienceId: string;
  firstName: string;
  lastInitial: string;
  title: string | null;
  company: string | null;
  country: string | null;
  hasEmail: boolean;
}

export interface MarketView {
  available: boolean;
  reason: string | null;
  /** companiesInSample counts distinct organisations inside the people sample, never the market. companies is a real total only when ACCURATE_COMPANY_COUNT is on. */
  groups: { id: string; count: number | null; verified: number | null; companiesInSample: number; companies: number | null }[];
  people: number | null;
  verified: number | null;
  sample: { size: number; byCountry: [string, number][]; bySize: [string, number][]; bySeniority: [string, number][] };
  prospects: MarketPerson[];
  /** Organisations found in the people sample, grouped by company. Examples, not a market total. */
  companies: MarketCompany[];
  checkedAt: string;
}

/** Progress callbacks for market sizing. They only report. */
export interface MarketHooks {
  groupStart?: (g: BuyerGroup, index: number, total: number) => void;
  groupDone?: (r: { group: BuyerGroup; index: number; total: number; count: number | null; verified: number | null; companiesInSample: number; companiesTotal: number | null; companies: MarketCompany[]; people: MarketPerson[] }) => void;
}

const personOf = (p: ApolloPerson, audienceId: string): MarketPerson => ({
  audienceId,
  firstName: p.first_name ?? (p.name ?? "").split(" ")[0] ?? "",
  lastInitial: (p.last_name ?? (p.name ?? "").split(" ")[1] ?? "").charAt(0).toUpperCase(),
  title: p.title ?? null,
  company: p.organization?.name ?? p.organization_name ?? null,
  country: p.country ?? p.organization?.country ?? null,
  hasEmail: p.email_status === "verified" || !!(p as { has_email?: boolean }).has_email,
});

/** Groups a people sample by organisation. Derived only: no organisation search, no credits. */
export function companiesFrom(people: ApolloPerson[], audienceId: string): MarketCompany[] {
  const out = new Map<string, MarketCompany>();
  for (const p of people) {
    const org = p.organization;
    const name = org?.name ?? p.organization_name;
    if (!name) continue;
    const domain = normalizeDomain(org?.primary_domain ?? org?.website_url ?? "") || null;
    const key = domain ?? name.toLowerCase();
    const seen = out.get(key);
    if (seen) {
      seen.people++;
      if (p.title && !seen.titles.includes(p.title) && seen.titles.length < 3) seen.titles.push(p.title);
      continue;
    }
    out.set(key, {
      audienceId,
      name,
      domain,
      country: org?.country ?? null,
      employees: org?.estimated_num_employees ?? null,
      description: org?.short_description ?? null,
      people: 1,
      titles: p.title ? [p.title] : [],
    });
  }
  // Companies with more matching people first: they are the strongest examples.
  return [...out.values()].sort((a, b) => b.people - a.people);
}

/**
 * The people shown before payment: a few from every audience, people with an email on file first,
 * interleaved so one large audience never fills the whole list.
 */
export function pickProspects(people: MarketPerson[], perAudience = 4, max = 12): MarketPerson[] {
  const byAudience = new Map<string, MarketPerson[]>();
  for (const p of people) {
    if (!p.firstName) continue;
    const list = byAudience.get(p.audienceId) ?? [];
    list.push(p);
    byAudience.set(p.audienceId, list);
  }
  const queues = [...byAudience.values()].map((list) => [...list.filter((p) => p.hasEmail), ...list.filter((p) => !p.hasEmail)].slice(0, perAudience));
  const out: MarketPerson[] = [];
  for (let round = 0; out.length < max && queues.some((q) => q.length > round); round++) {
    for (const q of queues) if (q[round] && out.length < max) out.push(q[round]);
  }
  return out;
}

function orgFilters(g: BuyerGroup): Record<string, unknown> {
  const f = groupFilters(g);
  return {
    organization_num_employees_ranges: f.organization_num_employees_ranges,
    organization_locations: f.person_locations,
    q_organization_keyword_tags: f.q_organization_keyword_tags,
  };
}

export async function market(orgId: string, refresh = false, hooks: MarketHooks = {}): Promise<MarketView> {
  const o = await load(orgId);
  const groups = groupsOf(o).filter((g) => g.on);
  const empty = (reason: string): MarketView => ({
    available: false,
    reason,
    groups: groups.map((g) => ({ id: g.id, count: null, verified: null, companiesInSample: 0, companies: null })),
    people: null,
    verified: null,
    sample: { size: 0, byCountry: [], bySize: [], bySeniority: [] },
    prospects: [],
    companies: [],
    checkedAt: new Date().toISOString(),
  });
  if (!groups.length) return empty("no-groups");
  const key = groupsKey(groupsOf(o));
  const cached = o.market as unknown as (MarketView & { key: string }) | null;
  const usable = !!cached && !(cached.available && cached.people == null);
  if (!refresh && usable && cached?.key === key && Date.now() - new Date(cached.checkedAt).getTime() < MARKET_TTL_MS) {
    const { key: _key, ...rest } = cached;
    void _key;
    const view: MarketView = { ...rest, companies: rest.companies ?? [], groups: rest.groups.map((x) => ({ ...x, companiesInSample: x.companiesInSample ?? 0, companies: x.companies ?? null })) };
    groups.forEach((g, i) => {
      const c = view.groups.find((x) => x.id === g.id);
      hooks.groupDone?.({
        group: g,
        index: i,
        total: groups.length,
        count: c?.count ?? null,
        verified: c?.verified ?? null,
        companiesInSample: c?.companiesInSample ?? 0,
        companiesTotal: c?.companies ?? null,
        companies: view.companies.filter((x) => x.audienceId === g.id),
        people: view.prospects.filter((x) => x.audienceId === g.id),
      });
    });
    return view;
  }
  const apollo = await apolloFor(orgId);
  if (!apollo) return empty("not-connected");
  try {
    const counts: MarketView["groups"] = [];
    const sample: ApolloPerson[] = [];
    const sampleGroup: string[] = [];
    const companies: MarketCompany[] = [];
    for (const [i, g] of groups.entries()) {
      hooks.groupStart?.(g, i, groups.length);
      const f = groupFilters(g);
      const all = await apollo.searchPeople(f, 1, 25);
      const ver = await apollo.searchPeople({ ...f, contact_email_status: ["verified"] }, 1, 1);
      await addUsage(orgId, "searches", 2);
      let companyTotal: number | null = null;
      if (features.accurateCompanyCount && apollo.countOrganizations) {
        companyTotal = await apollo.countOrganizations(orgFilters(g));
        await addUsage(orgId, "searches", 1);
      }
      const skip = new Set(g.excludeDomains.map(normalizeDomain));
      const kept = all.people.filter((p) => !skip.has(normalizeDomain(p.organization?.primary_domain ?? p.organization?.website_url ?? "")));
      const groupCompanies = companiesFrom(kept, g.id);
      counts.push({ id: g.id, count: all.totalEntries, verified: ver.totalEntries, companiesInSample: groupCompanies.length, companies: companyTotal });
      sample.push(...kept);
      sampleGroup.push(...kept.map(() => g.id));
      for (const c of groupCompanies) if (!companies.some((x) => (x.domain ?? x.name) === (c.domain ?? c.name))) companies.push(c);
      hooks.groupDone?.({
        group: g,
        index: i,
        total: groups.length,
        count: all.totalEntries,
        verified: ver.totalEntries,
        companiesInSample: groupCompanies.length,
        companiesTotal: companyTotal,
        companies: groupCompanies,
        people: kept.map((p) => personOf(p, g.id)),
      });
    }
    const sum = (k: "count" | "verified") => (counts.every((c) => c[k] !== null) ? counts.reduce((s, c) => s + (c[k] ?? 0), 0) : null);
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
      prospects: pickProspects(sample.map((p, i) => personOf(p, sampleGroup[i]))),
      companies: companies.slice(0, 60),
      checkedAt: new Date().toISOString(),
    };
    await prisma.onboarding.update({ where: { organizationId: orgId }, data: { market: { ...view, key } as unknown as Prisma.InputJsonValue } });
    return view;
  } catch (err) {
    const e = err as { status?: number; message?: string; body?: unknown };
    logger.warn({ orgId, status: e.status, err: e.message, body: e.body }, "market lookup failed");
    await logSystem(orgId, "WARN", "lead-search", `The market lookup failed: ${e.status ? `HTTP ${e.status} ` : ""}${(e.message ?? "").slice(0, 200)}`);
    return empty("lookup-failed");
  }
}

export type KeywordState = "ok" | "none" | "broad";

export interface KeywordCountsView {
  available: boolean;
  reason: string | null;
  groupId: string;
  baseline: number | null;
  keywords: { keyword: string; count: number | null; state: KeywordState | null }[];
}

// A keyword is "too broad" when most people the audience's other filters find also match it,
// so it barely narrows the search.
export const BROAD_SHARE = 0.5;
export const BROAD_MIN = 500;
const COUNT_TTL_MS = 24 * 3600_000;
const countCache = new Map<string, { n: number | null; at: number }>();

async function cachedCount(orgId: string, apollo: NonNullable<Awaited<ReturnType<typeof apolloFor>>>, filters: Record<string, unknown>): Promise<number | null> {
  const key = sha256(JSON.stringify([orgId, filters]));
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.at < COUNT_TTL_MS) return hit.n;
  const res = await apollo.searchPeople(filters, 1, 1);
  await addUsage(orgId, "searches", 1);
  if (countCache.size >= 2000) countCache.delete(countCache.keys().next().value!);
  countCache.set(key, { n: res.totalEntries, at: Date.now() });
  return res.totalEntries;
}

export function keywordState(count: number | null, baseline: number | null): KeywordState | null {
  if (count === null) return null;
  if (count === 0) return "none";
  if (baseline && count >= BROAD_MIN && count / baseline >= BROAD_SHARE) return "broad";
  return "ok";
}

/** People each keyword finds on its own inside one audience, for the chip badges and warnings. */
export async function keywordCounts(orgId: string, groupId: string): Promise<KeywordCountsView> {
  const o = await load(orgId);
  const g = groupsOf(o).find((x) => x.id === groupId);
  if (!g) throw notFound("Audience");
  const view = (reason: string | null, baseline: number | null = null, counts: (number | null)[] = []): KeywordCountsView => ({
    available: reason === null,
    reason,
    groupId,
    baseline,
    keywords: g.keywords.map((keyword, i) => ({ keyword, count: counts[i] ?? null, state: reason === null ? keywordState(counts[i] ?? null, baseline) : null })),
  });
  const apollo = await apolloFor(orgId);
  if (!apollo) return view("not-connected");
  const base = groupFilters({ ...g, keywords: [] });
  delete base.q_organization_keyword_tags;
  try {
    const baseline = await cachedCount(orgId, apollo, base);
    const counts: (number | null)[] = [];
    for (const k of g.keywords) counts.push(await cachedCount(orgId, apollo, { ...base, q_organization_keyword_tags: [k] }));
    return view(null, baseline, counts);
  } catch (err) {
    const e = err as { status?: number; message?: string };
    logger.warn({ orgId, status: e.status, err: e.message }, "keyword counts failed");
    return view("lookup-failed");
  }
}

const EMAIL_SCHEMA = {
  name: "email_sequence",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["emails"],
    properties: {
      emails: { type: "array", items: { type: "object", additionalProperties: false, required: ["subject", "body"], properties: { subject: { type: "string" }, body: { type: "string" } } } },
    },
  },
};
const MERGE_TOKENS = new Set(["first_name", "company", "similar_company"]);

/** Rule breaks a sample email can't ship with: numbers the sender never published, and merge tokens we can't fill. */
export function emailProblems(emails: { subject?: string; body?: string }[], allowedText: string): string[] {
  const allowed = allowedText.replace(/,/g, "");
  const out = new Set<string>();
  for (const e of emails) {
    const text = `${e.subject ?? ""} ${e.body ?? ""}`;
    for (const n of numbersIn(text.replace(/\{\{\w+\}\}/g, ""))) if (!allowed.includes(n)) out.add(`"${n}" is not a number the sender published; remove it or use only numbers from the proof`);
    for (const m of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) if (!MERGE_TOKENS.has(m[1])) out.add(`{{${m[1]}}} is not an allowed merge token; use only {{first_name}}, {{company}} and {{similar_company}}`);
  }
  return [...out];
}

/** Drops sentences with invented numbers and unknown merge tokens. */
export function cleanEmail(text: string, allowedText: string): string {
  const allowed = allowedText.replace(/,/g, "");
  return text
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (MERGE_TOKENS.has(k) ? `{{${k}}}` : ""))
    .split(/\n/)
    .map((line) =>
      (line.match(/[^.!?]+[.!?]*\s*/g) ?? [line])
        .filter((sentence) => numbersIn(sentence.replace(/\{\{\w+\}\}/g, "")).every((n) => allowed.includes(n)))
        .join("")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function preview(orgId: string, hooks: { email?: (index: number, email: PreviewEmail) => void } = {}) {
  const o = await load(orgId);
  if (!o.summary) throw unprocessable("Run the business analysis first");
  const settings = await getSettings(orgId);
  const groups = groupsOf(o).filter((g) => g.on);
  const icp = icpOf(o);
  const ai = requireAi();
  // Written for the audience we'd run first: a sequence aimed at one buyer reads sharper than one blended across all of them.
  const lead = [...groups].sort((a, b) => a.priority - b.priority)[0];
  const bd = analysisOf(o)?.brandDetail;
  const proof = [...(bd?.proof ?? []), ...(bd?.differentiators ?? [])].map((x) => x.text).filter(Boolean).slice(0, 4);
  const offers = (bd?.offerings ?? []).slice(0, 4);
  const who = lead
    ? `${lead.name}: ${lead.description || lead.why}
Titles: ${lead.titles.join(", ") || "decision makers"}
Why they buy: ${lead.why || "n/a"}
Pains: ${lead.pains.join("; ") || "n/a"}
Goals: ${lead.goals.join("; ") || "n/a"}
Likely objections: ${lead.objections.join("; ") || "n/a"}`
    : `Titles ${icp.titles.join(", ") || "decision makers"}; regions ${icp.regions.join(", ") || "any"}`;
  const prompt = `Write a three step cold email sequence from ${o.brand} (${o.domain}).

ABOUT THE SENDER
What they do: ${o.summary}
${offers.length ? `What they offer: ${offers.join("; ")}\n` : ""}${settings.valueProp ? `Value: ${settings.valueProp}\n` : ""}${proof.length ? `Proof from their own site (use at most one, in plain words, never add numbers that are not written here): ${proof.join(" | ")}\n` : ""}
WHO RECEIVES IT
${who}

HOW TO WRITE IT
Write like a sharp peer in the same industry, not a marketer. Short sentences, plain words, one idea per email.
Open with the reader's world (their role, a pain they already feel). Never open with "I", "We", "My name", "Hope" or "I noticed".
Email 1 (day 1): 50 to 80 words. Name one pain in the reader's words, say in one sentence what ${o.brand} does about it, add one piece of proof if you have it, and end with one easy question about interest, not a meeting request.
Email 2 (day 3): 30 to 60 words. A different pain or angle, and the concrete outcome they would get.
Email 3 (day 7): 20 to 40 words. A short, friendly last note that makes a one-word reply easy.
Subject for email 1: 2 to 5 words, lowercase apart from names, no punctuation, no hype.
Use the literal merge tokens {{first_name}} and {{company}} where the prospect's details go, and {{similar_company}} at most once.
Never use: "just checking in", "circling back", "touch base", "reach out", "quick chat", "hope this finds you", "clutter your inbox", "game changer", "revolutionize", "streamline", exclamation marks or em-dashes.
Plain text, no links, no invented customers, numbers or results, no sign-off (a signature is added).
LANGUAGE: ${settings.language === "en" ? "English" : settings.language}.
Return STRICT JSON: {"emails":[{"subject":"...","body":"..."},{"subject":"...","body":"..."},{"subject":"...","body":"..."}]}`;
  // Numbers the sender actually published. Anything else in an email would be invented.
  const allowedText = [o.summary, settings.valueProp ?? "", ...offers, ...proof, who].join(" ");
  let emails: { subject?: string; body?: string }[] = [];
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const ask = attempt && problems.length ? `${prompt}\n\nYOUR LAST DRAFT BROKE THESE RULES, FIX THEM AND KEEP EVERYTHING ELSE:\n- ${problems.join("\n- ")}` : prompt;
    const out = await ai.generateJSON<{ emails?: { subject?: string; body?: string }[] }>(ask, { maxTokens: 6000, temperature: 0.6, effort: "low", schema: EMAIL_SCHEMA, model: env.OPENAI_ANALYSIS_MODEL });
    await addUsage(orgId, "aiCalls");
    emails = (out?.emails ?? []).slice(0, 3);
    if (emails.length < 3 || emails.some((e) => !e.body)) continue;
    problems = emailProblems(emails, allowedText);
    if (!problems.length) break;
  }
  if (emails.length < 3 || emails.some((e) => !e.body)) throw upstream("AI preview", "the preview could not be written, please retry");
  // Whatever still breaks the rules after a second try is cut rather than shown.
  emails = emails.map((e) => ({ subject: cleanEmail(String(e.subject ?? ""), allowedText), body: cleanEmail(String(e.body ?? ""), allowedText) }));
  const meta: [string, string][] = [["Intro", "Day 1"], ["Follow up", "Day 3"], ["Last note", "Day 7"]];
  const previewEmails: PreviewEmail[] = emails.map((e, i) => ({
    tab: meta[i][0],
    day: meta[i][1],
    subject: i === 0 ? lintEmail(String(e.subject ?? ""), 12) : `Re: ${lintEmail(String(emails[0].subject ?? ""), 12)}`,
    body: lintEmail(String(e.body ?? ""), 120),
  }));
  previewEmails.forEach((e, i) => hooks.email?.(i, e));
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
        apolloFilters: (groupsOf(o).some((g) => g.on) ? filtersForGroups(groupsOf(o).filter((g) => g.on)) : apolloFiltersFromIcp(icp)) as Prisma.InputJsonValue,
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
  } else if (!settings.smartleadMailboxIds.length && !features.infraforge) {
    // With Infraforge the inboxes are created, warmed and attached automatically, so there is nothing to ask for.
    missing.push("Connect your sending mailboxes in Settings → Sending so the campaign can start sending");
  }
  if (!features.ai) missing.push("AI personalization is not configured on this server");
  if (!o.launchedAt) await prisma.onboarding.update({ where: { organizationId: orgId }, data: { launchedAt: new Date() } });
  return { campaignId: campaign.id, provisioned, missing, state: await getState(orgId) };
}
