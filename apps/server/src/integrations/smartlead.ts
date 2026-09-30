import Bottleneck from "bottleneck";
import { fetchJson } from "./http.js";
import { getCredential } from "./credentials.js";

const BASE = "https://server.smartlead.ai/api/v1";

const limiters = new Map<string, Bottleneck>();
function limiterFor(key: string): Bottleneck {
  let l = limiters.get(key);
  if (!l) {
    l = new Bottleneck({ maxConcurrent: 1, minTime: 1200 });
    limiters.set(key, l);
  }
  return l;
}

export interface SmartleadLead {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  website?: string | null;
  location?: string | null;
  custom_fields?: Record<string, string>;
}

export interface SmtpAccount {
  fromName: string;
  fromEmail: string;
  username: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  maxPerDay: number;
  /** Warmup emails a day at the start, rising by `warmupRampup` each day. */
  warmupPerDay: number;
  warmupRampup: number;
  replyRate: number;
}

export interface SequenceStep {
  seq_number: number;
  seq_delay_details: { delay_in_days: number };
  subject: string;
  email_body: string;
}

export interface MailboxAccount {
  id: number;
  from_email: string;
  from_name: string | null;
  warmup: string | null;
}

export interface HistoryItem {
  type?: string;
  direction?: string;
  email_stats_id?: string;
  stats_id?: string;
  message_id?: string;
  time?: string;
  email_body?: string;
  body?: string;
}

export interface ReplyArgs {
  emailStatsId: string;
  emailBody: string;
  replyMessageId?: string | null;
  replyEmailTime?: string | null;
  replyEmailBody?: string | null;
  toEmail?: string | null;
  toFirstName?: string | null;
  toLastName?: string | null;
  addSignature?: boolean;
}

export interface SmartleadApi {
  createCampaign(name: string): Promise<string>;
  getCampaignStatus(campaignId: string): Promise<string>;
  saveSequence(campaignId: string, steps: SequenceStep[]): Promise<void>;
  setSchedule(campaignId: string, schedule: Record<string, unknown>): Promise<void>;
  setSettings(campaignId: string, settings: Record<string, unknown>): Promise<void>;
  setStatus(campaignId: string, status: "START" | "PAUSED" | "STOPPED"): Promise<void>;
  listMailboxes(): Promise<MailboxAccount[]>;
  attachMailboxes(campaignId: string, ids: number[]): Promise<void>;
  addLeads(campaignId: string, leads: SmartleadLead[]): Promise<Map<string, string>>;
  leadStatusMap(campaignId: string): Promise<Map<string, string>>;
  findLeadId(email: string): Promise<string | null>;
  pauseLead(campaignId: string, leadId: string): Promise<void>;
  messageHistory(campaignId: string, leadId: string): Promise<HistoryItem[]>;
  replyToThread(campaignId: string, args: ReplyArgs): Promise<void>;
  registerWebhook(campaignId: string, url: string): Promise<void>;
  /** Adds (or, with `id`, updates) an SMTP sending account with warmup on. Returns the Smartlead account id. */
  saveSmtpAccount(account: SmtpAccount, id?: number): Promise<{ id: number; smtpOk: boolean; imapOk: boolean }>;
  findAccountByEmail(email: string): Promise<number | null>;
  setAccountDailyLimit(id: number, maxPerDay: number): Promise<void>;
}

type Json = Record<string, unknown>;

export class SmartleadClient implements SmartleadApi {
  constructor(private readonly apiKey: string) {}

  private request<T = Json>(method: string, path: string, opts: { query?: Json; body?: unknown; retries?: number; timeoutMs?: number; priority?: number } = {}): Promise<T> {
    return limiterFor(this.apiKey).schedule({ priority: opts.priority ?? 5 }, () =>
      fetchJson<T>(`${BASE}${path}`, {
        method,
        query: { api_key: this.apiKey, ...(opts.query as Record<string, string>) },
        body: opts.body,
        retries: opts.retries ?? 3,
        timeoutMs: opts.timeoutMs,
      }),
    );
  }

  async createCampaign(name: string): Promise<string> {
    const r = await this.request<Json>("POST", "/campaigns/create", { body: { name, client_id: null } });
    const id = r.id ?? r.campaign_id ?? (r.data as Json | undefined)?.id;
    if (!id) throw new Error("Smartlead did not return a campaign id");
    return String(id);
  }

