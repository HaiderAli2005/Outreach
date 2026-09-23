import { env } from "./env.js";

export const SENDS_PER_WARM_INBOX = 40;
export const WARMUP_START_PER_INBOX = 5;
export const INBOX_PRICE_CENTS = 400;
export const MAX_INBOXES_PER_DOMAIN = 5;
export const WARMUP_OPTIONS = [14, 21, 28] as const;
export const VOLUME_MIN = 100;
export const VOLUME_MAX = 5000;

export const TLD_PRICES_CENTS: Record<string, number> = {
  ".com": 1499,
  ".co": 2499,
  ".io": 3499,
  ".net": 1599,
};

export interface PlanDefinition {
  id: string;
  name: string;
  maxDailyVolume: number;
  priceMonthlyCents: number;
  maxCampaigns: number | null;
  features: string[];
  stripePriceId: string | undefined;
  sortOrder: number;
}

export const PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    id: "launch",
    name: "Launch",
    maxDailyVolume: 500,
    priceMonthlyCents: 7900,
    maxCampaigns: 1,
    features: ["1 campaign at a time", "Audience analysis", "Standard warmup"],
    stripePriceId: env.STRIPE_PRICE_LAUNCH,
    sortOrder: 1,
  },
  {
    id: "growth",
    name: "Growth",
    maxDailyVolume: 2000,
    priceMonthlyCents: 19900,
    maxCampaigns: null,
    features: ["Unlimited campaigns", "Reply sorting", "Adaptive warmup"],
    stripePriceId: env.STRIPE_PRICE_GROWTH,
    sortOrder: 2,
  },
  {
    id: "scale",
    name: "Scale",
    maxDailyVolume: 5000,
    priceMonthlyCents: 44900,
    maxCampaigns: null,
    features: ["Everything in Growth", "Dedicated IP pools", "Priority support"],
    stripePriceId: env.STRIPE_PRICE_SCALE,
    sortOrder: 3,
  },
];

export function recommendedInboxes(volume: number): number {
  return Math.ceil(volume / SENDS_PER_WARM_INBOX);
}

export function recommendedDomains(volume: number, inboxesPerDomain: number): number {
  return Math.ceil(recommendedInboxes(volume) / Math.max(1, inboxesPerDomain));
}

export function planIdForVolume(volume: number): string {
  const sorted = [...PLAN_DEFINITIONS].sort((a, b) => a.maxDailyVolume - b.maxDailyVolume);
  return (sorted.find((p) => volume <= p.maxDailyVolume) ?? sorted[sorted.length - 1]).id;
}

export function tldPriceCents(domain: string): number | null {
  const tld = domain.slice(domain.indexOf("."));
  return TLD_PRICES_CENTS[tld] ?? null;
}
