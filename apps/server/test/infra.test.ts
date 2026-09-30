import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { env, features } from "../src/config/env.js";
import { api, createTenant, FakeSmartlead, resetDb } from "./helpers.js";
import { setSmartleadFactory } from "../src/integrations/smartlead.js";
import {
  credentialsOf,
  InfraforgeClient,
  rowsOf,
  setInfraforgeFactory,
  type IfAvailability,
  type IfContact,
  type IfCredentials,
  type IfDnsRecord,
  type IfDomain,
  type IfMailbox,
  type IfPreWarmed,
  type IfWorkspace,
  type InfraforgeApi,
} from "../src/integrations/infraforge.js";
import { dnsHealth, namesFor, reconcileInfra, releaseInfra, workspaceName } from "../src/domain/infra.js";
import { provisioningChecklist } from "../src/modules/analyses/provisioning.service.js";
import { HttpError } from "../src/integrations/http.js";

/** An in-memory Infraforge account. `tick()` moves everything pending one step forward, like the real thing does over minutes. */
class FakeInfraforge implements InfraforgeApi {
  workspaces: IfWorkspace[] = [];
  domains: IfDomain[] = [];
  mailboxes: IfMailbox[] = [];
  taken = new Set<string>();
  prices = new Map<string, number>();
  balance: { availableCents: number; autoTopup: boolean } | null = { availableCents: 100_000, autoTopup: false };
  calls: { op: string; args: unknown[] }[] = [];
  failNextDomainBuyAfterRecording = false;
  preWarmed: IfPreWarmed[] = [];
  private n = 0;
  private log(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
  }
  count(op: string) {
    return this.calls.filter((c) => c.op === op).length;
  }
  tick() {
    this.domains = this.domains.map((d) => (d.status === "pending" ? { ...d, status: "active" } : d));
    this.mailboxes = this.mailboxes.map((m) => (m.status === "processing" ? { ...m, status: "active" } : m));
  }
  async listWorkspaces() { return this.workspaces; }
  async createWorkspace(name: string, dedicatedIp: boolean) {
    this.log("createWorkspace", name, dedicatedIp);
    const w = { id: `wks_${++this.n}`, name, ip: dedicatedIp ? "10.0.0.9" : null };
    this.workspaces.push(w);
    return w;
  }
  async eligibleIps() { return []; }
  async creditBalance() { return this.balance; }
  async checkAvailability(names: string[]): Promise<IfAvailability[]> {
    this.log("checkAvailability", names);
    return names.map((d) => ({ domain: d, available: !this.taken.has(d) && !this.domains.some((x) => x.domain === d), priceCents: this.prices.get(d) ?? 1299 }));
  }
  async alternativeDomains() { return []; }
  async buyDomains(workspaceId: string, names: string[], contact: IfContact) {
    this.log("buyDomains", workspaceId, names, contact);
    const items = names.map((d) => ({ id: `dom_${++this.n}`, domain: d, expiresAt: "2027-09-30" }));
    for (const i of items) this.domains.push({ id: i.id, domain: i.domain, status: "pending", workspaceId, expiresAt: i.expiresAt, hasMasking: false });
    if (this.failNextDomainBuyAfterRecording) {
      this.failNextDomainBuyAfterRecording = false;
      throw new Error("socket hang up");
    }
    return { items, invoiceId: "inv_1", totalCents: 1299 * names.length, checkoutUrl: null };
  }
  async listDomains() { return this.domains; }
  async domainDns(domainId: string): Promise<IfDnsRecord[]> {
    const d = this.domains.find((x) => x.id === domainId)!;
    return [
      { name: d.domain, type: "TXT", value: "v=spf1 include:_spf.infraforge.ai ~all" },
      { name: `s1._domainkey.${d.domain}`, type: "TXT", value: "v=DKIM1; k=rsa; p=MIIB" },
      { name: `_dmarc.${d.domain}`, type: "TXT", value: "v=DMARC1; p=quarantine" },
      { name: d.domain, type: "MX", value: "mx.infraforge.ai" },
    ];
  }
  async setDmarc(...a: unknown[]) { this.log("setDmarc", ...a); }
  async buySslForwarding(ids: string[]) { this.log("buySslForwarding", ids); }
  async setAutoRenew(ids: string[], on: boolean) { this.log("setAutoRenew", ids, on); }
  async listPreWarmed() { return this.preWarmed; }
  async buyPreWarmed(workspaceId: string, ids: string[]) {
    this.log("buyPreWarmed", workspaceId, ids);
    for (const id of ids) {
      const p = this.preWarmed.find((x) => x.id === id)!;
      this.domains.push({ id: `dom_${++this.n}`, domain: p.domain, status: "active", workspaceId, expiresAt: null, hasMasking: false });
      for (const who of ["ava", "ben"]) this.mailboxes.push({ id: `mbx_${++this.n}`, email: `${who}@${p.domain}`, status: "active", workspaceId, firstName: who, lastName: "Prewarm" });
    }
  }
  async buyMailboxes(domains: { domain: string; mailboxes: { email: string; firstName: string; lastName: string }[] }[]) {
    this.log("buyMailboxes", domains);
    const ws = this.domains.find((d) => d.domain === domains[0].domain)?.workspaceId ?? null;
    const items = domains.flatMap((d) => d.mailboxes.map((m) => ({ id: `mbx_${++this.n}`, email: m.email, status: "processing", workspaceId: ws, firstName: m.firstName, lastName: m.lastName })));
    this.mailboxes.push(...items);
    return { items, invoiceId: "inv_2", totalCents: 350 * items.length, checkoutUrl: null };
  }
  async listMailboxes(workspaceId?: string) { return this.mailboxes.filter((m) => !workspaceId || m.workspaceId === workspaceId); }
  async mailboxCredentials(id: string): Promise<IfCredentials> {
    const m = this.mailboxes.find((x) => x.id === id)!;
    return { username: m.email, password: "s3cret-pass", smtpHost: "smtp.infraforge.ai", smtpPort: 587, imapHost: "imap.infraforge.ai", imapPort: 993 };
  }
  async deleteMailbox(id: string) {
    this.log("deleteMailbox", id);
    this.mailboxes = this.mailboxes.filter((m) => m.id !== id);
  }
}