  async getCampaignStatus(campaignId: string): Promise<string> {
    const r = await this.request<Json>("GET", `/campaigns/${campaignId}`);
    const d = (r.data as Json | undefined) ?? r;
    return String(d.status ?? "").toUpperCase();
  }

  async saveSequence(campaignId: string, sequences: SequenceStep[]): Promise<void> {
    await this.request("POST", `/campaigns/${campaignId}/sequences`, { body: { sequences } });
  }

  async setSchedule(campaignId: string, schedule: Json): Promise<void> {
    await this.request("POST", `/campaigns/${campaignId}/schedule`, { body: schedule });
  }

  async setSettings(campaignId: string, settings: Json): Promise<void> {
    await this.request("POST", `/campaigns/${campaignId}/settings`, { body: settings });
  }

  async setStatus(campaignId: string, status: "START" | "PAUSED" | "STOPPED"): Promise<void> {
    await this.request("POST", `/campaigns/${campaignId}/status`, { body: { status } });
  }

  async listMailboxes(): Promise<MailboxAccount[]> {
    const r = await this.request<unknown>("GET", "/email-accounts/", { query: { offset: 0, limit: 200 } });
    const rows = (Array.isArray(r) ? r : ((r as Json).data as Json[]) ?? ((r as Json).email_accounts as Json[]) ?? []) as Json[];
    return rows.map((a) => ({
      id: Number(a.id ?? a.email_account_id),
      from_email: String(a.from_email ?? a.email ?? ""),
      from_name: (a.from_name as string) ?? null,
      warmup: ((a.warmup_details as Json | undefined)?.status as string) ?? (a.warmup_enabled ? "warming" : null),
    }));
  }

  async attachMailboxes(campaignId: string, ids: number[]): Promise<void> {
    await this.request("POST", `/campaigns/${campaignId}/email-accounts`, { body: { email_account_ids: ids } });
  }

  async addLeads(campaignId: string, leads: SmartleadLead[]): Promise<Map<string, string>> {
    const r = await this.request<unknown>("POST", `/campaigns/${campaignId}/leads`, {
      body: {
        lead_list: leads.slice(0, 400),
        settings: { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false, return_lead_ids: true },
      },
      retries: 1,
      timeoutMs: 120_000,
    });
    const ids = new Map<string, string>();
    const d = ((r as Json)?.data as Json | undefined) ?? (r as Json);
    const rows = ((d?.upload_status as Json[]) ?? (d?.leads as Json[]) ?? (Array.isArray(d) ? (d as Json[]) : [])) as Json[];
    for (const row of rows) {
      const em = String(row.email ?? row.lead_email ?? "").trim().toLowerCase();
      const id = row.id ?? row.lead_id;
      if (em && id != null) ids.set(em, String(id));
    }
    return ids;
  }

  async leadStatusMap(campaignId: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (let offset = 0; offset < 100_000; offset += 100) {
      const page = await this.request<Json>("GET", `/campaigns/${campaignId}/leads`, { query: { offset, limit: 100 } });
      const rows = (page.data as Json[]) ?? [];
      for (const row of rows) {
        const id = (row.lead as Json | undefined)?.id ?? row.lead_id;
        if (id != null) map.set(String(id), String(row.status ?? "").toUpperCase());
      }
      if (rows.length < 100) break;
    }
    return map;
  }

  async findLeadId(email: string): Promise<string | null> {
    const r = await this.request<unknown>("GET", "/leads/", { query: { email } });
    const d = ((r as Json)?.data as unknown) ?? r;
    const row = (Array.isArray(d) ? d[0] : d) as Json | undefined;
    const id = row?.id ?? row?.lead_id;
    return id != null ? String(id) : null;
  }

  async pauseLead(campaignId: string, leadId: string): Promise<void> {
    await this.request("POST", `/campaigns/${campaignId}/leads/${leadId}/pause`);
  }

  async messageHistory(campaignId: string, leadId: string): Promise<HistoryItem[]> {
    const r = await this.request<Json>("GET", `/campaigns/${campaignId}/leads/${leadId}/message-history`, { priority: 1 });
    return ((r.history as HistoryItem[]) ?? ((r.data as Json | undefined)?.history as HistoryItem[]) ?? []) as HistoryItem[];
  }

