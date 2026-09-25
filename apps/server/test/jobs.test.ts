import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, resetDb, FakeSmartlead } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setSmartleadFactory } from "../src/integrations/smartlead.js";
import { setVerifierFactory } from "../src/integrations/verifier.js";
import { pushQueue, verifyNew } from "../src/jobs/send.js";
import { retireNonResponders, reconcile } from "../src/jobs/blocklist.js";
import { followUpSweep } from "../src/jobs/replySync.js";
import { recordMessage } from "../src/domain/messages.js";

describe("job trigger endpoint", () => {
  beforeEach(resetDb);

  it("requires the jobs secret and runs a named job under a lock", async () => {
    await api().post("/api/v1/jobs/send/run").expect(401);
    await api().post("/api/v1/jobs/unknown/run").set("X-Jobs-Secret", "test-jobs-secret").expect(404);
    const res = await api().post("/api/v1/jobs/blocklist/run").set("X-Jobs-Secret", "test-jobs-secret");
    expect(res.status).toBe(200);
    expect(res.body.data.ran).toBe(true);
    const list = await api().get("/api/v1/jobs").set("X-Jobs-Secret", "test-jobs-secret");
    expect(list.body.data.map((j: { name: string }) => j.name)).toContain("auto-reply-dispatch");
  });
});

describe("send job", () => {
  let fake: FakeSmartlead;
  beforeEach(async () => {
    await resetDb();
    fake = new FakeSmartlead();
    setSmartleadFactory(async () => fake);
  });

  it("pushes approved, personalized leads up to the daily cap and records the send", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false, defaultDailySendCap: 2, smartleadMailboxIds: [1, 2] } });
    const campaign = await makeCampaign(t.orgId, { smartleadCampaignId: "sl-9" });
    for (let i = 0; i < 3; i++) await makeContact(t.orgId, { campaignId: campaign.id, status: "PERSONALIZED", personalization: `Body ${i}`, messageSubject: `Subject ${i}`, verifyResult: "ok" });
    await makeContact(t.orgId, { campaignId: campaign.id, status: "NEW" });
    const r = await pushQueue(t.orgId);
    expect(r.pushed).toBe(2);
    const add = fake.calls.find((c) => c.method === "addLeads")!;
    const leads = add.args[1] as { custom_fields: Record<string, string> }[];
    expect(leads).toHaveLength(2);
    expect(leads[0].custom_fields.ai_body).toMatch(/^Body/);
    expect(await prisma.contact.count({ where: { organizationId: t.orgId, status: "CONTACTED", smartleadCampaignId: "sl-9" } })).toBe(2);
    expect(await prisma.message.count({ where: { organizationId: t.orgId, via: "sequence" } })).toBe(2);
    expect((await pushQueue(t.orgId)).reason).toBe("daily-cap-reached");
  });

  it("holds leads from unapproved weeks and from companies already in conversation", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false, defaultDailySendCap: 50 } });
    const campaign = await makeCampaign(t.orgId, { smartleadCampaignId: "sl-9" });
    const review = await prisma.weeklyBatch.create({ data: { organizationId: t.orgId, weekStart: new Date("2030-01-07"), status: "REVIEW" } });
    await makeContact(t.orgId, { campaignId: campaign.id, status: "PERSONALIZED", batchId: review.id, personalization: "x" });
    await makeContact(t.orgId, { email: "a@talking.com", emailNormalized: "a@talking.com", companyDomain: "talking.com", status: "REPLIED" });
    await makeContact(t.orgId, { email: "b@talking.com", emailNormalized: "b@talking.com", companyDomain: "talking.com", campaignId: campaign.id, status: "PERSONALIZED", personalization: "x" });
    const r = await pushQueue(t.orgId);
    expect(r.pushed).toBe(0);
    expect(fake.calls.find((c) => c.method === "addLeads")).toBeUndefined();
  });

  it("never exceeds the plan's daily volume", async () => {
    const t = await createTenant({ planId: "launch" });
    await prisma.subscription.update({ where: { organizationId: t.orgId }, data: { dailyVolume: 3 } });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false, defaultDailySendCap: 100 } });
    const campaign = await makeCampaign(t.orgId, { smartleadCampaignId: "sl-9" });
    for (let i = 0; i < 6; i++) await makeContact(t.orgId, { campaignId: campaign.id, status: "PERSONALIZED", personalization: "x" });
    expect((await pushQueue(t.orgId)).pushed).toBe(3);
  });

  it("verifies new leads and drops invalid ones", async () => {
    const t = await createTenant();
    setVerifierFactory(async () => async (email: string) =>
      email.startsWith("bad") ? { configured: true, ok: false, bad: true, transient: false, result: "invalid", quality: "bad" } : { configured: true, ok: true, bad: false, transient: false, result: "ok", quality: "good" },
    );
    const good = await makeContact(t.orgId, { email: "good@x.com", emailNormalized: "good@x.com" });
    const bad = await makeContact(t.orgId, { email: "bad@gmail.com", emailNormalized: "bad@gmail.com", companyDomain: null, domain: "gmail.com" });
    const r = await verifyNew(t.orgId);
    expect(r).toEqual({ good: 1, dropped: 1 });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: good.id } })).verifyResult).toBe("ok");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe("BOUNCED");
    expect(await prisma.blocklistEntry.count({ where: { entryType: "DOMAIN", value: "gmail.com" } })).toBe(0);
  });
});

