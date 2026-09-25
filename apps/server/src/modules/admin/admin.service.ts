import type { OrganizationStatus, Prisma, SubscriptionStatus, UserStatus, PaymentStatus, WebhookProvider, WebhookStatus, LogLevel } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { refundPayment } from "../billing/billing.service.js";

interface Page {
  page: number;
  limit: number;
}
const sk = (p: Page) => ({ skip: (p.page - 1) * p.limit, take: p.limit });

export async function overview() {
  const month = new Date(Date.now() - 30 * 86_400_000);
  const [users, orgs, active, pastDue, revenue, refunded, sent30, replies30, failedWebhooks, critical, byPlan] = await Promise.all([
    prisma.user.count(),
    prisma.organization.count(),
    prisma.subscription.count({ where: { status: { in: ["ACTIVE", "TRIALING"] } } }),
    prisma.subscription.count({ where: { status: "PAST_DUE" } }),
    prisma.payment.aggregate({ where: { status: { in: ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] }, createdAt: { gte: month } }, _sum: { amountCents: true } }),
    prisma.payment.aggregate({ where: { createdAt: { gte: month } }, _sum: { amountRefundedCents: true } }),
    prisma.message.count({ where: { direction: "OUTBOUND", createdAt: { gte: month } } }),
    prisma.message.count({ where: { direction: "INBOUND", createdAt: { gte: month } } }),
    prisma.webhookEvent.count({ where: { status: "FAILED" } }),
    prisma.systemLog.count({ where: { level: "CRITICAL", resolvedAt: null } }),
    prisma.subscription.groupBy({ by: ["planId"], where: { status: { in: ["ACTIVE", "TRIALING"] } }, _count: { _all: true } }),
  ]);
  const plans = await prisma.plan.findMany();
  const mrrCents = byPlan.reduce((s, r) => s + (plans.find((p) => p.id === r.planId)?.priceMonthlyCents ?? 0) * r._count._all, 0);
  return {
    users,
    organizations: orgs,
    activeSubscriptions: active,
    pastDue,
    planMrrCents: mrrCents,
    revenue30dCents: revenue._sum.amountCents ?? 0,
    refunded30dCents: refunded._sum.amountRefundedCents ?? 0,
    sent30d: sent30,
    replies30d: replies30,
    failedWebhooks,
    openCriticalLogs: critical,
    byPlan: byPlan.map((r) => ({ planId: r.planId, count: r._count._all })),
  };
}

export async function users(q: Page & { search?: string; status?: UserStatus }) {
  const where: Prisma.UserWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.search ? { OR: [{ email: { contains: q.search, mode: "insensitive" } }, { name: { contains: q.search, mode: "insensitive" } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...sk(q),
      select: { id: true, email: true, name: true, status: true, isPlatformAdmin: true, lastLoginAt: true, createdAt: true, memberships: { select: { role: true, organization: { select: { id: true, name: true } } } } },
    }),
    prisma.user.count({ where }),
  ]);
  return { rows, total };
}

export async function updateUser(actorId: string, id: string, data: { status?: UserStatus; isPlatformAdmin?: boolean }) {
  if (id === actorId && (data.status === "DISABLED" || data.isPlatformAdmin === false)) throw unprocessable("You can't disable or demote yourself");
  const user = await prisma.user.update({ where: { id }, data, select: { id: true, email: true, status: true, isPlatformAdmin: true } });
  if (data.status === "DISABLED") await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  return user;
}

export async function organizations(q: Page & { search?: string; status?: OrganizationStatus }) {
  const where: Prisma.OrganizationWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { primaryDomain: { contains: q.search, mode: "insensitive" } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...sk(q),
      select: {
        id: true, name: true, primaryDomain: true, status: true, createdAt: true,
        subscription: { select: { status: true, planId: true } },
        _count: { select: { memberships: true, contacts: true, campaigns: true } },
      },
    }),
    prisma.organization.count({ where }),
  ]);
  return { rows, total };
}

export async function organization(id: string) {
  const org = await prisma.organization.findUnique({
    where: { id },
    include: {
      subscription: { include: { plan: true } },
      memberships: { include: { user: { select: { id: true, email: true, name: true } } } },
      settings: { select: { autopilotEnabled: true, autoReplyMode: true, defaultDailySendCap: true, timezone: true } },
      _count: { select: { contacts: true, campaigns: true, messages: true, blocklist: true } },
    },
  });
  if (!org) throw notFound("Organization");
  const [payments, logs] = await Promise.all([
    prisma.payment.findMany({ where: { organizationId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.systemLog.findMany({ where: { organizationId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  return { ...org, webhookToken: undefined, payments, logs };
}

export async function updateOrganization(id: string, data: { status?: OrganizationStatus }) {
  const org = await prisma.organization.update({ where: { id }, data, select: { id: true, status: true } });
  if (data.status === "SUSPENDED") {
    await prisma.orgSettings.updateMany({ where: { organizationId: id }, data: { autopilotEnabled: false, autoReplyMode: "OFF" } });
    await prisma.autoReplyQueue.updateMany({ where: { organizationId: id, status: "PENDING" }, data: { status: "CANCELLED", cancelReason: "organization-suspended" } });
  }
  return org;
}

export async function subscriptions(q: Page & { status?: SubscriptionStatus }) {
  const where: Prisma.SubscriptionWhereInput = q.status ? { status: q.status } : {};
  const [rows, total] = await Promise.all([
    prisma.subscription.findMany({ where, orderBy: { updatedAt: "desc" }, ...sk(q), include: { plan: { select: { name: true, priceMonthlyCents: true } }, organization: { select: { id: true, name: true } } } }),
    prisma.subscription.count({ where }),
  ]);
  return { rows, total };
}

export async function payments(q: Page & { status?: PaymentStatus }) {
  const where: Prisma.PaymentWhereInput = q.status ? { status: q.status } : {};
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({ where, orderBy: { createdAt: "desc" }, ...sk(q), include: { organization: { select: { id: true, name: true } }, refunds: true } }),
    prisma.payment.count({ where }),
  ]);
  return { rows, total };
}

export function refund(adminId: string, paymentId: string, amountCents?: number, reason?: string) {
  return refundPayment(paymentId, amountCents, reason, adminId);
}

export async function webhookEvents(q: Page & { provider?: WebhookProvider; status?: WebhookStatus }) {
  const where: Prisma.WebhookEventWhereInput = { ...(q.provider ? { provider: q.provider } : {}), ...(q.status ? { status: q.status } : {}) };
  const [rows, total] = await Promise.all([
    prisma.webhookEvent.findMany({ where, orderBy: { receivedAt: "desc" }, ...sk(q), select: { id: true, provider: true, type: true, status: true, error: true, organizationId: true, receivedAt: true, processedAt: true } }),
    prisma.webhookEvent.count({ where }),
  ]);
  return { rows, total };
}

export async function systemLogs(q: Page & { level?: LogLevel; open?: boolean }) {
  const where: Prisma.SystemLogWhereInput = { ...(q.level ? { level: q.level } : {}), ...(q.open ? { resolvedAt: null } : {}) };
  const [rows, total] = await Promise.all([
    prisma.systemLog.findMany({ where, orderBy: { createdAt: "desc" }, ...sk(q), include: { organization: { select: { id: true, name: true } } } }),
    prisma.systemLog.count({ where }),
  ]);
  return { rows, total };
}
