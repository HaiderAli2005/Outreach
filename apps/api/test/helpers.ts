import request from "supertest";
import type { Express } from "express";
import type { MemberRole } from "@prisma/client";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { seedPlans } from "../src/modules/billing/plans.service.js";
import { setAiClient, type AiClient } from "../src/integrations/ai.js";
import { setSmartleadFactory, type SmartleadApi } from "../src/integrations/smartlead.js";
import { setApolloFactory } from "../src/integrations/apollo.js";
import { setVerifierFactory } from "../src/integrations/verifier.js";
import { setSlackPoster } from "../src/integrations/slack.js";
import { setStripeClient } from "../src/modules/billing/stripe.client.js";
import { setDomainChecker } from "../src/modules/onboarding/domainIdeas.js";
import { setSiteReader } from "../src/integrations/site.js";
import { setMailSender } from "../src/integrations/mailer.js";
import { hashPassword } from "../src/modules/auth/auth.service.js";
import { signAccessToken } from "../src/modules/auth/tokens.js";

let app: Express | null = null;
export function getApp(): Express {
  app ??= createApp();
  return app;
}

export const api = () => request(getApp());

const TABLES = [
  "Refund", "Payment", "Invoice", "Subscription", "WebhookEvent", "AutoReplyDecision", "AutoReplyQueue", "Message", "Contact", "Company",
  "WeeklyBatch", "Campaign", "BlocklistEntry", "SystemLog", "UsageCounter", "Mailbox", "SendingDomain", "Onboarding", "IntegrationCredential",
  "OrgSettings", "Membership", "Organization", "RefreshToken", "OAuthAccount", "EmailChallenge", "User",
];

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
  await seedPlans();
  setAiClient(null);
  setSmartleadFactory(async () => null);
  setApolloFactory(async () => null);
  setVerifierFactory(async () => null);
  setSlackPoster(async () => true);
  setStripeClient(undefined);
  setDomainChecker(async () => false);
  setSiteReader(async () => ({ home: null, pages: [] }));
  setMailSender(null);
}

export interface TestTenant {
  orgId: string;
  userId: string;
  email: string;
  token: string;
  auth: { Authorization: string };
}

let seq = 0;
export async function createTenant(opts: { role?: MemberRole; subscribed?: boolean; planId?: string; email?: string } = {}): Promise<TestTenant> {
  seq++;
  const email = opts.email ?? `user${seq}-${Date.now()}@example.com`;
  const user = await prisma.user.create({ data: { email, name: `User ${seq}`, passwordHash: await hashPassword("correct-horse-1") } });
  const org = await prisma.organization.create({ data: { name: `Org ${seq}`, primaryDomain: `org${seq}.com` } });
  await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, role: opts.role ?? "OWNER" } });
  await prisma.orgSettings.create({ data: { organizationId: org.id, senderCompany: `Org ${seq}`, timezone: "UTC", meetingLink: "https://cal.com/test/intro" } });
  if (opts.subscribed !== false) {
    await prisma.subscription.create({ data: { organizationId: org.id, planId: opts.planId ?? "growth", status: "ACTIVE", dailyVolume: 1000, inboxQuantity: 25 } });
  }
  const token = signAccessToken({ sub: user.id, org: org.id, role: opts.role ?? "OWNER", pa: false });
  return { orgId: org.id, userId: user.id, email, token, auth: { Authorization: `Bearer ${token}` } };
}

export async function addMember(tenant: TestTenant, role: MemberRole): Promise<TestTenant> {
  seq++;
  const email = `member${seq}-${Date.now()}@example.com`;
  const user = await prisma.user.create({ data: { email, name: `Member ${seq}`, passwordHash: await hashPassword("correct-horse-1") } });
  await prisma.membership.create({ data: { organizationId: tenant.orgId, userId: user.id, role } });
  const token = signAccessToken({ sub: user.id, org: tenant.orgId, role, pa: false });
  return { orgId: tenant.orgId, userId: user.id, email, token, auth: { Authorization: `Bearer ${token}` } };
}

export async function makeCampaign(orgId: string, data: Partial<{ name: string; status: "ACTIVE" | "PAUSED" | "DRAFT"; smartleadCampaignId: string }> = {}) {
  return prisma.campaign.create({ data: { organizationId: orgId, name: data.name ?? "Campaign", status: data.status ?? "ACTIVE", smartleadCampaignId: data.smartleadCampaignId } });
}

export async function makeContact(orgId: string, data: Record<string, unknown> = {}) {
  seq++;
  const email = (data.email as string) ?? `lead${seq}@company${seq}.com`;
  return prisma.contact.create({
    data: {
      organizationId: orgId,
      email,
      emailNormalized: email.toLowerCase(),
      domain: email.split("@")[1],
      companyDomain: email.split("@")[1],
      firstName: "Lead",
      fullName: `Lead ${seq}`,
      company: `Company ${seq}`,
      fitScore: 60,
      tier: "A",
      ...data,
    } as never,
  });
}

export function fakeAi(json: Record<string, unknown> | ((prompt: string) => Record<string, unknown> | null)): AiClient {
  return {
    async generateJSON<T>(prompt: string) {
      return (typeof json === "function" ? json(prompt) : json) as T;
    },
    async generateText() {
      return "text";
    },
  };
}

export class FakeSmartlead implements SmartleadApi {
  calls: { method: string; args: unknown[] }[] = [];
  leadIds = new Map<string, string>();
  statuses = new Map<string, string>();
  private log(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }
  async createCampaign(name: string) { this.log("createCampaign", name); return "sl-new"; }
  async getCampaignStatus(id: string) { this.log("getCampaignStatus", id); return "ACTIVE"; }
  async saveSequence(id: string, steps: unknown) { this.log("saveSequence", id, steps); }
  async setSchedule(id: string, s: unknown) { this.log("setSchedule", id, s); }
  async setSettings(id: string, s: unknown) { this.log("setSettings", id, s); }
  async setStatus(id: string, s: string) { this.log("setStatus", id, s); }
  async listMailboxes() { return [{ id: 11, from_email: "alex@getorg.com", from_name: "Alex", warmup: "ACTIVE" }]; }
  async attachMailboxes(id: string, ids: number[]) { this.log("attachMailboxes", id, ids); }
  async addLeads(id: string, leads: { email: string }[]) {
    this.log("addLeads", id, leads);
    const out = new Map<string, string>();
    leads.forEach((l, i) => out.set(l.email.toLowerCase(), `lead-${i}-${l.email}`));
    return out;
  }
  async leadStatusMap() { return this.statuses; }
  async findLeadId(email: string) { return this.leadIds.get(email) ?? null; }
  async pauseLead(id: string, leadId: string) { this.log("pauseLead", id, leadId); }
  async messageHistory() { return [{ type: "SENT", email_stats_id: "stats-1" }, { type: "REPLY", message_id: "msg-1", time: new Date().toISOString(), email_body: "hi" }]; }
  async replyToThread(id: string, args: unknown) { this.log("replyToThread", id, args); }
  async registerWebhook(id: string, url: string) { this.log("registerWebhook", id, url); }
}