  async replyToThread(campaignId: string, a: ReplyArgs): Promise<void> {
    await this.request("POST", `/campaigns/${campaignId}/reply-email-thread`, {
      body: {
        email_stats_id: a.emailStatsId,
        email_body: a.emailBody,
        ...(a.replyMessageId ? { reply_message_id: a.replyMessageId } : {}),
        ...(a.replyEmailTime ? { reply_email_time: a.replyEmailTime } : {}),
        ...(a.replyEmailBody ? { reply_email_body: a.replyEmailBody } : {}),
        ...(a.toEmail ? { to_email: a.toEmail } : {}),
        ...(a.toFirstName ? { to_first_name: a.toFirstName } : {}),
        ...(a.toLastName ? { to_last_name: a.toLastName } : {}),
        add_signature: a.addSignature !== false,
      },
      retries: 1,
      priority: 1,
    });
  }

  async saveSmtpAccount(a: SmtpAccount, id?: number): Promise<{ id: number; smtpOk: boolean; imapOk: boolean }> {
    const r = await this.request<Json>("POST", "/email-accounts/save", {
      body: {
        ...(id ? { id } : {}),
        from_name: a.fromName,
        from_email: a.fromEmail,
        user_name: a.username,
        password: a.password,
        smtp_host: a.smtpHost,
        smtp_port: a.smtpPort,
        imap_host: a.imapHost,
        imap_port: a.imapPort,
        max_email_per_day: a.maxPerDay,
        warmup_enabled: true,
        total_warmup_per_day: a.warmupPerDay,
        daily_rampup: a.warmupRampup,
        reply_rate_percentage: a.replyRate,
      },
      retries: 1,
      timeoutMs: 90_000,
    });
    const d = ((r.data as Json | undefined) ?? r) as Json;
    const got = Number(d.id ?? d.email_account_id ?? id);
    if (!got) throw new Error(String(r.message ?? "Smartlead did not return an email account id"));
    return { id: got, smtpOk: d.is_smtp_success !== false, imapOk: d.is_imap_success !== false };
  }

  async findAccountByEmail(email: string): Promise<number | null> {
    const want = email.trim().toLowerCase();
    for (let offset = 0; offset < 10_000; offset += 100) {
      const r = await this.request<unknown>("GET", "/email-accounts/", { query: { offset, limit: 100 } });
      const rows = (Array.isArray(r) ? r : ((r as Json).data as Json[]) ?? ((r as Json).email_accounts as Json[]) ?? []) as Json[];
      const hit = rows.find((a) => String(a.from_email ?? a.email ?? "").toLowerCase() === want);
      if (hit) return Number(hit.id ?? hit.email_account_id);
      if (rows.length < 100) break;
    }
    return null;
  }

  async setAccountDailyLimit(id: number, maxPerDay: number): Promise<void> {
    await this.request("POST", `/email-accounts/${id}`, { body: { max_email_per_day: maxPerDay } });
  }

  async registerWebhook(campaignId: string, url: string): Promise<void> {
    const events = ["EMAIL_REPLY", "EMAIL_SENT", "EMAIL_BOUNCE", "LEAD_UNSUBSCRIBED", "MANUAL_REPLY_SENT"];
    try {
      await this.request("POST", `/campaigns/${campaignId}/webhooks`, { body: { id: null, name: "aperture", webhook_url: url, event_types: events } });
    } catch {
      await this.request("POST", `/campaigns/${campaignId}/webhooks`, { body: { id: null, name: "aperture", webhook_url: url, event_types: events.slice(0, 4) } });
    }
  }
}

type Factory = (orgId: string) => Promise<SmartleadApi | null>;

const defaultFactory: Factory = async (orgId) => {
  const key = await getCredential(orgId, "SMARTLEAD");
  return key ? new SmartleadClient(key) : null;
};

let factory: Factory = defaultFactory;

export function smartleadFor(orgId: string): Promise<SmartleadApi | null> {
  return factory(orgId);
}

export function setSmartleadFactory(f: Factory | null): void {
  factory = f ?? defaultFactory;
}

export function smartleadSchedule(timezone: string, start: string, end: string, maxNewLeadsPerDay?: number): Record<string, unknown> {
  return {
    timezone,
    days_of_the_week: [1, 2, 3, 4, 5],
    start_hour: start,
    end_hour: end,
    min_time_btw_emails: 13,
    ...(maxNewLeadsPerDay ? { max_new_leads_per_day: maxNewLeadsPerDay } : {}),
  };
}
