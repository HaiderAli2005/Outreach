import type { InfraWorkspace, Mailbox, Onboarding, SendingDomain } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { env, features } from "../config/env.js";
import { CAMPAIGN_START, FAST_START, SENDS_PER_WARM_INBOX, WARMUP_SETTINGS } from "../config/plans.js";
import { HttpError } from "../integrations/http.js";
import { infraforge, registrantContact, type IfDnsRecord, type InfraforgeApi } from "../integrations/infraforge.js";
import { smartleadFor } from "../integrations/smartlead.js";
import { withLock } from "../lib/locks.js";
import { lookalikes } from "../modules/onboarding/domainIdeas.js";
import { sendersOf, type Sender } from "../modules/onboarding/onboarding.service.js";
import { getSettings } from "./settings.js";
import { provisionCampaign } from "./provisioning.js";
import { logSystem } from "./systemLog.js";

/**
 * Sending infrastructure after payment, run as a small state machine every couple of minutes:
 *
 *   domains    PENDING_REGISTRATION → REGISTERING → REGISTERED (+ DNS checked, SSL forwarding)
 *   inboxes    PENDING → CREATING → CONNECTING → WARMING → ACTIVE (ramping to the full daily limit)
 *
 * Every step reads the provider back before it buys, so a purchase that timed out is adopted on the next run
 * instead of being bought twice. Failures back off (1, 2, 4 ... minutes) and give up after MAX_ATTEMPTS with a
 * clear message for the customer and the admin console. Nothing here stores inbox passwords: they go from
 * Infraforge straight into Smartlead.
 */

export const MAX_ATTEMPTS = 6;
const MIN = 60_000;
const DAY = 86_400_000;
const PAID = ["ACTIVE", "TRIALING", "PAST_DUE"];
const ENDED = ["CANCELED", "INCOMPLETE_EXPIRED", "UNPAID"];
/** Holds that need a person (a card checkout) rather than clearing themselves on the next run. */
const MANUAL_HOLD = /^Checkout needed/;

export interface InfraReport {
  orgId: string;
  skipped?: string;
  held?: string;
  workspaceId?: string;
  domainsBought: number;
  domainsRegistered: number;
  domainsReplaced: number;
  dnsVerified: number;
  mailboxesBought: number;
  mailboxesConnected: number;
  mailboxesActivated: number;
  capsChanged: number;
  errors: string[];
}

type Ctx = { api: InfraforgeApi; orgId: string; o: Onboarding; ws: InfraWorkspace; report: InfraReport; now: Date };

const backoff = (attempts: number) => new Date(Date.now() + Math.min(360, 2 ** Math.max(0, attempts - 1)) * MIN);
const due = () => ({ OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }] });

/** Platform alerts repeat at most once an hour per message, so a stuck step can't flood the log. */
const alerted = new Map<string, number>();
async function alertOnce(orgId: string | null, level: "WARN" | "ERROR" | "CRITICAL", message: string, everyMs = 60 * MIN, meta?: Record<string, string>): Promise<void> {
  const key = `${orgId}:${message}`;
  const last = alerted.get(key) ?? 0;
  if (Date.now() - last < everyMs) return;
  alerted.set(key, Date.now());
  await logSystem(orgId, level, "infrastructure", message, meta);
}
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

/** Credit, balance and payment errors pause purchases instead of counting as failures. */
function fundsProblem(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 402 || /credit|balance|insufficient|payment|top.?up|funds/i.test(e.message));
}

function blankReport(orgId: string): InfraReport {
  return { orgId, domainsBought: 0, domainsRegistered: 0, domainsReplaced: 0, dnsVerified: 0, mailboxesBought: 0, mailboxesConnected: 0, mailboxesActivated: 0, capsChanged: 0, errors: [] };
}

async function hold(ctx: Ctx, reason: string): Promise<void> {
  ctx.report.held = reason;
  if (ctx.ws.heldReason === reason) return;
  ctx.ws = await prisma.infraWorkspace.update({ where: { organizationId: ctx.orgId }, data: { heldReason: reason, heldAt: new Date() } });
  await logSystem(null, "CRITICAL", "infrastructure", `Setup paused for an organization: ${reason}`, { orgId: ctx.orgId });
  await logSystem(ctx.orgId, "INFO", "infrastructure", "Your sending setup is queued. It continues automatically, you don't need to do anything.");
}

async function clearHold(ctx: Ctx): Promise<void> {
  if (!ctx.ws.heldReason || MANUAL_HOLD.test(ctx.ws.heldReason)) return;
  ctx.ws = await prisma.infraWorkspace.update({ where: { organizationId: ctx.orgId }, data: { heldReason: null, heldAt: null } });
}

const onHold = (ctx: Ctx) => !!ctx.ws.heldReason && MANUAL_HOLD.test(ctx.ws.heldReason);

// ─── workspace ──────────────────────────────────────────────────────────────

export function workspaceName(orgName: string, orgId: string): string {
  const s = orgName.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "org";
  return `aperture-${s}-${orgId.slice(-6)}`.slice(0, 50);
}

