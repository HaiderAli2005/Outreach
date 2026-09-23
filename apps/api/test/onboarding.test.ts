import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, resetDb, fakeAi, FakeSmartlead } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setAiClient } from "../src/integrations/ai.js";
import { setSmartleadFactory } from "../src/integrations/smartlead.js";
import { setDomainChecker } from "../src/modules/onboarding/domainIdeas.js";
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

  it("stores the analysis, the audience and a brand profile", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "localhost.invalid" });
    setAiClient(fakeAi({ summary: "Northwind sells invoicing software to agencies.", value_prop: "Get paid faster", industries: ["Marketing agencies"], titles: ["Founder or CEO"], sizes: ["11 to 50", "bogus"], regions: ["United Kingdom"], language: "en" }));
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.onboarding.icp).toEqual({ industries: ["Marketing agencies"], titles: ["Founder or CEO"], sizes: ["11 to 50"], regions: ["United Kingdom"] });
    const s = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(s.valueProp).toBe("Get paid faster");
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
    expect(boxes.map((b) => b.address)).toEqual(expect.arrayContaining(["alex@getnorthwind.com", "alex.m@getnorthwind.com", "a.morgan@getnorthwind.com", "alex@northwindhq.com"]));
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
