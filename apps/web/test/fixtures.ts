import type { Catalogue, OnboardingState, Session } from "@/lib/types";

export const catalogue: Catalogue = {
  plans: [
    { id: "launch", name: "Launch", maxDailyVolume: 500, priceMonthlyCents: 7900, maxCampaigns: 1, features: [] },
    { id: "growth", name: "Growth", maxDailyVolume: 2000, priceMonthlyCents: 19900, maxCampaigns: null, features: [] },
    { id: "scale", name: "Scale", maxDailyVolume: 5000, priceMonthlyCents: 44900, maxCampaigns: null, features: [] },
  ],
  sizing: {
    sendsPerWarmInbox: 40,
    warmupStartPerInbox: 10,
    inboxPriceCents: 400,
    maxInboxesPerDomain: 5,
    warmupOptions: [14, 21, 28],
    volumeMin: 100,
    volumeMax: 5000,
    tldPricesCents: { com: 1499 },
    campaignStart: { lo: 10, hi: 15, rampDays: 14 },
    fastStart: { days: 3, lo: 15, hi: 20, rampDays: 7, available: false, inboxPriceCents: null },
  },
};

export const session: Session = {
  accessToken: "token-1",
  expiresIn: 900,
  user: { id: "u1", email: "alex@northwind.io", name: "Alex Morgan", isPlatformAdmin: false },
  organizations: [{ id: "org1", name: "Northwind", role: "OWNER", primaryDomain: "northwind.io" }],
  activeOrganizationId: "org1",
};

export function onboardingState(over: Partial<OnboardingState> = {}): OnboardingState {
  return {
    onboarding: {
      id: "ob1",
      domain: "northwind.io",
      brand: "Northwind",
      summary: null,
      icp: { industries: [], titles: [], sizes: [], regions: [] },
      preview: null,
      volume: 1000,
      warmupDays: 14,
      inboxesPerDomain: 3,
      provider: "google",
      analyzedAt: null,
      analysisError: null,
      paidAt: null,
      launchedAt: null,
      facts: [],
      groups: [],
      senders: [{ first: "Alex", last: "Morgan" }],
      siteReadable: null,
      fastStart: false,
    },
    domains: [],
    mailboxes: [],
    subscription: null,
    campaign: null,
    senderName: null,
    aiAvailable: false,
    sizeOptions: [],
    ...over,
  };
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