describe("blocklist job", () => {
  beforeEach(resetDb);

  it("retires non-responders only after Smartlead confirms they were emailed", async () => {
    const t = await createTenant();
    const fake = new FakeSmartlead();
    fake.statuses = new Map([["lead-sent", "COMPLETED"], ["lead-queued", "STARTED"]]);
    setSmartleadFactory(async () => fake);
    const old = new Date(Date.now() - 20 * 86_400_000);
    const sent = await makeContact(t.orgId, { status: "CONTACTED", firstContactedAt: old, lastContactedAt: old, smartleadCampaignId: "sl-1", smartleadLeadId: "lead-sent" });
    const queued = await makeContact(t.orgId, { status: "CONTACTED", firstContactedAt: old, lastContactedAt: old, smartleadCampaignId: "sl-1", smartleadLeadId: "lead-queued" });
    const r = await retireNonResponders(t.orgId);
    expect(r).toMatchObject({ retired: 1, skippedUnsent: 1 });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("BLOCKLISTED");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("CONTACTED");
    expect(await prisma.blocklistEntry.count({ where: { entryType: "DOMAIN" } })).toBe(0);
  });

  it("reconciles contacts that match a hard rule but never lets a pacing rule override a reply", async () => {
    const t = await createTenant();
    const a = await makeContact(t.orgId, { email: "a@x.com", emailNormalized: "a@x.com" });
    const replied = await makeContact(t.orgId, { email: "b@x.com", emailNormalized: "b@x.com", status: "REPLIED", repliedAt: new Date() });
    await prisma.blocklistEntry.createMany({
      data: [
        { organizationId: t.orgId, entryType: "EMAIL", value: "a@x.com", reason: "UNSUBSCRIBED" },
        { organizationId: t.orgId, entryType: "EMAIL", value: "b@x.com", reason: "NO_RESPONSE" },
      ],
    });
    expect(await reconcile(t.orgId)).toBe(1);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("BLOCKLISTED");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: replied.id } })).status).toBe("REPLIED");
  });
});

describe("follow-up sweep", () => {
  beforeEach(resetDb);

  it("flags due away and not-now leads", async () => {
    const t = await createTenant();
    const c = await makeContact(t.orgId, { status: "REPLIED", replyClass: "away", followUpAt: new Date(Date.now() - 1000) });
    await recordMessage(prisma, { organizationId: t.orgId, contactId: c.id, direction: "INBOUND", body: "Out of office" });
    const r = await followUpSweep(t.orgId);
    expect(r.due).toBe(1);
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.replyUrgent).toBe(true);
    expect(after.followUpAt).toBeNull();
  });
});
