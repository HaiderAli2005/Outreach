import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

function refreshCookie(res: { headers: Record<string, unknown> }): string {
  const cookies = (res.headers["set-cookie"] as string[] | undefined) ?? [];
  const c = cookies.find((x) => x.startsWith("ap_refresh="));
  if (!c) throw new Error("no refresh cookie");
  return c.split(";")[0];
}

describe("authentication", () => {
  beforeEach(resetDb);

  it("registers a user with an organization, owner membership and onboarding", async () => {
    const res = await api().post("/api/v1/auth/register").send({ name: "Alex Morgan", email: "Alex@Example.com", password: "supersecret1", domain: "https://www.northwind.io/" });
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user.email).toBe("alex@example.com");
    expect(res.body.data.organizations[0].role).toBe("OWNER");
    const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("ap_refresh="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "alex@example.com" } });
    expect(user.passwordHash).not.toContain("supersecret1");
    const onboarding = await prisma.onboarding.findFirstOrThrow();
    expect(onboarding.domain).toBe("northwind.io");
    expect(onboarding.brand).toBe("Northwind");
  });

  it("rejects duplicate registration and weak input", async () => {
    await api().post("/api/v1/auth/register").send({ name: "A", email: "a@example.com", password: "supersecret1" }).expect(201);
    const dup = await api().post("/api/v1/auth/register").send({ name: "A", email: "A@example.com", password: "supersecret1" });
    expect(dup.status).toBe(409);
    const weak = await api().post("/api/v1/auth/register").send({ name: "A", email: "not-an-email", password: "short" });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe("VALIDATION_ERROR");
    expect(weak.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(["email", "password"]));
  });

  it("logs in with valid credentials and rejects invalid ones with the same message", async () => {
    const t = await createTenant({ email: "owner@example.com" });
    const ok = await api().post("/api/v1/auth/login").send({ email: "OWNER@example.com", password: "correct-horse-1" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.activeOrganizationId).toBe(t.orgId);
    const wrong = await api().post("/api/v1/auth/login").send({ email: "owner@example.com", password: "wrong-password" });
    const unknown = await api().post("/api/v1/auth/login").send({ email: "nobody@example.com", password: "wrong-password" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it("throttles repeated failed logins", async () => {
    await createTenant({ email: "target@example.com" });
    for (let i = 0; i < 8; i++) await api().post("/api/v1/auth/login").send({ email: "target@example.com", password: "nope-nope" });
    const blocked = await api().post("/api/v1/auth/login").send({ email: "target@example.com", password: "correct-horse-1" });
    expect(blocked.status).toBe(429);
  });

  it("protects routes and rejects bad tokens", async () => {
    await api().get("/api/v1/auth/me").expect(401);
    await api().get("/api/v1/dashboard/cockpit").expect(401);
    await api().get("/api/v1/dashboard/cockpit").set("Authorization", "Bearer garbage").expect(401);
    const t = await createTenant();
    const me = await api().get("/api/v1/auth/me").set(t.auth);
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(t.email);
  });

  it("rejects disabled users even with a valid token", async () => {
    const t = await createTenant();
    await prisma.user.update({ where: { id: t.userId }, data: { status: "DISABLED" } });
    await api().get("/api/v1/auth/me").set(t.auth).expect(401);
  });

  it("rotates refresh tokens and revokes the family on reuse", async () => {
    await createTenant({ email: "rot@example.com" });
    const login = await api().post("/api/v1/auth/login").send({ email: "rot@example.com", password: "correct-horse-1" });
    const first = refreshCookie(login);
    await api().post("/api/v1/auth/refresh").set("Cookie", first).expect(400);
    const r1 = await api().post("/api/v1/auth/refresh").set("Cookie", first).set("X-Requested-With", "aperture");
    expect(r1.status).toBe(200);
    const second = refreshCookie(r1);
    expect(second).not.toBe(first);
    const reuse = await api().post("/api/v1/auth/refresh").set("Cookie", first).set("X-Requested-With", "aperture");
    expect(reuse.status).toBe(401);
    const afterTheft = await api().post("/api/v1/auth/refresh").set("Cookie", second).set("X-Requested-With", "aperture");
    expect(afterTheft.status).toBe(401);
  });

  it("logs out by revoking the refresh token", async () => {
    await createTenant({ email: "out@example.com" });
    const login = await api().post("/api/v1/auth/login").send({ email: "out@example.com", password: "correct-horse-1" });
    const cookie = refreshCookie(login);
    await api().post("/api/v1/auth/logout").set("Cookie", cookie).expect(200);
    await api().post("/api/v1/auth/refresh").set("Cookie", cookie).set("X-Requested-With", "aperture").expect(401);
  });

  it("reports Google sign-in as unavailable when not configured", async () => {
    const res = await api().get("/api/v1/auth/providers");
    expect(res.body.data.google).toBe(false);
    await api().get("/api/v1/auth/oauth/google/start").expect(503);
  });
});

describe("authorization", () => {
  beforeEach(resetDb);

  it("lets members read but not change configuration", async () => {
    const owner = await createTenant();
    const { addMember } = await import("./helpers.js");
    const member = await addMember(owner, "MEMBER");
    await api().get("/api/v1/settings").set(member.auth).expect(200);
    const patch = await api().patch("/api/v1/settings").set(member.auth).send({ autopilotEnabled: false });
    expect(patch.status).toBe(403);
    await api().post("/api/v1/engine/stop").set(member.auth).expect(403);
    await api().patch("/api/v1/settings").set(owner.auth).send({ autopilotEnabled: false }).expect(200);
  });

  it("keeps platform admin routes for platform admins only", async () => {
    const t = await createTenant();
    await api().get("/api/v1/admin/overview").set(t.auth).expect(403);
    await prisma.user.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    await api().get("/api/v1/admin/overview").set(t.auth).expect(200);
  });

  it("requires at least one owner", async () => {
    const owner = await createTenant();
    const m = await prisma.membership.findFirstOrThrow({ where: { organizationId: owner.orgId } });
    const res = await api().patch(`/api/v1/organizations/current/members/${m.id}`).set(owner.auth).send({ role: "ADMIN" });
    expect(res.status).toBe(422);
  });
});