const CONTACT = {
  INFRAFORGE_CONTACT_FIRST_NAME: "Mazhar",
  INFRAFORGE_CONTACT_LAST_NAME: "Ali",
  INFRAFORGE_CONTACT_EMAIL: "domains@aperture.test",
  INFRAFORGE_CONTACT_PHONE: "+44.2070000000",
  INFRAFORGE_CONTACT_ORG: "Aperture",
  INFRAFORGE_CONTACT_ADDRESS: "1 Test Street",
  INFRAFORGE_CONTACT_CITY: "London",
  INFRAFORGE_CONTACT_PROVINCE: "London",
  INFRAFORGE_CONTACT_POSTAL_CODE: "EC1A 1BB",
  INFRAFORGE_CONTACT_COUNTRY: "GB",
} as const;

const DAY = 86_400_000;

async function paidSetup(opts: { fastStart?: boolean; volume?: number } = {}) {
  const t = await createTenant();
  await prisma.onboarding.create({
    data: {
      organizationId: t.orgId,
      domain: "northwind.io",
      brand: "Northwind",
      icp: {},
      volume: opts.volume ?? 1000,
      warmupDays: 14,
      fastStart: !!opts.fastStart,
      senders: [{ first: "Sara", last: "Khan" }],
      paidAt: new Date(),
      launchedAt: new Date(),
    },
  });
  for (const name of ["getnorthwind.com", "trynorthwind.com"]) {
    const d = await prisma.sendingDomain.create({ data: { organizationId: t.orgId, name, priceCents: 1499, status: "PENDING_REGISTRATION", forwardTo: "northwind.io" } });
    await prisma.mailbox.createMany({
      data: ["sara", "sara.k"].map((local) => ({ organizationId: t.orgId, sendingDomainId: d.id, address: `${local}@${name}`, status: "PENDING" as const, warmupDays: opts.fastStart ? 0 : 14, dailyLimit: 40 })),
    });
  }
  return t;
}

