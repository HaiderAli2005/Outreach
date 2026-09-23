import { beforeEach, describe, expect, it } from "vitest";
import { createTenant, makeCampaign, makeContact, resetDb, fakeAi, FakeSmartlead } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setAiClient } from "../src/integrations/ai.js";
import { setSmartleadFactory } from "../src/integrations/smartlead.js";
import { recordMessage } from "../src/domain/messages.js";
import { runReplyIntelligence } from "../src/domain/replyIntelligence.js";
import { evaluateGates } from "../src/domain/autoReplyGate.js";
import { dispatchForOrg } from "../src/jobs/autoReplyDispatch.js";

async function thread(orgId: string, reply: string, extra: Record<string, unknown> = {}) {
  const campaign = await makeCampaign(orgId);
  const contact = await makeContact(orgId, { email: "sam@firm.com", emailNormalized: "sam@firm.com", companyDomain: "firm.com", status: "REPLIED", campaignId: campaign.id, smartleadCampaignId: "sl-1", smartleadLeadId: "l-1", ...extra });
  await recordMessage(prisma, { organizationId: orgId, contactId: contact.id, direction: "OUTBOUND", via: "sequence", body: "First email", createdAt: new Date(Date.now() - 86_400_000) });
  const msg = await recordMessage(prisma, { organizationId: orgId, contactId: contact.id, direction: "INBOUND", via: "smartlead", body: reply });
  return { contact, msg, campaign };
}

const ZONES = ["Pacific/Kiritimati", "Asia/Tokyo", "Asia/Karachi", "Europe/London", "America/New_York", "America/Los_Angeles", "Pacific/Honolulu", "Pacific/Pago_Pago"];

function weekdayZone(): string {
  for (const tz of ZONES) {
    const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date());
    if (!["Sat", "Sun"].includes(day)) return tz;
  }
  return "UTC";
}

async function liveAgent(orgId: string) {
  await prisma.orgSettings.update({
    where: { organizationId: orgId },
    data: { autoReplyEnabled: true, autoReplyMode: "LIVE", autoReplyWindowStart: 0, autoReplyWindowEnd: 24, timezone: weekdayZone() },
  });
}

const draft = "Hi Sam,\nFair question. The short version is that it depends on your volume, happy to walk you through it on a quick call.";

describe("reply classification actions", () => {
  beforeEach(resetDb);

  it("flags a hot lead with a draft and never sends while autonomy is off", async () => {
    const t = await createTenant();
    const { contact, msg } = await thread(t.orgId, "What does it cost for a team of ten?");
    setAiClient(fakeAi({ class: "question", confidence: 0.95, draft, language: "en", sentiment: "neutral" }));
    const r = await runReplyIntelligence(t.orgId, msg.id);
    expect(r?.class).toBe("question");
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after).toMatchObject({ replyClass: "question", replyUrgent: true });
    expect(await prisma.autoReplyQueue.count()).toBe(0);
    expect(await runReplyIntelligence(t.orgId, msg.id)).toBeNull();
  });

  it("suppresses the company on an opt-out and switches the agent off for good", async () => {
    const t = await createTenant();
    const { contact, msg } = await thread(t.orgId, "Please remove me from your list");
    const colleague = await makeContact(t.orgId, { email: "kim@firm.com", emailNormalized: "kim@firm.com", companyDomain: "firm.com" });
    setAiClient(fakeAi({ class: "stop", confidence: 0.99, language: "en" }));
    await runReplyIntelligence(t.orgId, msg.id);
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after).toMatchObject({ status: "UNSUBSCRIBED", neverAuto: true, replyClass: "stop" });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: colleague.id } })).status).toBe("BLOCKLISTED");
  });

  it("blocks only the person for a bereavement note", async () => {
    const t = await createTenant();
    const { contact, msg } = await thread(t.orgId, "We are sorry to tell you Sam passed away last month.");
    const colleague = await makeContact(t.orgId, { email: "lee@firm.com", emailNormalized: "lee@firm.com", companyDomain: "firm.com" });
    setAiClient(fakeAi({ class: "deceased", confidence: 0.99, language: "en" }));
    await runReplyIntelligence(t.orgId, msg.id);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).status).toBe("BLOCKLISTED");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: colleague.id } })).status).toBe("NEW");
  });

  it("spawns the referred colleague and retires the replier who left", async () => {
    const t = await createTenant();
    const { contact, msg } = await thread(t.orgId, "I've left the company. Please contact jo.doe@firm.com instead.");
    setAiClient(fakeAi({ class: "referral", confidence: 0.9, language: "en", referral: { emails: ["jo.doe@firm.com"], best_email: "jo.doe@firm.com", name: "Jo Doe", replier_gone: true, same_person: false } }));
    await runReplyIntelligence(t.orgId, msg.id);
    const spawned = await prisma.contact.findUniqueOrThrow({ where: { organizationId_emailNormalized: { organizationId: t.orgId, emailNormalized: "jo.doe@firm.com" } } });
    expect(spawned).toMatchObject({ source: "referral", firstName: "Jo", status: "NEW" });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).status).toBe("BLOCKLISTED");
  });

  it("does not spawn addresses the prospect never wrote", async () => {
    const t = await createTenant();
    const { msg } = await thread(t.orgId, "I've left, talk to my old boss.");
    setAiClient(fakeAi({ class: "referral", confidence: 0.9, language: "en", referral: { emails: ["invented@firm.com"], best_email: "invented@firm.com", replier_gone: true } }));
    await runReplyIntelligence(t.orgId, msg.id);
    expect(await prisma.contact.count({ where: { emailNormalized: "invented@firm.com" } })).toBe(0);
  });

  it("schedules a follow-up for an away reply", async () => {
    const t = await createTenant();
    const { contact, msg } = await thread(t.orgId, "I'm on leave until the 12th of next month");
    const back = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    setAiClient(fakeAi({ class: "away", confidence: 0.95, return_date: back, language: "en" }));
    await runReplyIntelligence(t.orgId, msg.id);
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.replyClass).toBe("away");
    expect(after.replyUrgent).toBe(false);
    expect(after.followUpAt?.toISOString().slice(0, 10)).toBe(back);
  });
});

