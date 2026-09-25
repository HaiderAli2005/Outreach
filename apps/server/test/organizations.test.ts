import { beforeEach, describe, expect, it } from "vitest";
import { api, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { signAccessToken } from "../src/modules/auth/tokens.js";

describe("creating an organization", () => {
  beforeEach(resetDb);

  it("lets a signed-in user without a workspace create one with setup started", async () => {
    const user = await prisma.user.create({ data: { email: "solo@example.com", name: "Solo" } });
    const auth = { Authorization: `Bearer ${signAccessToken({ sub: user.id, org: null, role: null, pa: false })}` };
    await api().post("/api/v1/organizations").set(auth).send({ domain: "not a domain" }).expect(400);
    const res = await api().post("/api/v1/organizations").set(auth).send({ domain: "https://www.acme-labs.io" }).expect(201);
    expect(res.body.data).toMatchObject({ name: "Acme Labs", primaryDomain: "acme-labs.io" });
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: user.id } });
    expect(m.role).toBe("OWNER");
    expect(await prisma.onboarding.count({ where: { organizationId: m.organizationId } })).toBe(1);
    expect(await prisma.orgSettings.count({ where: { organizationId: m.organizationId } })).toBe(1);
  });

  it("requires authentication", async () => {
    await api().post("/api/v1/organizations").send({ name: "x" }).expect(401);
  });
});