describe("Infraforge provisioning", () => {
  let inf: FakeInfraforge;
  let sl: FakeSmartlead;
  const saved: Record<string, unknown> = {};

  beforeEach(async () => {
    await resetDb();
    inf = new FakeInfraforge();
    sl = new FakeSmartlead();
    setInfraforgeFactory(() => inf);
    setSmartleadFactory(async () => sl);
    for (const [k, v] of Object.entries(CONTACT)) {
      saved[k] = (env as Record<string, unknown>)[k];
      (env as Record<string, unknown>)[k] = v;
    }
    features.infraSslForwarding = true;
  });

  afterEach(() => {
    setInfraforgeFactory(null);
    for (const [k, v] of Object.entries(saved)) (env as Record<string, unknown>)[k] = v;
  });

  it("takes a paid setup from domains to warming inboxes in Smartlead, without storing passwords", async () => {
    const t = await paidSetup();

    let r = await reconcileInfra(t.orgId);
    expect(r.errors).toEqual([]);
    expect(inf.count("createWorkspace")).toBe(1);
    const ws = inf.calls.find((c) => c.op === "createWorkspace")!.args;
    expect(ws[0]).toMatch(/^aperture-org-\d+-/);
    expect(ws[1]).toBe(false);
    expect(workspaceName("Acme & Co.", "cabc123456")).toBe("aperture-acme-co-123456");
    const buy = inf.calls.find((c) => c.op === "buyDomains")!;
    expect(buy.args[1]).toEqual(["getnorthwind.com", "trynorthwind.com"]);
    expect(buy.args[2]).toMatchObject({ firstName: "Mazhar", country: "GB", forwardToDomain: "northwind.io" });
    expect(await prisma.sendingDomain.count({ where: { organizationId: t.orgId, status: "REGISTERING" } })).toBe(2);

    inf.tick();
    await prisma.sendingDomain.updateMany({ data: { nextCheckAt: null } });
    r = await reconcileInfra(t.orgId);
    expect(r.domainsRegistered).toBe(2);
    expect(r.dnsVerified).toBe(2);
    expect(inf.count("buySslForwarding")).toBe(1);
    const boxBuy = inf.calls.find((c) => c.op === "buyMailboxes")!.args[0] as { domain: string; mailboxes: { firstName: string; lastName: string }[] }[];
    expect(boxBuy).toHaveLength(2);
    expect(boxBuy[0].mailboxes[0]).toMatchObject({ firstName: "Sara", lastName: "Khan" });
    expect(await prisma.mailbox.count({ where: { organizationId: t.orgId, status: "CREATING" } })).toBe(4);

    inf.tick();
    await prisma.mailbox.updateMany({ data: { nextCheckAt: null } });
    r = await reconcileInfra(t.orgId);
    expect(r.mailboxesConnected).toBe(4);
    const boxes = await prisma.mailbox.findMany({ where: { organizationId: t.orgId } });
    expect(boxes.every((m) => m.status === "WARMING" && m.smartleadAccountId && m.warmupStartedAt && m.provider === "infraforge")).toBe(true);
    const account = sl.calls.find((c) => c.method === "saveSmtpAccount")!.args[0] as Record<string, unknown>;
    expect(account).toMatchObject({ smtpHost: "smtp.infraforge.ai", imapPort: 993, maxPerDay: 10, fromName: "Sara Khan" });
    expect(JSON.stringify(await prisma.mailbox.findMany())).not.toContain("s3cret-pass");

    const c = await provisioningChecklist(t.orgId);
    expect(c.rows.map((x) => x.state)).toEqual(["done", "done", "done", "running", "waiting"]);
    expect(c.rows[3].detail).toMatch(/14 days left/);

    // A second pass buys nothing more.
    await reconcileInfra(t.orgId);
    expect(inf.count("buyDomains")).toBe(1);
    expect(inf.count("buyMailboxes")).toBe(1);
  });

  it("moves inboxes into the campaign after warmup and ramps the daily limit", async () => {
    const t = await paidSetup();
    await prisma.campaign.create({ data: { organizationId: t.orgId, name: "First", status: "ACTIVE", smartleadCampaignId: "sl-1" } });
    for (let i = 0; i < 3; i++) {
      await reconcileInfra(t.orgId);
      inf.tick();
      await prisma.sendingDomain.updateMany({ data: { nextCheckAt: null } });
      await prisma.mailbox.updateMany({ data: { nextCheckAt: null } });
    }
    expect(await prisma.mailbox.count({ where: { status: "WARMING" } })).toBe(4);

    await prisma.mailbox.updateMany({ data: { warmupStartedAt: new Date(Date.now() - 15 * DAY) } });
    const r = await reconcileInfra(t.orgId);
    expect(r.mailboxesActivated).toBe(4);
    const attach = sl.calls.find((c) => c.method === "attachMailboxes")!;
    expect(attach.args[0]).toBe("sl-1");
    expect((attach.args[1] as number[]).length).toBe(4);
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } })).smartleadMailboxIds).toHaveLength(4);

    // A week into the ramp, halfway from 10 towards the org's per-inbox cap (30).
    await prisma.mailbox.updateMany({ data: { activatedAt: new Date(Date.now() - 7 * DAY) } });
    await reconcileInfra(t.orgId);
    const limits = sl.calls.filter((c) => c.method === "setAccountDailyLimit").map((c) => c.args[1]);
    expect(limits).toContain(20);
    expect((await prisma.mailbox.findFirstOrThrow()).sendCap).toBe(20);
  });

  it("swaps a domain that was taken since checkout for the closest free lookalike and moves its inboxes", async () => {
    const t = await paidSetup();
    inf.taken.add("trynorthwind.com");
    const r = await reconcileInfra(t.orgId);
    expect(r.domainsReplaced).toBe(1);
    const d = await prisma.sendingDomain.findFirstOrThrow({ where: { replacedName: "trynorthwind.com" } });
    expect(d.name).toMatch(/\.com$/);
    expect(d.name).not.toBe("trynorthwind.com");
    const boxes = await prisma.mailbox.findMany({ where: { sendingDomainId: d.id } });
    expect(boxes.every((m) => m.address.endsWith(`@${d.name}`))).toBe(true);
    const log = await prisma.systemLog.findFirst({ where: { organizationId: t.orgId, message: { contains: "was taken" } } });
    expect(log).not.toBeNull();
  });

  it("never buys premium-priced names", async () => {
    const t = await paidSetup();
    inf.prices.set("getnorthwind.com", 250_000);
    await reconcileInfra(t.orgId);
    const bought = inf.calls.find((c) => c.op === "buyDomains")!.args[1] as string[];
    expect(bought).not.toContain("getnorthwind.com");
    expect(bought).toHaveLength(2);
  });

  it("pauses purchases when credits are too low and carries on once topped up", async () => {
    const t = await paidSetup();
    inf.balance = { availableCents: 500, autoTopup: false };
    let r = await reconcileInfra(t.orgId);
    expect(r.held).toMatch(/credits/i);
    expect(inf.count("buyDomains")).toBe(0);
    expect(await prisma.systemLog.count({ where: { organizationId: null, level: "CRITICAL" } })).toBe(1);

    inf.balance = { availableCents: 100_000, autoTopup: false };
    await prisma.sendingDomain.updateMany({ data: { nextCheckAt: null } });
    r = await reconcileInfra(t.orgId);
    expect(inf.count("buyDomains")).toBe(1);
    expect((await prisma.infraWorkspace.findUniqueOrThrow({ where: { organizationId: t.orgId } })).heldReason).toBeNull();
  });

  it("holds until the registrant contact is configured", async () => {
    const t = await paidSetup();
    (env as Record<string, unknown>).INFRAFORGE_CONTACT_PHONE = undefined;
    const r = await reconcileInfra(t.orgId);
    expect(r.held).toMatch(/INFRAFORGE_CONTACT_PHONE/);
    expect(inf.count("buyDomains")).toBe(0);
  });

  it("adopts a purchase that timed out instead of buying the domains twice", async () => {
    const t = await paidSetup();
    inf.failNextDomainBuyAfterRecording = true;
    await reconcileInfra(t.orgId);
    expect(await prisma.sendingDomain.count({ where: { status: "PENDING_REGISTRATION" } })).toBe(2);
    await prisma.sendingDomain.updateMany({ data: { nextCheckAt: null } });
    await reconcileInfra(t.orgId);
    expect(inf.count("buyDomains")).toBe(1);
    expect(await prisma.sendingDomain.count({ where: { status: { in: ["REGISTERING", "REGISTERED"] } } })).toBe(2);
  });

  it("gives large senders a dedicated IP", async () => {
    const t = await paidSetup({ volume: 5000 });
    await reconcileInfra(t.orgId);
    expect(inf.calls.find((c) => c.op === "createWorkspace")!.args[1]).toBe(true);
    expect((await prisma.infraWorkspace.findUniqueOrThrow({ where: { organizationId: t.orgId } })).dedicatedIp).toBe(true);
  });

  it("uses branded pre-warmed domains for a fast start", async () => {
    const t = await paidSetup({ fastStart: true });
    inf.preWarmed = [{ id: "pw_1", domain: "northwindmail.com", mailboxes: 2, priceCents: 4000 }];
    await reconcileInfra(t.orgId);
    expect(inf.count("buyPreWarmed")).toBe(1);
    const pw = await prisma.sendingDomain.findFirstOrThrow({ where: { prewarmed: true } });
    expect(pw.name).toBe("northwindmail.com");
    // The other domain is registered fresh and gets a real warmup.
    const fresh = await prisma.mailbox.findMany({ where: { sendingDomain: { prewarmed: false } } });
    expect(fresh.every((m) => m.warmupDays >= 14)).toBe(true);

    await prisma.sendingDomain.updateMany({ data: { nextCheckAt: null } });
    await reconcileInfra(t.orgId);
    const adopted = await prisma.mailbox.findMany({ where: { sendingDomainId: pw.id } });
    expect(adopted.map((m) => m.address).sort()).toEqual(["ava@northwindmail.com", "ben@northwindmail.com"]);
    expect(adopted.every((m) => m.status === "WARMING")).toBe(true);
  });

  it("closes inboxes and stops renewal after a subscription ends, and brings them back on return", async () => {
    const t = await paidSetup();
    for (let i = 0; i < 3; i++) {
      await reconcileInfra(t.orgId);
      inf.tick();
      await prisma.sendingDomain.updateMany({ data: { nextCheckAt: null } });
      await prisma.mailbox.updateMany({ data: { nextCheckAt: null } });
    }
    await prisma.subscription.update({ where: { organizationId: t.orgId }, data: { status: "CANCELED" } });
    expect((await releaseInfra(t.orgId)).skipped).toBe("in grace period");
    await prisma.$executeRaw`UPDATE "Subscription" SET "updatedAt" = now() - interval '30 days' WHERE "organizationId" = ${t.orgId}`;
    const out = await releaseInfra(t.orgId);
    expect(out.released).toBe(4);
    expect(inf.count("deleteMailbox")).toBe(4);
    expect(inf.calls.find((c) => c.op === "setAutoRenew")!.args[1]).toBe(false);
    expect(await prisma.mailbox.count({ where: { status: "RELEASED" } })).toBe(4);

    await prisma.subscription.update({ where: { organizationId: t.orgId }, data: { status: "ACTIVE" } });
    await reconcileInfra(t.orgId);
    expect(inf.calls.filter((c) => c.op === "setAutoRenew").at(-1)!.args[1]).toBe(true);
    expect(inf.count("buyMailboxes")).toBe(2);
  });

  it("does nothing for unpaid setups", async () => {
    const t = await paidSetup();
    await prisma.onboarding.update({ where: { organizationId: t.orgId }, data: { paidAt: null } });
    expect((await reconcileInfra(t.orgId)).skipped).toBe("not paid");
    expect(inf.calls).toHaveLength(0);
  });

  it("gives platform admins an overview with retry for stuck items", async () => {
    const t = await paidSetup();
    await prisma.sendingDomain.updateMany({ where: { name: "getnorthwind.com" }, data: { status: "FAILED", lastError: "Registrar said no" } });
    await api().get("/api/v1/admin/infrastructure").set(t.auth).expect(403);
    await prisma.user.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    const res = await api().get("/api/v1/admin/infrastructure").set(t.auth).expect(200);
    expect(res.body.data.balance.availableCents).toBe(100_000);
    const problem = res.body.data.problems.find((p: { name: string }) => p.name === "getnorthwind.com");
    expect(problem).toMatchObject({ kind: "domain", status: "FAILED", error: "Registrar said no" });

    await api().post("/api/v1/admin/infrastructure/retry").set(t.auth).send({ kind: "domain", id: problem.id }).expect(200);
    const d = await prisma.sendingDomain.findUniqueOrThrow({ where: { id: problem.id } });
    expect(["REGISTERING", "REGISTERED"]).toContain(d.status);
    expect(d.lastError).toBeNull();
  });
});

