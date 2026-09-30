import Bottleneck from "bottleneck";
import { env } from "../config/env.js";
import { fetchJson, HttpError } from "./http.js";

/**
 * Infraforge public API (https://api.infraforge.ai/public, Swagger at /public/swagger).
 * Private SMTP infrastructure: workspaces (one per customer, optionally with a dedicated IP), domains bought
 * through Infraforge with SPF, DKIM, DMARC and forwarding set up for them, and mailboxes on those domains.
 *
 * Purchases are never retried blindly: Infraforge has no idempotency key, so a timed out purchase is
 * reconciled by reading the account back on the next run instead of buying again.
 */

export type IfDomainStatus = "draft" | "active" | "pending" | "failed" | "expired";
export type IfMailboxStatus = "draft" | "active" | "pending" | "processing" | "failed";

export interface IfWorkspace {
  id: string;
  name: string;
  ip: string | null;
}

export interface IfDomain {
  id: string;
  domain: string;
  status: IfDomainStatus | string;
  workspaceId: string | null;
  expiresAt: string | null;
  hasMasking: boolean;
}

export interface IfMailbox {
  id: string;
  email: string;
  status: IfMailboxStatus | string;
  workspaceId: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface IfCredentials {
  username: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

export interface IfAvailability {
  domain: string;
  available: boolean;
  priceCents: number | null;
}

export interface IfDnsRecord {
  name: string;
  type: string;
  value: string;
}

export interface IfPreWarmed {
  id: string;
  domain: string;
  mailboxes: number;
  priceCents: number | null;
}

export interface IfContact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  organization: string;
  address1: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  dmarcEmail?: string;
  forwardToDomain?: string;
}

export interface IfPurchase<T> {
  items: T[];
  invoiceId: string | null;
  totalCents: number | null;
  /** Set when Infraforge wants a card payment instead of drawing on credits. */
  checkoutUrl: string | null;
}

export interface InfraforgeApi {
  listWorkspaces(): Promise<IfWorkspace[]>;
  createWorkspace(name: string, dedicatedIp: boolean): Promise<IfWorkspace>;
  eligibleIps(workspaceId: string): Promise<string[]>;
  creditBalance(): Promise<{ availableCents: number; autoTopup: boolean } | null>;
  checkAvailability(domains: string[]): Promise<IfAvailability[]>;
  alternativeDomains(sld: string, tld: string, count: number, exclude?: string[]): Promise<IfAvailability[]>;
  buyDomains(workspaceId: string, domains: string[], contact: IfContact): Promise<IfPurchase<{ id: string; domain: string; expiresAt: string | null }>>;
  listDomains(search?: string): Promise<IfDomain[]>;
  domainDns(domainId: string): Promise<IfDnsRecord[]>;
  setDmarc(domains: string[], policy: "none" | "quarantine" | "reject", email?: string): Promise<void>;
  buySslForwarding(domainIds: string[]): Promise<void>;
  setAutoRenew(domainIds: string[], on: boolean): Promise<void>;
  listPreWarmed(search?: string, limit?: number): Promise<IfPreWarmed[]>;
  buyPreWarmed(workspaceId: string, domainIds: string[], forwardToDomain?: string, dmarcEmail?: string): Promise<void>;
  buyMailboxes(domains: { domain: string; mailboxes: { email: string; firstName: string; lastName: string; signature?: string }[] }[]): Promise<IfPurchase<IfMailbox>>;
  listMailboxes(workspaceId?: string, search?: string): Promise<IfMailbox[]>;
  mailboxCredentials(mailboxId: string): Promise<IfCredentials>;
  deleteMailbox(mailboxId: string): Promise<void>;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** Infraforge answers lists either bare or wrapped (`{domains: [...]}`, `{data: [...]}`); this accepts both. */
export function rowsOf(r: unknown, ...keys: string[]): Json[] {
  if (Array.isArray(r)) return r as Json[];
  if (!r || typeof r !== "object") return [];
  const o = r as Json;
  for (const k of [...keys, "data", "items", "results"]) {
    const v = o[k];
    if (Array.isArray(v)) return v as Json[];
    if (v && typeof v === "object" && k === "data") {
      const inner = rowsOf(v, ...keys);
      if (inner.length) return inner;
    }
  }
  return [];
}

/** Availability prices come back in dollars (`8.99`); invoices in cents. */
function dollarsToCents(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n * 100);
}

function toDomain(d: Json): IfDomain {
  return {
    id: String(d.id ?? ""),
    domain: String(d.domain ?? d.name ?? "").toLowerCase(),
    status: String(d.status ?? "").toLowerCase(),
    workspaceId: str(d.workspaceId ?? d.workspace_id),
    expiresAt: str(d.expiresAt),
    hasMasking: Boolean(d.hasMasking ?? d.masking),
  };
}

function toMailbox(m: Json): IfMailbox {
  return {
    id: String(m.id ?? ""),
    email: String(m.email ?? m.address ?? "").toLowerCase(),
    status: String(m.status ?? "").toLowerCase(),
    workspaceId: str(m.workspaceId ?? m.workspace_id),
    firstName: str(m.firstName),
    lastName: str(m.lastName),
  };
}

function toAvailability(a: Json): IfAvailability {
  return {
    domain: String(a.domain ?? "").toLowerCase(),
    available: a.available === true,
    priceCents: num(a.priceCents) ?? dollarsToCents(a.price),
  };
}

function purchaseMeta(r: Json) {
  const inv = (r.invoice as Json | undefined) ?? {};
  return { invoiceId: str(inv.invoiceId ?? inv.id), totalCents: num(inv.totalCents ?? inv.amount), checkoutUrl: str(r.checkoutUrl ?? r.checkout_url) };
}

/** Pulls SMTP and IMAP settings out of whichever shape the mailbox comes back in. */
export function credentialsOf(m: Json, fallback = { smtpHost: env.INFRAFORGE_SMTP_HOST, smtpPort: env.INFRAFORGE_SMTP_PORT, imapHost: env.INFRAFORGE_IMAP_HOST, imapPort: env.INFRAFORGE_IMAP_PORT }): IfCredentials {
  const c = { ...m, ...((m.credentials as Json | undefined) ?? {}) } as Json;
  const pick = (...keys: string[]) => keys.map((k) => c[k]).find((v) => v !== undefined && v !== null && v !== "");
  const email = String(m.email ?? c.email ?? "");
  const password = str(pick("password", "smtpPassword", "smtp_password"));
  const smtpHost = str(pick("smtpHost", "smtp_host", "smtpServer", "host")) ?? fallback.smtpHost ?? null;
  const imapHost = str(pick("imapHost", "imap_host", "imapServer")) ?? fallback.imapHost ?? smtpHost;
  if (!password) throw new Error(`Infraforge returned no password for ${email || "the inbox"}`);
  if (!smtpHost || !imapHost) throw new Error(`Infraforge returned no SMTP/IMAP host for ${email || "the inbox"}; set INFRAFORGE_SMTP_HOST and INFRAFORGE_IMAP_HOST`);
  return {
    username: str(pick("username", "userName", "smtpUsername", "smtp_username")) ?? email,
    password,
    smtpHost,
    smtpPort: num(pick("smtpPort", "smtp_port")) ?? fallback.smtpPort,
    imapHost,
    imapPort: num(pick("imapPort", "imap_port")) ?? fallback.imapPort,
  };
}

const limiter = new Bottleneck({ maxConcurrent: 2, minTime: 250 });

export class InfraforgeClient implements InfraforgeApi {
  constructor(
    private readonly apiKey: string,
    private readonly base = env.INFRAFORGE_API_URL.replace(/\/$/, ""),
  ) {}

