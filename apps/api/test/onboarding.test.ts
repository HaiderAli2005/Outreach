import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, resetDb, fakeAi, FakeSmartlead } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setAiClient } from "../src/integrations/ai.js";
import { setSmartleadFactory } from "../src/integrations/smartlead.js";
import { setDomainChecker } from "../src/modules/onboarding/domainIdeas.js";
import { setSiteReader } from "../src/integrations/site.js";
import { setApolloFactory } from "../src/integrations/apollo.js";
import { features } from "../src/config/env.js";

describe("onboarding", () => {
  beforeEach(resetDb);

  it("starts setup from a domain and validates it", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "not a domain" }).expect(400);
    const res = await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "HTTPS://www.Northwind.io/pricing" });
    expect(res.body.data.onboarding).toMatchObject({ domain: "northwind.io", brand: "Northwind" });
  });

  it("reports AI as unavailable instead of inventing an analysis", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth);
    expect(res.status).toBe(503);
  });

  it("reports an unreadable site so the user can answer questions instead", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    setAiClient(fakeAi({}));
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200);
    expect(res.body.data.onboarding).toMatchObject({ siteReadable: false, analyzedAt: null });
    const built = await api().post("/api/v1/onboarding/answers").set(t.auth).send({ sell: "Next-day pallet delivery", who: "Operations managers at online retailers", regions: [] });
    expect(built.status).toBe(400);
    setAiClient(null);
    const ok = await api().post("/api/v1/onboarding/answers").set(t.auth).send({ sell: "Next-day pallet delivery", who: "Operations managers at online retailers", regions: ["United Kingdom"] }).expect(200);
    const o = ok.body.data.onboarding;
    expect(o.facts.find((f: { key: string }) => f.key === "sell")).toMatchObject({ value: "Next-day pallet delivery", source: "from your answers" });
    expect(o.groups).toHaveLength(1);
    expect(o.groups[0]).toMatchObject({ titles: ["Operations manager"], regions: ["United Kingdom"], on: true });
    expect(o.icp.titles).toEqual(["Operations manager"]);
  });

  it("stores facts with their source page, buyer groups and a brand profile", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    setSiteReader(async () => ({ home: { title: "Northwind | Invoicing", description: null }, pages: [{ path: "/", title: "Northwind", text: "Invoicing for agencies" }, { path: "/services", title: "Services", text: "We send invoices" }] }));
    setAiClient(
      fakeAi({
        company: { value: "Northwind", source: "homepage title" },
        sell: { value: "Invoicing software for agencies.", source: "/services" },
        who: { value: "Marketing agencies.", source: "/nowhere" },
        value_prop: "Get paid faster",
        language: "en",
        groups: [
          { name: "Marketing agencies", why: "They bill many clients.", pains: ["Late payments"], titles: ["Founder or CEO"], sizes: ["11 to 50", "bogus"], regions: ["United Kingdom"], keywords: ["marketing agency"] },
          { name: "", titles: ["x"] },
        ],
      }),
    );
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200);
    const o = res.body.data.onboarding;
    expect(o.facts.map((f: { key: string; source: string }) => [f.key, f.source])).toEqual([["company", "homepage title"], ["sell", "/services"], ["who", "/"]]);
    expect(o.groups).toHaveLength(1);
    expect(o.icp).toEqual({ industries: ["marketing agency"], titles: ["Founder or CEO"], sizes: ["11 to 50"], regions: ["United Kingdom"] });
    const s = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(s.valueProp).toBe("Get paid faster");
    const off = await api().patch("/api/v1/onboarding").set(t.auth).send({ groups: [{ id: "g1", on: false }], facts: [{ key: "company", value: "Northwind Ltd" }] }).expect(200);
    expect(off.body.data.onboarding.icp.titles).toEqual([]);
    expect(off.body.data.onboarding.brand).toBe("Northwind Ltd");
  });

  it("sizes the market from lead search without inventing numbers", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    await api().post("/api/v1/onboarding/answers").set(t.auth).send({ sell: "Pallet delivery", who: "Operations managers", regions: ["United Kingdom"] }).expect(200);
    const none = await api().get("/api/v1/onboarding/market").set(t.auth).expect(200);
    expect(none.body.data).toMatchObject({ available: false, reason: "not-connected", people: null });
    const calls: Record<string, unknown>[] = [];
    setApolloFactory(async () => ({
      async searchPeople(filters: Record<string, unknown>) {
        calls.push(filters);
        return filters.contact_email_status
          ? { people: [], totalEntries: 300 }
          : { people: [{ first_name: "Sam", last_name: "Price", title: "Head of Operations", country: "United Kingdom", organization: { name: "Acme", estimated_num_employees: 40 } }], totalEntries: 1200 };
      },
      async bulkEnrich() {
        return [];
      },
    }));
    const res = await api().get("/api/v1/onboarding/market").set(t.auth).expect(200);
    expect(res.body.data).toMatchObject({ available: true, people: 1200, verified: 300 });
    expect(res.body.data.prospects[0]).toMatchObject({ firstName: "Sam", lastInitial: "P", company: "Acme" });
    expect(res.body.data.sample.bySize).toEqual([["11–50 staff", 1]]);
    await api().get("/api/v1/onboarding/market").set(t.auth).expect(200);
    expect(calls).toHaveLength(2);
  });

  it("offers lookalike domains, rejects taken or foreign ones and plans inboxes", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { senderName: "Alex Morgan" } });
    setDomainChecker(async (d) => d === "trynorthwind.com");
    const ideas = await api().get("/api/v1/onboarding/domains/ideas?limit=4").set(t.auth);
    expect(ideas.body.data.ideas[0]).toMatchObject({ name: "getnorthwind.com", available: true, priceCents: 1499 });
    expect(ideas.body.data.ideas[1]).toMatchObject({ name: "trynorthwind.com", available: false });
    await api().put("/api/v1/onboarding/domains").set(t.auth).send({ domains: [{ name: "evil.com", inboxes: 3 }] }).expect(400);
    await api().put("/api/v1/onboarding/domains").set(t.auth).send({ domains: [{ name: "trynorthwind.com", inboxes: 3 }] }).expect(422);
    const saved = await api().put("/api/v1/onboarding/domains").set(t.auth).send({ domains: [{ name: "getnorthwind.com", inboxes: 3 }, { name: "northwindhq.com", inboxes: 2 }] });
    expect(saved.status).toBe(200);
    const boxes = await prisma.mailbox.findMany({ where: { organizationId: t.orgId }, orderBy: { address: "asc" } });
    expect(boxes.map((b) => b.address)).toEqual(expect.arrayContaining(["alex@getnorthwind.com", "alex.m@getnorthwind.com", "alexm@getnorthwind.com", "a.morgan@northwindhq.com", "alex.morgan@northwindhq.com"]));
    expect(boxes).toHaveLength(5);
  });

  it("launches only with an active subscription and provisions sending when mailboxes are connected", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    await prisma.onboarding.update({ where: { organizationId: t.orgId }, data: { summary: "x", icp: { industries: ["SaaS"], titles: ["CEO"], sizes: ["11 to 50"], regions: ["UK"] } } });
    await api().post("/api/v1/onboarding/launch").set(t.auth).expect(402);
    await prisma.subscription.create({ data: { organizationId: t.orgId, planId: "growth", status: "ACTIVE", dailyVolume: 800, inboxQuantity: 20 } });
    const fake = new FakeSmartlead();
    setSmartleadFactory(async () => fake);
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { smartleadMailboxIds: [11, 12] } });
    const res = await api().post("/api/v1/onboarding/launch").set(t.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.provisioned).toMatchObject({ smartleadCampaignId: "sl-new", mailboxes: 2 });
    const campaign = await prisma.campaign.findFirstOrThrow({ where: { organizationId: t.orgId } });
    expect(campaign).toMatchObject({ status: "ACTIVE", smartleadCampaignId: "sl-new", dailySendCap: 800 });
    expect((campaign.apolloFilters as { person_titles: string[] }).person_titles).toEqual(["CEO"]);
    expect(fake.calls.map((c) => c.method)).toEqual(expect.arrayContaining(["createCampaign", "saveSequence", "attachMailboxes", "registerWebhook", "setStatus"]));
    const seq = fake.calls.find((c) => c.method === "saveSequence")!.args[1] as { email_body: string }[];
    expect(seq[0].email_body).toContain("{{ai_body}}");
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(settings.autopilotEnabled).toBe(true);
    void features;
  });
});