async function ensureWorkspace(api: InfraforgeApi, orgId: string, o: Onboarding, report: InfraReport): Promise<InfraWorkspace | null> {
  const existing = await prisma.infraWorkspace.findUnique({ where: { organizationId: orgId } });
  if (existing) return existing;
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } });
  const name = workspaceName(org.name, orgId);
  const dedicated = o.volume >= env.INFRAFORGE_DEDICATED_IP_MIN_VOLUME;
  try {
    const found = (await api.listWorkspaces()).find((w) => w.name === name);
    const w = found ?? (await api.createWorkspace(name, dedicated));
    const row = await prisma.infraWorkspace.create({ data: { organizationId: orgId, workspaceId: w.id, name, dedicatedIp: dedicated, ip: w.ip } });
    await logSystem(orgId, "INFO", "infrastructure", dedicated ? "Your sending workspace is ready, on a dedicated IP used only by you." : "Your sending workspace is ready.");
    return row;
  } catch (e) {
    report.errors.push(`workspace: ${short(e)}`);
    if (fundsProblem(e)) report.held = `Infraforge credits are too low to create a workspace${dedicated ? " with a dedicated IP" : ""}`;
    await alertOnce(null, "ERROR", `Could not create the Infraforge workspace: ${short(e)}`, 60 * MIN, { orgId });
    return null;
  }
}

// ─── domains ────────────────────────────────────────────────────────────────

const tldOf = (d: string) => d.slice(d.indexOf("."));

/** The closest free lookalike, same ending first, within the price cap. */
async function replacementFor(api: InfraforgeApi, primary: string, taken: string, used: Set<string>): Promise<{ name: string; priceCents: number | null } | null> {
  const tld = tldOf(taken);
  const pool = lookalikes(primary)
    .map((l) => l.name)
    .filter((n) => !used.has(n))
    .sort((a, b) => Number(tldOf(b) === tld) - Number(tldOf(a) === tld));
  for (let i = 0; i < pool.length; i += 40) {
    const hits = await api.checkAvailability(pool.slice(i, i + 40));
    const ok = pool.slice(i, i + 40).find((n) => hits.some((h) => h.domain === n && h.available && (h.priceCents ?? 0) <= env.INFRAFORGE_MAX_DOMAIN_PRICE_CENTS));
    if (ok) return { name: ok, priceCents: hits.find((h) => h.domain === ok)?.priceCents ?? null };
  }
  return null;
}

async function renameDomain(orgId: string, d: SendingDomain, name: string, priceCents: number | null): Promise<void> {
  const boxes = await prisma.mailbox.findMany({ where: { sendingDomainId: d.id } });
  await prisma.$transaction([
    prisma.sendingDomain.update({ where: { id: d.id }, data: { name, replacedName: d.replacedName ?? d.name, ...(priceCents ? { priceCents } : {}), lastError: null } }),
    ...boxes.map((m) => prisma.mailbox.update({ where: { id: m.id }, data: { address: `${m.address.split("@")[0]}@${name}` } })),
  ]);
  await logSystem(orgId, "INFO", "infrastructure", `${d.name} was taken by the time we bought it, so we registered ${name} instead. Its inboxes moved with it.`);
}

async function registerDomains(ctx: Ctx): Promise<void> {
  const { api, orgId, o, ws, report } = ctx;
  if (onHold(ctx)) return;
  let todo = await prisma.sendingDomain.findMany({ where: { organizationId: orgId, status: "PENDING_REGISTRATION", prewarmed: false, ...due }, orderBy: { createdAt: "asc" } });
  if (!todo.length) return;

  const { contact, missing } = registrantContact();
  if (!contact) return hold(ctx, `Registrant contact details are missing: ${missing.join(", ")}`);

  // Adopt anything already bought for this workspace (a purchase that timed out last run).
  const mine = (await api.listDomains()).filter((d) => !d.workspaceId || d.workspaceId === ws.workspaceId);
  for (const d of todo) {
    const hit = mine.find((x) => x.domain === d.name);
    if (!hit) continue;
    await prisma.sendingDomain.update({ where: { id: d.id }, data: { status: "REGISTERING", providerId: hit.id, providerStatus: hit.status, lastError: null, nextCheckAt: null } });
  }
  todo = todo.filter((d) => !mine.some((x) => x.domain === d.name));
  if (!todo.length) return;

  // Anything taken or priced as a premium name gets swapped for the closest free lookalike.
  const avail = await api.checkAvailability(todo.map((d) => d.name));
  const used = new Set((await prisma.sendingDomain.findMany({ where: { organizationId: orgId }, select: { name: true } })).map((d) => d.name));
  used.add(o.domain.toLowerCase());
  const buy: { d: SendingDomain; priceCents: number | null }[] = [];
  for (const d of todo) {
    const a = avail.find((x) => x.domain === d.name);
    const fine = a?.available && (a.priceCents ?? 0) <= env.INFRAFORGE_MAX_DOMAIN_PRICE_CENTS;
    if (fine) {
      buy.push({ d, priceCents: a?.priceCents ?? null });
      continue;
    }
    const alt = await replacementFor(api, o.domain, d.name, used);
    if (!alt) {
      await prisma.sendingDomain.update({ where: { id: d.id }, data: { status: "FAILED", lastError: `${d.name} is no longer available and no close alternative is free` } });
      await logSystem(orgId, "WARN", "infrastructure", `${d.name} is no longer available and we couldn't find a close alternative. Our team will pick one with you.`);
      continue;
    }
    used.add(alt.name);
    await renameDomain(orgId, d, alt.name, alt.priceCents);
    report.domainsReplaced++;
    buy.push({ d: { ...d, name: alt.name }, priceCents: alt.priceCents });
  }
  if (!buy.length) return;

  const total = buy.reduce((s, b) => s + (b.priceCents ?? 0), 0);
  const balance = await api.creditBalance().catch(() => null);
  if (balance && !balance.autoTopup && balance.availableCents < total) {
    return hold(ctx, `Infraforge credits are $${(balance.availableCents / 100).toFixed(2)}, the next domains need about $${(total / 100).toFixed(2)}. Top up or turn on auto top-up.`);
  }

  try {
    const r = await api.buyDomains(ws.workspaceId, buy.map((b) => b.d.name), { ...contact, forwardToDomain: o.domain });
    if (r.checkoutUrl && !r.items.length) return hold(ctx, `Checkout needed: Infraforge asked for a card payment for the domains (${r.checkoutUrl})`);
    for (const b of buy) {
      const got = r.items.find((x) => x.domain === b.d.name);
      await prisma.sendingDomain.update({
        where: { id: b.d.id },
        data: { status: "REGISTERING", providerId: got?.id || null, expiresAt: got?.expiresAt ? new Date(got.expiresAt) : null, attempts: 0, lastError: null, nextCheckAt: new Date(Date.now() + MIN) },
      });
    }
    report.domainsBought += buy.length;
    await clearHold(ctx);
    await logSystem(orgId, "INFO", "infrastructure", `Registering ${buy.length} sending domain${buy.length === 1 ? "" : "s"}: ${buy.map((b) => b.d.name).join(", ")}.`);
  } catch (e) {
    report.errors.push(`domains: ${short(e)}`);
    if (fundsProblem(e)) return hold(ctx, `Infraforge refused the domain purchase for funds: ${short(e)}`);
    for (const b of buy) {
      const attempts = b.d.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      await prisma.sendingDomain.update({ where: { id: b.d.id }, data: { attempts, lastError: short(e), nextCheckAt: backoff(attempts), ...(failed ? { status: "FAILED" } : {}) } });
      if (failed) await logSystem(orgId, "ERROR", "infrastructure", `We couldn't register ${b.d.name}. Our team has been told and will sort it out.`);
    }
  }
}

