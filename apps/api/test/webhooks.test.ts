import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, resetDb, fakeAi } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setAiClient } from "../src/integrations/ai.js";
import { recordMessage } from "../src/domain/messages.js";

const url = "/api/v1/webhooks/smartlead?token=test-webhook-secret";

async function setup() {
  const t = await createTenant();
  const campaign = await makeCampaign(t.orgId, { smartleadCampaignId: "9001" });
  const contact = await makeContact(t.orgId, { email: "ann@acme.com", emailNormalized: "ann@acme.com", companyDomain: "acme.com", status: "CONTACTED", campaignId: campaign.id, firstContactedAt: new Date() });
  await recordMessage(prisma, { organizationId: t.orgId, contactId: contact.id, direction: "OUTBOUND", via: "sequence", body: "Our first email" });
  return { t, campaign, contact };
}

describe("smartlead webhooks", () => {
  beforeEach(resetDb);

  it("requires the shared token", async () => {
    await api().post("/api/v1/webhooks/smartlead").send({}).expect(401);
    await api().post("/api/v1/webhooks/smartlead?token=wrong").send({}).expect(401);
  });

  it("records a reply, revives the lead and classifies it", async () => {
    const { t, contact } = await setup();
    setAiClient(fakeAi({ class: "hot", confidence: 0.92, draft: "Hi Ann,\nGreat question, Tuesday works for a short call to go through it.", language: "en", sentiment: "positive", needs_human: false }));
    const res = await api().post(url).send({ event_type: "EMAIL_REPLY", campaign_id: 9001, sl_lead_email: "Ann@Acme.com", sl_email_lead_id: 77, email_stats_id: "st-1", reply_message: { text: "Sounds interesting, can we talk next week?\n\nOn Mon, Alex wrote:\n> Our first email" } });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("reply");
    await new Promise((r) => setTimeout(r, 300));
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.status).toBe("REPLIED");
    expect(after.smartleadLeadId).toBe("77");
    expect(after.replyClass).toBe("hot");
    expect(after.replyUrgent).toBe(true);
    expect(after.aiDraft).toContain("Tuesday");
    const msg = await prisma.message.findFirstOrThrow({ where: { contactId: contact.id, direction: "INBOUND" } });
    expect(msg.intent).toBe("hot");
    expect((await api().get("/api/v1/dashboard/nav-counts").set(t.auth)).body.data.inboxAwaiting).toBe(1);
  });

  it("ignores a duplicate delivery of the same event", async () => {
    await setup();
    const body = { event_type: "EMAIL_REPLY", campaign_id: 9001, sl_lead_email: "ann@acme.com", email_stats_id: "st-2", reply_message: { text: "Yes please" } };
    await api().post(url).send(body).expect(200);
    const again = await api().post(url).send(body);
    expect(again.body.data.status).toBe("duplicate");
    expect(await prisma.message.count({ where: { direction: "INBOUND" } })).toBe(1);
  });

  it("suppresses the company on unsubscribe and cancels queued replies", async () => {
    const { contact } = await setup();
    const colleague = await makeContact(contact.organizationId, { email: "bo@acme.com", emailNormalized: "bo@acme.com", companyDomain: "acme.com" });
    await prisma.autoReplyQueue.create({ data: { organizationId: contact.organizationId, contactId: contact.id, triggerMessageId: "t1", draft: "x", sendAfter: new Date() } });
    await api().post(url).send({ event_type: "LEAD_UNSUBSCRIBED", campaign_id: 9001, sl_lead_email: "ann@acme.com" }).expect(200);
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.status).toBe("UNSUBSCRIBED");
    expect(after.neverAuto).toBe(true);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: colleague.id } })).status).toBe("BLOCKLISTED");
    expect((await prisma.autoReplyQueue.findFirstOrThrow()).status).toBe("CANCELLED");
  });

  it("marks bounces", async () => {
    const { contact } = await setup();
    await api().post(url).send({ event_type: "EMAIL_BOUNCE", campaign_id: 9001, sl_lead_email: "ann@acme.com" }).expect(200);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).status).toBe("BOUNCED");
  });

  it("treats a manual reply as a human takeover unless it echoes our own send", async () => {
    const { contact } = await setup();
    await recordMessage(prisma, { organizationId: contact.organizationId, contactId: contact.id, direction: "OUTBOUND", via: "auto-reply", body: "auto" });
    const echo = await api().post(url).send({ event_type: "MANUAL_REPLY_SENT", campaign_id: 9001, sl_lead_email: "ann@acme.com", reply_message: { text: "auto" } });
    expect(echo.body.data.status).toBe("echo");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).autoReplyStatus).toBe("AUTO");
    await prisma.message.updateMany({ where: { via: "auto-reply" }, data: { createdAt: new Date(Date.now() - 3_600_000) } });
    const human = await api().post(url).send({ event_type: "MANUAL_REPLY_SENT", campaign_id: 9001, sl_lead_email: "ann@acme.com", reply_message: { text: "Hi Ann, from my phone" } });
    expect(human.body.data.status).toBe("manual-reply");
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.autoReplyStatus).toBe("MANUAL");
    expect(await prisma.message.count({ where: { contactId: contact.id, via: "smartlead-manual" } })).toBe(1);
  });

  it("ignores events for campaigns that belong to nobody", async () => {
    await setup();
    const res = await api().post(url).send({ event_type: "EMAIL_REPLY", campaign_id: 1234, sl_lead_email: "ann@acme.com", reply_message: { text: "hello" } });
    expect(res.body.data.status).toBe("ignored");
    expect(await prisma.message.count({ where: { direction: "INBOUND" } })).toBe(0);
  });
});

describe("calendly webhook", () => {
  beforeEach(resetDb);

  it("stops automation when a meeting is booked", async () => {
    const { t, contact } = await setup();
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: t.orgId } });
    const res = await api().post(`/api/v1/webhooks/calendly/${org.webhookToken}?token=test-webhook-secret`).send({ event: "invitee.created", payload: { email: "ann@acme.com" } });
    expect(res.body.data.status).toBe("booked");
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.meetingBookedAt).not.toBeNull();
    expect(after.autoReplyStatus).toBe("MANUAL");
  });
});
