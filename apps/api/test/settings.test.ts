import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, resetDb, fakeAi } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setAiClient } from "../src/integrations/ai.js";

describe("settings", () => {
  beforeEach(resetDb);

  it("clamps autonomy dials and the daily cap to the plan", async () => {
    const t = await createTenant({ planId: "launch" });
    await prisma.subscription.update({ where: { organizationId: t.orgId }, data: { dailyVolume: 500 } });
    const res = await api().patch("/api/v1/settings").set(t.auth).send({ autoReplyMinConfidence: 0.1, autoReplyMaxTurns: 999, defaultDailySendCap: 4000 });
    expect(res.status).toBe(200);
    expect(res.body.data.settings).toMatchObject({ autoReplyMinConfidence: 0.5, autoReplyMaxTurns: 30, defaultDailySendCap: 500 });
  });

  it("rejects unknown fields and bad values", async () => {
    const t = await createTenant();
    await api().patch("/api/v1/settings").set(t.auth).send({ isPlatformAdmin: true }).expect(400);
    await api().patch("/api/v1/settings").set(t.auth).send({ timezone: "Mars/Olympus" }).expect(400);
    await api().patch("/api/v1/settings").set(t.auth).send({ meetingLink: "javascript:alert(1)" }).expect(400);
  });

  it("turning auto-reply on needs a booking link and AI, and switches the mode to live", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { meetingLink: null } });
    const noLink = await api().patch("/api/v1/settings").set(t.auth).send({ autoReplyEnabled: true });
    expect(noLink.status).toBe(422);
    await api().patch("/api/v1/settings").set(t.auth).send({ meetingLink: "https://cal.com/me/intro" }).expect(200);
    const noAi = await api().patch("/api/v1/settings").set(t.auth).send({ autoReplyEnabled: true });
    expect(noAi.status).toBe(503);
    setAiClient(fakeAi({}));
    const { features } = await import("../src/config/env.js");
    (features as { ai: boolean }).ai = true;
    const on = await api().patch("/api/v1/settings").set(t.auth).send({ autoReplyEnabled: true });
    expect(on.body.data.settings.autoReplyMode).toBe("LIVE");
    (features as { ai: boolean }).ai = false;
  });

  it("voids queued replies when autonomy is lowered", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autoReplyEnabled: true, autoReplyMode: "LIVE" } });
    const c = await prisma.contact.create({ data: { organizationId: t.orgId, email: "q@q.com", emailNormalized: "q@q.com" } });
    await prisma.autoReplyQueue.create({ data: { organizationId: t.orgId, contactId: c.id, triggerMessageId: "m", draft: "x", sendAfter: new Date() } });
    const res = await api().patch("/api/v1/settings").set(t.auth).send({ autoReplyEnabled: false });
    expect(res.body.data.voidedAutoReplies).toBe(1);
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } })).autoReplyMode).toBe("OFF");
  });

  it("stores integration keys encrypted and only ever returns them masked", async () => {
    const t = await createTenant();
    const res = await api().put("/api/v1/settings/credentials/APOLLO").set(t.auth).send({ value: "apollo-secret-key-1234" });
    expect(res.status).toBe(200);
    const apollo = res.body.data.find((c: { provider: string }) => c.provider === "APOLLO");
    expect(apollo).toMatchObject({ source: "organization", masked: "••••1234" });
    const row = await prisma.integrationCredential.findFirstOrThrow();
    expect(row.ciphertext).not.toContain("apollo-secret");
    const view = await api().get("/api/v1/settings").set(t.auth);
    expect(JSON.stringify(view.body)).not.toContain("apollo-secret-key");
    await api().put("/api/v1/settings/credentials/SLACK_WEBHOOK").set(t.auth).send({ value: "https://evil.example.com/hook" }).expect(400);
  });

  it("stops the engine, pauses sending campaigns and cancels queued replies", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: true, autoReplyMode: "LIVE" } });
    const c = await prisma.contact.create({ data: { organizationId: t.orgId, email: "q@q.com", emailNormalized: "q@q.com" } });
    await prisma.autoReplyQueue.create({ data: { organizationId: t.orgId, contactId: c.id, triggerMessageId: "m2", draft: "x", sendAfter: new Date() } });
    const res = await api().post("/api/v1/engine/stop").set(t.auth);
    expect(res.body.data).toMatchObject({ stopped: true, autoRepliesCancelled: 1 });
    const s = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(s).toMatchObject({ autopilotEnabled: false, autoReplyMode: "OFF" });
  });
});