async function pollDomains(ctx: Ctx): Promise<void> {
  const { api, orgId, ws, report } = ctx;
  const waiting = await prisma.sendingDomain.findMany({ where: { organizationId: orgId, status: "REGISTERING", ...due } });
  if (!waiting.length) return;
  const all = (await api.listDomains()).filter((d) => !d.workspaceId || d.workspaceId === ws.workspaceId);
  const done: string[] = [];
  for (const d of waiting) {
    const p = all.find((x) => (d.providerId && x.id === d.providerId) || x.domain === d.name);
    if (!p) {
      const attempts = d.attempts + 1;
      await prisma.sendingDomain.update({
        where: { id: d.id },
        data: attempts >= MAX_ATTEMPTS ? { attempts, status: "FAILED", lastError: "Infraforge has no record of this domain" } : { attempts, nextCheckAt: backoff(attempts) },
      });
      continue;
    }
    if (p.status === "active") {
      await prisma.sendingDomain.update({
        where: { id: d.id },
        data: { status: "REGISTERED", providerId: p.id, providerStatus: p.status, registeredAt: new Date(), expiresAt: p.expiresAt ? new Date(p.expiresAt) : d.expiresAt, sslAt: p.hasMasking ? new Date() : null, attempts: 0, lastError: null, nextCheckAt: null },
      });
      done.push(d.name);
      report.domainsRegistered++;
    } else if (p.status === "failed" || p.status === "expired") {
      await prisma.sendingDomain.update({ where: { id: d.id }, data: { status: "FAILED", providerId: p.id, providerStatus: p.status, lastError: `The registrar reported the domain as ${p.status}` } });
      await logSystem(orgId, "ERROR", "infrastructure", `Registration of ${d.name} didn't go through. Our team has been told.`);
      await logSystem(null, "ERROR", "infrastructure", `Domain ${d.name} is ${p.status} at Infraforge`, { orgId, domainId: d.id });
    } else {
      const slow = !!ctx.o.paidAt && Date.now() - ctx.o.paidAt.getTime() > 2 * DAY;
      await prisma.sendingDomain.update({
        where: { id: d.id },
        data: { providerId: p.id, providerStatus: p.status, nextCheckAt: new Date(Date.now() + 2 * MIN), ...(slow && !d.lastError ? { lastError: "Still pending at the registrar after 2 days" } : {}) },
      });
    }
  }
  if (done.length) await logSystem(orgId, "INFO", "infrastructure", `${done.join(", ")} ${done.length === 1 ? "is" : "are"} registered and forwarding to ${ctx.o.domain}.`);
}