  /** Reads retry on 429 and 5xx. Purchases get a single attempt and a long timeout. */
  private request<T = unknown>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; purchase?: boolean } = {}): Promise<T> {
    return limiter.schedule(() =>
      fetchJson<T>(`${this.base}${path}`, {
        method,
        headers: { Authorization: this.apiKey },
        query: opts.query,
        body: opts.body,
        retries: opts.purchase ? 1 : 3,
        timeoutMs: opts.purchase ? 120_000 : 30_000,
      }),
    );
  }

  async listWorkspaces(): Promise<IfWorkspace[]> {
    const r = await this.request("GET", "/workspaces");
    return rowsOf(r, "workspaces").map((w) => ({ id: String(w.id), name: String(w.name ?? ""), ip: str(w.ip) }));
  }

  async createWorkspace(name: string, dedicatedIp: boolean): Promise<IfWorkspace> {
    const r = await this.request<Json>("POST", "/workspaces", { body: { name, attachUniqueIp: dedicatedIp }, purchase: true });
    const w = ((r.workspace as Json | undefined) ?? r) as Json;
    if (!w.id) throw new Error("Infraforge did not return a workspace id");
    return { id: String(w.id), name: String(w.name ?? name), ip: str(w.ip) };
  }

  async eligibleIps(workspaceId: string): Promise<string[]> {
    const r = await this.request("GET", `/workspaces/${encodeURIComponent(workspaceId)}/eligible-ips`);
    return (Array.isArray(r) ? r : rowsOf(r, "ips")).map((x) => (typeof x === "string" ? x : String((x as Json).ip ?? ""))).filter(Boolean);
  }

  async creditBalance(): Promise<{ availableCents: number; autoTopup: boolean } | null> {
    try {
      const r = await this.request<Json>("GET", "/credits/balance");
      const s = (r.topupSettings as Json | undefined) ?? {};
      return { availableCents: num(r.availableAmountCents) ?? 0, autoTopup: s.isEnabled === true };
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 400)) return null;
      throw e;
    }
  }

  async checkAvailability(domains: string[]): Promise<IfAvailability[]> {
    const out: IfAvailability[] = [];
    for (let i = 0; i < domains.length; i += 100) {
      const r = await this.request("POST", "/check-domain-availability-bulk", { body: { domains: domains.slice(i, i + 100) } });
      out.push(...rowsOf(r, "domains", "results").map(toAvailability));
    }
    return out;
  }

  async alternativeDomains(sld: string, tld: string, count: number, exclude: string[] = []): Promise<IfAvailability[]> {
    const r = await this.request("POST", "/domains/alternative-domains", { body: { inputSld: sld, outputTld: tld.replace(/^\./, ""), count, exclude } });
    return rowsOf(r, "domains").map(toAvailability);
  }

  async buyDomains(workspaceId: string, domains: string[], contact: IfContact) {
    const r = await this.request<Json>("POST", "/domains", { body: { workspaceId, domains, contactDetails: contact }, purchase: true });
    const items = rowsOf(r, "domains").map((d) => ({ id: String(d.id ?? ""), domain: String(d.domain ?? "").toLowerCase(), expiresAt: str(d.expiresAt) }));
    return { items, ...purchaseMeta(r ?? {}) };
  }

  async listDomains(search?: string): Promise<IfDomain[]> {
    const r = await this.request("GET", "/domains", { query: { search } });
    return rowsOf(r, "domains").map(toDomain);
  }

  async domainDns(domainId: string): Promise<IfDnsRecord[]> {
    const r = await this.request("GET", `/domains/${encodeURIComponent(domainId)}/dns`);
    return rowsOf(r, "records", "dns").map((x) => ({ name: String(x.name ?? ""), type: String(x.type ?? "").toUpperCase(), value: String(x.value ?? "") }));
  }

  async setDmarc(domains: string[], policy: "none" | "quarantine" | "reject", email?: string): Promise<void> {
    await this.request("PUT", "/domains/bulk-dns", { body: { domains, dmarcPolicy: policy, ...(email ? { dmarcEmail: email } : {}) } });
  }

  async buySslForwarding(domainIds: string[]): Promise<void> {
    await this.request("POST", "/domains/masking", { body: { domainIds, purchaseMasking: false }, purchase: true });
  }

  async setAutoRenew(domainIds: string[], on: boolean): Promise<void> {
    if (!domainIds.length) return;
    await this.request("POST", on ? "/domains/bulk-enable-autorenew" : "/domains/bulk-disable-autorenew", { body: { domainIds } });
  }

  async listPreWarmed(search?: string, limit = 100): Promise<IfPreWarmed[]> {
    const r = await this.request("GET", "/mailboxes/pre-warmed", { query: { search, limit, offset: 0 } });
    return rowsOf(r, "domains", "preWarmedDomains").map((d) => ({
      id: String(d.id ?? d.domainId ?? ""),
      domain: String(d.domain ?? d.name ?? "").toLowerCase(),
      mailboxes: Array.isArray(d.mailboxes) ? d.mailboxes.length : num(d.mailboxes ?? d.mailboxCount ?? d.mailboxesCount) ?? 0,
      priceCents: num(d.priceCents) ?? dollarsToCents(d.price),
    }));
  }

  async buyPreWarmed(workspaceId: string, domainIds: string[], forwardToDomain?: string, dmarcEmail?: string): Promise<void> {
    await this.request("POST", "/domains/pre-warmed", { body: { workspaceId, domainIds, ...(forwardToDomain ? { forwardToDomain } : {}), ...(dmarcEmail ? { dmarcEmail } : {}) }, purchase: true });
  }

  async buyMailboxes(domains: { domain: string; mailboxes: { email: string; firstName: string; lastName: string; signature?: string }[] }[]) {
    const r = await this.request<Json>("POST", "/mailboxes", { body: { domains }, purchase: true });
    return { items: rowsOf(r, "mailboxes").map(toMailbox), ...purchaseMeta(r ?? {}) };
  }

  async listMailboxes(workspaceId?: string, search?: string): Promise<IfMailbox[]> {
    const r = await this.request("GET", "/mailboxes", { query: { workspace_id: workspaceId, search } });
    return rowsOf(r, "mailboxes").map(toMailbox);
  }

  async mailboxCredentials(mailboxId: string): Promise<IfCredentials> {
    const r = await this.request<Json>("GET", `/mailboxes/${encodeURIComponent(mailboxId)}`, { query: { with_credentials: true } });
    return credentialsOf(((r.mailbox as Json | undefined) ?? (r.data as Json | undefined) ?? r) as Json);
  }

  async deleteMailbox(mailboxId: string): Promise<void> {
    try {
      await this.request("DELETE", `/mailboxes/${encodeURIComponent(mailboxId)}`);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return;
      throw e;
    }
  }
}