describe("autonomous replies", () => {
  beforeEach(resetDb);

  it("queues a safe reply with the booking link in live mode and sends it through every gate", async () => {
    const t = await createTenant();
    await liveAgent(t.orgId);
    const fake = new FakeSmartlead();
    setSmartleadFactory(async () => fake);
    const { contact, msg } = await thread(t.orgId, "Interesting. How does onboarding work for a small team?");
    setAiClient(fakeAi({ class: "question", confidence: 0.93, draft, language: "en", sentiment: "neutral" }));
    await runReplyIntelligence(t.orgId, msg.id);
    const queued = await prisma.autoReplyQueue.findFirstOrThrow();
    expect(queued.includeLink).toBe(true);
    expect(queued.draft).toBe(draft);
    await prisma.autoReplyQueue.update({ where: { id: queued.id }, data: { sendAfter: new Date(Date.now() - 1000) } });
    const results = await dispatchForOrg(t.orgId);
    expect(results).toEqual(["sent"]);
    const sent = fake.calls.find((c) => c.method === "replyToThread")!;
    expect((sent.args[1] as { emailBody: string }).emailBody).toContain("Fair question");
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.autoReplyCount).toBe(1);
    expect(after.linkSentAt).not.toBeNull();
    expect(await prisma.message.count({ where: { contactId: contact.id, via: "auto-reply" } })).toBe(1);
  });

  it("logs but never queues in shadow mode", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autoReplyEnabled: true, autoReplyMode: "SHADOW" } });
    const { msg } = await thread(t.orgId, "Tell me more about pricing please");
    setAiClient(fakeAi({ class: "question", confidence: 0.93, draft, language: "en" }));
    await runReplyIntelligence(t.orgId, msg.id);
    expect(await prisma.autoReplyQueue.count()).toBe(0);
    expect(await prisma.autoReplyDecision.count({ where: { wouldSend: true, mode: "SHADOW" } })).toBe(1);
  });

  it("hands the thread to a human when the prospect asks for a call at a time", async () => {
    const t = await createTenant();
    await liveAgent(t.orgId);
    const { contact, msg } = await thread(t.orgId, "Yes, call me on Thursday at 3pm");
    setAiClient(fakeAi({ class: "hot", confidence: 0.95, draft, language: "en" }));
    await runReplyIntelligence(t.orgId, msg.id);
    expect(await prisma.autoReplyQueue.count()).toBe(0);
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.autoReplyStatus).toBe("MANUAL");
    expect(after.lastEscalationReason).toBe("wants-scheduling");
  });

  it("escalates low-confidence classifications", async () => {
    const t = await createTenant();
    await liveAgent(t.orgId);
    const { contact, msg } = await thread(t.orgId, "Hmm, maybe, not sure what you mean exactly by that");
    setAiClient(fakeAi({ class: "review", confidence: 0.4, draft, language: "en" }));
    await runReplyIntelligence(t.orgId, msg.id);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).lastEscalationReason).toMatch(/^low-confidence/);
  });

  it("re-checks gates at dispatch and cancels when a human answered meanwhile", async () => {
    const t = await createTenant();
    await liveAgent(t.orgId);
    setSmartleadFactory(async () => new FakeSmartlead());
    const { contact, msg } = await thread(t.orgId, "What integrations do you support today?");
    setAiClient(fakeAi({ class: "question", confidence: 0.93, draft, language: "en" }));
    await runReplyIntelligence(t.orgId, msg.id);
    await recordMessage(prisma, { organizationId: t.orgId, contactId: contact.id, direction: "OUTBOUND", via: "inbox", body: "Answered by hand" });
    await prisma.autoReplyQueue.updateMany({ data: { sendAfter: new Date(Date.now() - 1000) } });
    const results = await dispatchForOrg(t.orgId);
    expect(results[0]).toMatch(/^cancelled:/);
    expect((await prisma.autoReplyQueue.findFirstOrThrow()).status).toBe("CANCELLED");
  });

  it("honours the kill switch", async () => {
    const t = await createTenant();
    await liveAgent(t.orgId);
    const { contact } = await thread(t.orgId, "Sounds good");
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autoReplyKillSwitch: true } });
    const g = await evaluateGates({ orgId: t.orgId, contactId: contact.id });
    expect(g).toMatchObject({ ok: false, reason: "kill-switch" });
  });
});