/** SPF, DKIM, DMARC and MX present on the domain. */
export function dnsHealth(records: IfDnsRecord[]) {
  const txt = records.filter((r) => r.type === "TXT");
  return {
    spf: txt.some((r) => /^"?v=spf1/i.test(r.value)),
    dkim: records.some((r) => /_domainkey/i.test(r.name) || /v=DKIM1/i.test(r.value)),
    dmarc: txt.some((r) => /^_dmarc/i.test(r.name) && /v=DMARC1/i.test(r.value)),
    mx: records.some((r) => r.type === "MX"),
  };
}

async function finishDomains(ctx: Ctx): Promise<void> {
  const { api, orgId, report } = ctx;
  const regs = await prisma.sendingDomain.findMany({ where: { organizationId: orgId, status: "REGISTERED", providerId: { not: null }, ...due } });

  const needSsl = features.infraSslForwarding ? regs.filter((d) => !d.sslAt && !d.prewarmed) : [];
  if (needSsl.length && !onHold(ctx)) {
    try {
      await api.buySslForwarding(needSsl.map((d) => d.providerId!));
      await prisma.sendingDomain.updateMany({ where: { id: { in: needSsl.map((d) => d.id) } }, data: { sslAt: new Date() } });
    } catch (e) {
      report.errors.push(`ssl: ${short(e)}`);
      await alertOnce(null, "WARN", `SSL forwarding not bought yet: ${short(e)}`, 6 * 60 * MIN, { orgId });
    }
  }

  for (const d of regs.filter((x) => !x.dnsVerifiedAt)) {
    try {
      const h = dnsHealth(await api.domainDns(d.providerId!));
      if (h.spf && h.dkim && h.dmarc && h.mx) {
        await prisma.sendingDomain.update({ where: { id: d.id }, data: { dnsVerifiedAt: new Date(), lastError: null, nextCheckAt: null } });
        report.dnsVerified++;
        continue;
      }
      if (!h.dmarc) await api.setDmarc([d.name], env.INFRAFORGE_DMARC_POLICY, env.INFRAFORGE_DMARC_EMAIL).catch(() => undefined);
      const missing = (["spf", "dkim", "dmarc", "mx"] as const).filter((k) => !h[k]).map((k) => k.toUpperCase());
      const late = d.registeredAt && Date.now() - d.registeredAt.getTime() > 6 * 3_600_000;
      await prisma.sendingDomain.update({ where: { id: d.id }, data: { nextCheckAt: new Date(Date.now() + 5 * MIN), lastError: late ? `DNS still missing ${missing.join(", ")}` : null } });
    } catch (e) {
      report.errors.push(`dns ${d.name}: ${short(e)}`);
      await prisma.sendingDomain.update({ where: { id: d.id }, data: { nextCheckAt: backoff(3) } });
    }
  }
}

// ─── pre-warmed domains (fast start) ────────────────────────────────────────

/** Fast start swaps the picked domains for Infraforge's pre-warmed ones that carry the brand, when there are enough. */
async function usePreWarmed(ctx: Ctx): Promise<void> {
  const { api, orgId, o, ws } = ctx;
  if (!o.fastStart || onHold(ctx)) return;
  const pending = await prisma.sendingDomain.findMany({ where: { organizationId: orgId, status: "PENDING_REGISTRATION", prewarmed: false, attempts: 0, providerId: null }, include: { mailboxes: true } });
  if (!pending.length) return;
  const base = o.domain.split(".")[0].toLowerCase();
  let stock: Awaited<ReturnType<InfraforgeApi["listPreWarmed"]>> = [];
  try {
    stock = (await api.listPreWarmed(base, 100)).filter((p) => p.id && p.domain.includes(base) && p.mailboxes > 0);
  } catch (e) {
    ctx.report.errors.push(`pre-warmed: ${short(e)}`);
  }
  const take = stock.slice(0, pending.length);
  if (take.length) {
    try {
      await api.buyPreWarmed(ws.workspaceId, take.map((p) => p.id), o.domain, env.INFRAFORGE_DMARC_EMAIL);
      for (const [i, p] of take.entries()) {
        const d = pending[i];
        await prisma.$transaction([
          prisma.mailbox.deleteMany({ where: { sendingDomainId: d.id, status: { in: ["PLANNED", "PENDING"] } } }),
          prisma.sendingDomain.update({ where: { id: d.id }, data: { name: p.domain, replacedName: d.name, prewarmed: true, status: "REGISTERING", providerId: p.id, nextCheckAt: new Date(Date.now() + MIN) } }),
        ]);
      }
      await logSystem(orgId, "INFO", "infrastructure", `Using ${take.length} pre-warmed domain${take.length === 1 ? "" : "s"} for a fast start: ${take.map((p) => p.domain).join(", ")}.`);
    } catch (e) {
      ctx.report.errors.push(`pre-warmed buy: ${short(e)}`);
      if (fundsProblem(e)) return hold(ctx, `Infraforge refused the pre-warmed purchase for funds: ${short(e)}`);
    }
  }
  // Whatever could not be covered is registered fresh, and fresh inboxes always get a real warmup.
  const rest = pending.slice(take.length);
  if (rest.length) {
    const days = Math.max(14, o.warmupDays);
    await prisma.mailbox.updateMany({ where: { sendingDomainId: { in: rest.map((d) => d.id) }, warmupDays: { lt: days } }, data: { warmupDays: days } });
    await prisma.sendingDomain.updateMany({ where: { id: { in: rest.map((d) => d.id) } }, data: { attempts: 1 } });
    await logSystem(orgId, "INFO", "infrastructure", `Pre-warmed domains weren't available for ${rest.length} of your domains, so those inboxes warm up for ${days} days before they send.`);
  }
}

/** Pre-warmed domains arrive with their inboxes: add them to the account as they appear. */
async function adoptPreWarmedInboxes(ctx: Ctx): Promise<void> {
  const { api, orgId, ws } = ctx;
  const doms = await prisma.sendingDomain.findMany({ where: { organizationId: orgId, prewarmed: true, status: "REGISTERED" }, include: { mailboxes: { select: { address: true } } } });
  if (!doms.length) return;
  const boxes = await api.listMailboxes(ws.workspaceId);
  for (const d of doms) {
    const have = new Set(d.mailboxes.map((m) => m.address));
    const fresh = boxes.filter((b) => b.email.endsWith(`@${d.name}`) && !have.has(b.email));
    if (!fresh.length) continue;
    await prisma.mailbox.createMany({
      data: fresh.map((b) => ({
        organizationId: orgId,
        sendingDomainId: d.id,
        address: b.email,
        firstName: b.firstName,
        lastName: b.lastName,
        provider: "infraforge",
        providerId: b.id,
        providerStatus: b.status,
        status: b.status === "active" ? ("CONNECTING" as const) : ("CREATING" as const),
        warmupDays: FAST_START.days,
        dailyLimit: SENDS_PER_WARM_INBOX,
      })),
      skipDuplicates: true,
    });
  }
}

// ─── mailboxes ──────────────────────────────────────────────────────────────

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const slugName = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");

/** The person an address was made for (addresses are built from the sender names), with a sensible fallback. */
export function namesFor(address: string, senders: Sender[], brand: string): { firstName: string; lastName: string } {
  const local = address.split("@")[0].toLowerCase();
  for (const s of senders) {
    const f = slugName(s.first);
    const l = slugName(s.last ?? "");
    if (!f) continue;
    if (local.startsWith(f) || (l && local.includes(l) && local[0] === f[0])) return { firstName: cap(s.first.trim()), lastName: s.last?.trim() ? cap(s.last.trim()) : cap(brand) };
  }
  const word = local.split(/[^a-z]/)[0] || "hello";
  return ["hello", "hi", "team", "mail"].includes(word) ? { firstName: cap(brand), lastName: "Team" } : { firstName: cap(word), lastName: cap(brand) };
}

async function buyMailboxes(ctx: Ctx): Promise<void> {
  const { api, orgId, o, ws, report } = ctx;
  if (onHold(ctx)) return;
  const todo = await prisma.mailbox.findMany({
    where: { organizationId: orgId, status: "PENDING", ...due(), sendingDomain: { status: "REGISTERED", prewarmed: false } },
    include: { sendingDomain: true },
    orderBy: { address: "asc" },
  });
  if (!todo.length) return;

  const existing = await api.listMailboxes(ws.workspaceId);
  const left: typeof todo = [];
  for (const m of todo) {
    const hit = existing.find((x) => x.email === m.address);
    if (hit) await prisma.mailbox.update({ where: { id: m.id }, data: { status: "CREATING", provider: "infraforge", providerId: hit.id, providerStatus: hit.status, nextCheckAt: null } });
    else left.push(m);
  }
  if (!left.length) return;

  const settings = await getSettings(orgId);
  const senders = sendersOf(o, settings.senderName);
  const named = left.map((m) => ({ m, ...(m.firstName && m.lastName ? { firstName: m.firstName, lastName: m.lastName } : namesFor(m.address, senders, o.brand)) }));
  const byDomain = new Map<string, typeof named>();
  for (const n of named) byDomain.set(n.m.sendingDomain!.name, [...(byDomain.get(n.m.sendingDomain!.name) ?? []), n]);

  try {
    const r = await api.buyMailboxes([...byDomain].map(([domain, list]) => ({ domain, mailboxes: list.map((n) => ({ email: n.m.address, firstName: n.firstName, lastName: n.lastName })) })));
    if (r.checkoutUrl && !r.items.length) return hold(ctx, `Checkout needed: Infraforge asked for a card payment for the inboxes (${r.checkoutUrl})`);
    for (const n of named) {
      const got = r.items.find((x) => x.email === n.m.address);
      await prisma.mailbox.update({
        where: { id: n.m.id },
        data: { status: "CREATING", provider: "infraforge", providerId: got?.id || null, providerStatus: got?.status ?? null, firstName: n.firstName, lastName: n.lastName, attempts: 0, lastError: null, nextCheckAt: new Date(Date.now() + MIN) },
      });
    }
    report.mailboxesBought += named.length;
    await clearHold(ctx);
    await logSystem(orgId, "INFO", "infrastructure", `Creating ${named.length} inbox${named.length === 1 ? "" : "es"} on ${[...byDomain.keys()].join(", ")}.`);
  } catch (e) {
    report.errors.push(`mailboxes: ${short(e)}`);
    if (fundsProblem(e)) return hold(ctx, `Infraforge refused the inbox purchase for funds or mailbox slots: ${short(e)}`);
    for (const n of named) {
      const attempts = n.m.attempts + 1;
      await prisma.mailbox.update({ where: { id: n.m.id }, data: { attempts, lastError: short(e), nextCheckAt: backoff(attempts), ...(attempts >= MAX_ATTEMPTS ? { status: "ERROR" } : {}) } });
    }
  }
}

async function pollMailboxes(ctx: Ctx): Promise<void> {
  const { api, orgId, ws } = ctx;
  const waiting = await prisma.mailbox.findMany({ where: { organizationId: orgId, status: "CREATING", ...due } });
  if (!waiting.length) return;
  const all = await api.listMailboxes(ws.workspaceId);
  for (const m of waiting) {
    const p = all.find((x) => (m.providerId && x.id === m.providerId) || x.email === m.address);
    if (!p) {
      const attempts = m.attempts + 1;
      await prisma.mailbox.update({
        where: { id: m.id },
        data: attempts >= MAX_ATTEMPTS ? { attempts, status: "ERROR", lastError: "Infraforge has no record of this inbox" } : { attempts, nextCheckAt: backoff(attempts) },
      });
      continue;
    }
    if (p.status === "active") {
      await prisma.mailbox.update({ where: { id: m.id }, data: { status: "CONNECTING", providerId: p.id, providerStatus: p.status, attempts: 0, lastError: null, nextCheckAt: null } });
    } else if (p.status === "failed") {
      await prisma.mailbox.update({ where: { id: m.id }, data: { status: "ERROR", providerId: p.id, providerStatus: p.status, lastError: "Infraforge could not create this inbox" } });
      await logSystem(null, "ERROR", "infrastructure", `Inbox ${m.address} failed at Infraforge`, { orgId, mailboxId: m.id });
    } else {
      await prisma.mailbox.update({ where: { id: m.id }, data: { providerId: p.id, providerStatus: p.status, nextCheckAt: new Date(Date.now() + 2 * MIN) } });
    }
  }
}

/** Hands each ready inbox to Smartlead with warmup on. The password goes straight across and is never stored here. */
async function connectMailboxes(ctx: Ctx): Promise<void> {
  const { api, orgId, o, report } = ctx;
  const ready = await prisma.mailbox.findMany({
    where: { organizationId: orgId, status: "CONNECTING", providerId: { not: null }, ...due(), sendingDomain: { OR: [{ dnsVerifiedAt: { not: null } }, { prewarmed: true }] } },
    take: 25,
    orderBy: { address: "asc" },
  });
  if (!ready.length) return;
  const sl = await smartleadFor(orgId);
  if (!sl) {
    const note = "Waiting for Smartlead to be connected";
    if (ready.some((m) => m.lastError !== note)) {
      await prisma.mailbox.updateMany({ where: { id: { in: ready.map((m) => m.id) } }, data: { lastError: note } });
      await alertOnce(null, "ERROR", "Inboxes are ready but no Smartlead key is set for this organization or the platform", 60 * MIN, { orgId });
    }
    return;
  }
  const settings = await getSettings(orgId);
  const lo = o.fastStart ? FAST_START.lo : CAMPAIGN_START.lo;
  const connected: string[] = [];
  for (const m of ready) {
    try {
      const creds = await api.mailboxCredentials(m.providerId!);
      const known = m.smartleadAccountId ? Number(m.smartleadAccountId) : await sl.findAccountByEmail(m.address);
      const name = [m.firstName, m.lastName].filter(Boolean).join(" ") || settings.senderName || o.brand;
      const saved = await sl.saveSmtpAccount(
        {
          fromName: name,
          fromEmail: m.address,
          username: creds.username,
          password: creds.password,
          smtpHost: creds.smtpHost,
          smtpPort: creds.smtpPort,
          imapHost: creds.imapHost,
          imapPort: creds.imapPort,
          maxPerDay: Math.min(lo, m.dailyLimit),
          warmupPerDay: WARMUP_SETTINGS.maxPerDay,
          warmupRampup: WARMUP_SETTINGS.rampup,
          replyRate: WARMUP_SETTINGS.replyRate,
        },
        known ?? undefined,
      );
      if (!saved.smtpOk || !saved.imapOk) throw new Error(`Smartlead could not sign in over ${!saved.smtpOk ? "SMTP" : "IMAP"} yet`);
      await prisma.mailbox.update({
        where: { id: m.id },
        data: { status: "WARMING", smartleadAccountId: String(saved.id), warmupStartedAt: m.warmupStartedAt ?? new Date(), sendCap: Math.min(lo, m.dailyLimit), attempts: 0, lastError: null, nextCheckAt: null },
      });
      connected.push(m.address);
      report.mailboxesConnected++;
    } catch (e) {
      const attempts = m.attempts + 1;
      report.errors.push(`connect ${m.address}: ${short(e)}`);
      await prisma.mailbox.update({ where: { id: m.id }, data: { attempts, lastError: short(e), nextCheckAt: backoff(attempts), ...(attempts >= MAX_ATTEMPTS ? { status: "ERROR" } : {}) } });
    }
  }
  if (connected.length) {
    const days = ready.find((m) => connected.includes(m.address))?.warmupDays ?? o.warmupDays;
    await logSystem(orgId, "INFO", "infrastructure", `${connected.length} inbox${connected.length === 1 ? " is" : "es are"} connected and warming up. Campaign emails start after ${days} days.`);
  }
}

/** Inboxes past their warmup join the campaign. */
async function finishWarmup(ctx: Ctx): Promise<void> {
  const { orgId, o, report } = ctx;
  const warming = await prisma.mailbox.findMany({ where: { organizationId: orgId, status: "WARMING", warmupStartedAt: { not: null } } });
  const ripe = warming.filter((m) => m.warmupStartedAt!.getTime() + m.warmupDays * DAY <= ctx.now.getTime());
  if (!ripe.length) return;
  await prisma.mailbox.updateMany({ where: { id: { in: ripe.map((m) => m.id) } }, data: { status: "ACTIVE", activatedAt: ctx.now } });
  report.mailboxesActivated += ripe.length;

  const ids = ripe.map((m) => Number(m.smartleadAccountId)).filter((n) => Number.isFinite(n) && n > 0);
  const settings = await getSettings(orgId);
  const all = [...new Set([...settings.smartleadMailboxIds, ...ids])];
  await prisma.orgSettings.update({ where: { organizationId: orgId }, data: { smartleadMailboxIds: all } });

  const campaign = await prisma.campaign.findFirst({ where: { organizationId: orgId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  try {
    if (campaign?.smartleadCampaignId) {
      const sl = await smartleadFor(orgId);
      if (sl && ids.length) await sl.attachMailboxes(campaign.smartleadCampaignId, ids);
    } else if (campaign && o.launchedAt && all.length) {
      await provisionCampaign(orgId, campaign.id, all);
    }
    await logSystem(orgId, "INFO", "infrastructure", `Warmup finished for ${ripe.length} inbox${ripe.length === 1 ? "" : "es"}. ${campaign ? "They now send your campaign, starting gently." : "They're ready for your first campaign."}`);
  } catch (e) {
    report.errors.push(`attach: ${short(e)}`);
    await logSystem(orgId, "WARN", "infrastructure", `Inboxes finished warmup but couldn't join the campaign yet: ${short(e)}`);
  }
}

/**
 * Campaign sends per inbox climb from the starting level to the daily limit over the ramp.
 * If bounces run high over the last week, the climb pauses until they settle.
 */
async function rampSendCaps(ctx: Ctx): Promise<void> {
  const { orgId, o, report } = ctx;
  const active = await prisma.mailbox.findMany({ where: { organizationId: orgId, status: "ACTIVE", activatedAt: { not: null }, smartleadAccountId: { not: null } } });
  if (!active.length) return;
  const settings = await getSettings(orgId);
  const r = o.fastStart ? FAST_START : CAMPAIGN_START;
  const since = new Date(ctx.now.getTime() - 7 * DAY);
  const [sent, bounced] = await Promise.all([
    prisma.message.count({ where: { organizationId: orgId, direction: "OUTBOUND", createdAt: { gte: since } } }),
    prisma.contact.count({ where: { organizationId: orgId, status: "BOUNCED", updatedAt: { gte: since } } }),
  ]);
  const hot = sent >= 50 && bounced / sent > 0.03;
  let sl: Awaited<ReturnType<typeof smartleadFor>> | undefined;
  for (const m of active) {
    const ceiling = Math.min(m.dailyLimit, settings.perMailboxDailyCap);
    const days = Math.floor((ctx.now.getTime() - m.activatedAt!.getTime()) / DAY);
    const target = Math.min(ceiling, Math.round(r.lo + (ceiling - r.lo) * Math.min(1, days / r.rampDays)));
    const next = hot ? Math.min(target, m.sendCap ?? target) : target;
    if (next === m.sendCap) continue;
    sl ??= await smartleadFor(orgId);
    if (!sl) return;
    try {
      await sl.setAccountDailyLimit(Number(m.smartleadAccountId), next);
      await prisma.mailbox.update({ where: { id: m.id }, data: { sendCap: next } });
      report.capsChanged++;
    } catch (e) {
      report.errors.push(`ramp ${m.address}: ${short(e)}`);
    }
  }
  if (hot) await alertOnce(orgId, "WARN", "Bounces are above 3% this week, so sending volume is holding steady until they settle.", DAY);
}

// ─── lifecycle ──────────────────────────────────────────────────────────────

/** Someone paid again after their inboxes were released: queue them to be created again and renew the domains. */
async function reactivate(ctx: Ctx): Promise<void> {
  const { api, orgId } = ctx;
  const released = await prisma.mailbox.updateMany({ where: { organizationId: orgId, status: "RELEASED" }, data: { status: "PENDING", providerId: null, providerStatus: null, attempts: 0, lastError: null, nextCheckAt: null } });
  const off = await prisma.sendingDomain.findMany({ where: { organizationId: orgId, autoRenew: false, providerId: { not: null } } });
  if (off.length) {
    await api.setAutoRenew(off.map((d) => d.providerId!), true).catch((e) => ctx.report.errors.push(`autorenew: ${short(e)}`));
    await prisma.sendingDomain.updateMany({ where: { id: { in: off.map((d) => d.id) } }, data: { autoRenew: true } });
  }
  if (released.count) await logSystem(orgId, "INFO", "infrastructure", `Welcome back. Recreating ${released.count} inboxes on your domains.`);
}

/** One pass for one organization. Safe to run as often as you like. */
export async function reconcileInfra(orgId: string): Promise<InfraReport> {
  const report = blankReport(orgId);
  const api = infraforge();
  if (!api) return { ...report, skipped: "Infraforge is not configured" };
  const r = await withLock(`infra:${orgId}`, 10 * MIN, async () => {
    const [o, sub] = await Promise.all([prisma.onboarding.findUnique({ where: { organizationId: orgId } }), prisma.subscription.findUnique({ where: { organizationId: orgId }, select: { status: true } })]);
    if (!o?.paidAt) return { ...report, skipped: "not paid" };
    if (!sub || !PAID.includes(sub.status)) return { ...report, skipped: "subscription not active" };
    const ws = await ensureWorkspace(api, orgId, o, report);
    if (!ws) return report;
    const ctx: Ctx = { api, orgId, o, ws, report, now: new Date() };
    report.workspaceId = ws.workspaceId;
    const steps: [string, (c: Ctx) => Promise<void>][] = [
      ["reactivate", reactivate],
      ["pre-warmed", usePreWarmed],
      ["register", registerDomains],
      ["poll domains", pollDomains],
      ["dns", finishDomains],
      ["pre-warmed inboxes", adoptPreWarmedInboxes],
      ["buy inboxes", buyMailboxes],
      ["poll inboxes", pollMailboxes],
      ["connect", connectMailboxes],
      ["warmup", finishWarmup],
      ["ramp", rampSendCaps],
    ];
    for (const [name, step] of steps) {
      try {
        await step(ctx);
      } catch (e) {
        report.errors.push(`${name}: ${short(e)}`);
      }
    }
    await prisma.infraWorkspace.update({ where: { organizationId: orgId }, data: { lastRunAt: new Date() } });
    report.held ??= ctx.ws.heldReason ?? undefined;
    return report;
  });
  return r.ran ? r.result : { ...report, skipped: "already running" };
}

/** Starts a pass right away (after payment) without making the caller wait. */
export function kickInfra(orgId: string): void {
  if (!features.infraforge) return;
  void reconcileInfra(orgId).catch((e) => logSystem(null, "ERROR", "infrastructure", `Setup pass failed: ${short(e)}`, { orgId }));
}

/**
 * After a subscription has ended for the grace period: delete the inboxes (they are billed monthly) and stop the
 * domains renewing. The domains stay registered to the customer until they expire.
 */
export async function releaseInfra(orgId: string): Promise<{ orgId: string; released: number; domains: number; skipped?: string }> {
  const api = infraforge();
  if (!api) return { orgId, released: 0, domains: 0, skipped: "Infraforge is not configured" };
  const sub = await prisma.subscription.findUnique({ where: { organizationId: orgId }, select: { status: true, updatedAt: true } });
  if (!sub || !ENDED.includes(sub.status)) return { orgId, released: 0, domains: 0, skipped: "subscription not ended" };
  if (Date.now() - sub.updatedAt.getTime() < env.INFRAFORGE_RELEASE_AFTER_DAYS * DAY) return { orgId, released: 0, domains: 0, skipped: "in grace period" };

  const boxes = await prisma.mailbox.findMany({ where: { organizationId: orgId, providerId: { not: null }, status: { not: "RELEASED" } } });
  let released = 0;
  for (const m of boxes) {
    try {
      await api.deleteMailbox(m.providerId!);
      await prisma.mailbox.update({ where: { id: m.id }, data: { status: "RELEASED", providerId: null, providerStatus: null } });
      released++;
    } catch (e) {
      await prisma.mailbox.update({ where: { id: m.id }, data: { lastError: `Release failed: ${short(e)}` } });
    }
  }
  const doms = await prisma.sendingDomain.findMany({ where: { organizationId: orgId, providerId: { not: null }, autoRenew: true } });
  if (doms.length) {
    try {
      await api.setAutoRenew(doms.map((d) => d.providerId!), false);
      await prisma.sendingDomain.updateMany({ where: { id: { in: doms.map((d) => d.id) } }, data: { autoRenew: false } });
    } catch (e) {
      await logSystem(null, "WARN", "infrastructure", `Could not turn off domain renewal: ${short(e)}`, { orgId });
    }
  }
  if (released || doms.length) await logSystem(orgId, "INFO", "infrastructure", `Your subscription ended, so ${released} inboxes were closed and your domains won't renew. Subscribe again any time to bring them back.`);
  return { orgId, released, domains: doms.length };
}

/** Admin: send a failed domain or inbox round again from where it stopped. */
export async function retryItem(kind: "domain" | "mailbox", id: string): Promise<{ orgId: string }> {
  if (kind === "domain") {
    const d = await prisma.sendingDomain.findUniqueOrThrow({ where: { id } });
    const deadAtProvider = d.providerStatus === "failed" || d.providerStatus === "expired";
    const data =
      d.status === "FAILED"
        ? d.providerId && !deadAtProvider
          ? { status: "REGISTERING" as const }
          : { status: "PENDING_REGISTRATION" as const, providerId: null, providerStatus: null }
        : d.status === "REGISTERED"
          ? { dnsVerifiedAt: null }
          : {};
    await prisma.sendingDomain.update({ where: { id }, data: { ...data, attempts: 0, lastError: null, nextCheckAt: null } });
    return { orgId: d.organizationId };
  }
  const m = await prisma.mailbox.findUniqueOrThrow({ where: { id } });
  const status = m.status !== "ERROR" ? m.status : m.smartleadAccountId && m.warmupStartedAt ? "WARMING" : m.providerId ? (m.providerStatus === "active" ? "CONNECTING" : "CREATING") : "PENDING";
  await prisma.mailbox.update({ where: { id }, data: { status, attempts: 0, lastError: null, nextCheckAt: null } });
  return { orgId: m.organizationId };
}

export async function resumeOrg(orgId: string): Promise<void> {
  await prisma.infraWorkspace.updateMany({ where: { organizationId: orgId }, data: { heldReason: null, heldAt: null } });
}

export type { Mailbox, SendingDomain };