type Factory = () => InfraforgeApi | null;
const defaultFactory: Factory = () => (env.INFRAFORGE_API_KEY ? new InfraforgeClient(env.INFRAFORGE_API_KEY) : null);
let factory: Factory = defaultFactory;

/** The platform's Infraforge account, or null when no key is configured. */
export function infraforge(): InfraforgeApi | null {
  return factory();
}

export function setInfraforgeFactory(f: Factory | null): void {
  factory = f ?? defaultFactory;
}

/** Registrant details from the environment, or the list of what is missing. */
export function registrantContact(): { contact: IfContact | null; missing: string[] } {
  const fields: [keyof IfContact, string | undefined, string][] = [
    ["firstName", env.INFRAFORGE_CONTACT_FIRST_NAME, "INFRAFORGE_CONTACT_FIRST_NAME"],
    ["lastName", env.INFRAFORGE_CONTACT_LAST_NAME, "INFRAFORGE_CONTACT_LAST_NAME"],
    ["email", env.INFRAFORGE_CONTACT_EMAIL, "INFRAFORGE_CONTACT_EMAIL"],
    ["phone", env.INFRAFORGE_CONTACT_PHONE, "INFRAFORGE_CONTACT_PHONE"],
    ["organization", env.INFRAFORGE_CONTACT_ORG, "INFRAFORGE_CONTACT_ORG"],
    ["address1", env.INFRAFORGE_CONTACT_ADDRESS, "INFRAFORGE_CONTACT_ADDRESS"],
    ["city", env.INFRAFORGE_CONTACT_CITY, "INFRAFORGE_CONTACT_CITY"],
    ["province", env.INFRAFORGE_CONTACT_PROVINCE, "INFRAFORGE_CONTACT_PROVINCE"],
    ["postalCode", env.INFRAFORGE_CONTACT_POSTAL_CODE, "INFRAFORGE_CONTACT_POSTAL_CODE"],
    ["country", env.INFRAFORGE_CONTACT_COUNTRY, "INFRAFORGE_CONTACT_COUNTRY"],
  ];
  const missing = fields.filter(([, v]) => !v).map(([, , name]) => name);
  if (missing.length) return { contact: null, missing };
  const contact = Object.fromEntries(fields.map(([k, v]) => [k, v])) as unknown as IfContact;
  if (env.INFRAFORGE_DMARC_EMAIL) contact.dmarcEmail = env.INFRAFORGE_DMARC_EMAIL;
  return { contact, missing };
}