describe("Infraforge helpers", () => {
  it("reads lists bare or wrapped", () => {
    expect(rowsOf([{ id: 1 }])).toHaveLength(1);
    expect(rowsOf({ domains: [{ id: 1 }, { id: 2 }] }, "domains")).toHaveLength(2);
    expect(rowsOf({ data: { mailboxes: [{ id: 1 }] } }, "mailboxes")).toHaveLength(1);
    expect(rowsOf(null)).toEqual([]);
  });

  it("finds SMTP and IMAP settings in either shape and refuses without a password", () => {
    expect(credentialsOf({ email: "a@b.com", credentials: { smtpHost: "s", smtpPort: 465, imapHost: "i", imapPort: 993, password: "p" } })).toEqual({ username: "a@b.com", password: "p", smtpHost: "s", smtpPort: 465, imapHost: "i", imapPort: 993 });
    expect(credentialsOf({ email: "a@b.com", password: "p" }, { smtpHost: "smtp.x", smtpPort: 587, imapHost: "imap.x", imapPort: 993 }).smtpHost).toBe("smtp.x");
    expect(() => credentialsOf({ email: "a@b.com", smtpHost: "s" })).toThrow(/password/);
  });

  it("names inboxes after the sender they were made for", () => {
    const senders = [{ first: "Sara", last: "Khan" }];
    expect(namesFor("sara.k@getx.com", senders, "northwind")).toEqual({ firstName: "Sara", lastName: "Khan" });
    expect(namesFor("s.khan@getx.com", senders, "northwind")).toEqual({ firstName: "Sara", lastName: "Khan" });
    expect(namesFor("hello@getx.com", [], "northwind")).toEqual({ firstName: "Northwind", lastName: "Team" });
  });

  it("checks SPF, DKIM, DMARC and MX", () => {
    expect(dnsHealth([{ name: "x.com", type: "TXT", value: "v=spf1 ~all" }])).toEqual({ spf: true, dkim: false, dmarc: false, mx: false });
  });

  it("sends the raw API key and never retries a purchase", async () => {
    const seen: { url: string; auth: string | null; method: string }[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization"), method: String(init?.method) });
      return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    });
    try {
      const c = new InfraforgeClient("key_123", "https://api.infraforge.test/public");
      await expect(c.buyDomains("wks_1", ["a.com"], {} as IfContact)).rejects.toBeInstanceOf(HttpError);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({ url: "https://api.infraforge.test/public/domains", auth: "key_123", method: "POST" });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
