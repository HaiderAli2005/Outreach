import type Stripe from "stripe";
import { prisma } from "../../lib/prisma.js";
import { conflict, notConfigured, notFound, unprocessable } from "../../lib/errors.js";
import { env, webOrigins, features } from "../../config/env.js";
import { planIdForVolume } from "../../config/plans.js";
import { requireStripe } from "./stripe.client.js";

export function billingConfig() {
  return { enabled: features.stripe && !!env.STRIPE_PUBLISHABLE_KEY, publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null };
}

export async function ensureCustomer(orgId: string, email: string): Promise<string> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  if (org.stripeCustomerId) return org.stripeCustomerId;
  const stripe = requireStripe();
  const customer = await stripe.customers.create(
    { email, name: org.name, metadata: { organizationId: orgId } },
    { idempotencyKey: `org:${orgId}:customer` },
  );
  await prisma.organization.update({ where: { id: orgId }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

function clientSecretOf(sub: Stripe.Subscription): string | null {
  const inv = sub.latest_invoice;
  if (!inv || typeof inv === "string") return null;
  return inv.confirmation_secret?.client_secret ?? null;
}

export async function getSubscription(orgId: string) {
  const sub = await prisma.subscription.findUnique({ where: { organizationId: orgId }, include: { plan: true } });
  if (!sub) return null;
  return {
    id: sub.id,
    status: sub.status,
    planId: sub.planId,
    planName: sub.plan.name,
    priceMonthlyCents: sub.plan.priceMonthlyCents,
    maxDailyVolume: sub.plan.maxDailyVolume,
    maxCampaigns: sub.plan.maxCampaigns,
    dailyVolume: sub.dailyVolume,
    inboxQuantity: sub.inboxQuantity,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

export async function checkout(orgId: string, email: string, idempotencyKey: string) {
  const onboarding = await prisma.onboarding.findUnique({ where: { organizationId: orgId } });
  if (!onboarding) throw unprocessable("Finish the setup steps before paying");
  const [domains, inboxCount] = await Promise.all([
    prisma.sendingDomain.findMany({ where: { organizationId: orgId, status: "SELECTED" }, orderBy: { createdAt: "asc" } }),
    prisma.mailbox.count({ where: { organizationId: orgId, status: "PLANNED" } }),
  ]);
  if (!domains.length || !inboxCount) throw unprocessable("Choose at least one sending domain and inbox first");

  const planId = planIdForVolume(onboarding.volume);
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
  if (!plan.stripePriceId || !env.STRIPE_PRICE_INBOX) throw notConfigured(`Stripe prices for the ${plan.name} plan and inboxes`);

  const existing = await prisma.subscription.findUnique({ where: { organizationId: orgId } });
  if (existing && ["ACTIVE", "TRIALING", "PAST_DUE"].includes(existing.status)) throw conflict("This organization already has a subscription. Manage it from Billing.");

  const stripe = requireStripe();
  if (existing?.stripeSubscriptionId && existing.status === "INCOMPLETE") {
    const current = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId, { expand: ["latest_invoice.confirmation_secret"] });
    const secret = clientSecretOf(current);
    if (current.status === "incomplete" && secret) return { subscriptionId: current.id, clientSecret: secret, reused: true };
  }

  const customerId = await ensureCustomer(orgId, email);
  for (const d of domains) {
    await stripe.invoiceItems.create(
      { customer: customerId, amount: d.priceCents, currency: "usd", description: `Sending domain ${d.name} (1 year)`, metadata: { organizationId: orgId, domain: d.name } },
      { idempotencyKey: `${idempotencyKey}:domain:${d.name}` },
    );
  }
  const sub = await stripe.subscriptions.create(
    {
      customer: customerId,
      items: [{ price: plan.stripePriceId }, { price: env.STRIPE_PRICE_INBOX, quantity: inboxCount }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.confirmation_secret"],
      metadata: { organizationId: orgId, planId, dailyVolume: String(onboarding.volume) },
    },
    { idempotencyKey: `${idempotencyKey}:subscription` },
  );
  const secret = clientSecretOf(sub);
  if (!secret) throw unprocessable("Stripe did not return a payment to confirm");

  await prisma.subscription.upsert({
    where: { organizationId: orgId },
    create: { organizationId: orgId, planId, status: "INCOMPLETE", stripeSubscriptionId: sub.id, dailyVolume: onboarding.volume, inboxQuantity: inboxCount },
    update: { planId, status: "INCOMPLETE", stripeSubscriptionId: sub.id, dailyVolume: onboarding.volume, inboxQuantity: inboxCount },
  });
  return { subscriptionId: sub.id, clientSecret: secret, reused: false };
}

export async function portal(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  if (!org.stripeCustomerId) throw notFound("Billing account");
  const session = await requireStripe().billingPortal.sessions.create({ customer: org.stripeCustomerId, return_url: `${webOrigins[0]}/app/billing` });
  return { url: session.url };
}

export function listInvoices(orgId: string, { skip, take }: { skip: number; take: number }) {
  return Promise.all([
    prisma.invoice.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.invoice.count({ where: { organizationId: orgId } }),
  ]);
}

export function listPayments(orgId: string, { skip, take }: { skip: number; take: number }) {
  return Promise.all([
    prisma.payment.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" }, skip, take, include: { refunds: true } }),
    prisma.payment.count({ where: { organizationId: orgId } }),
  ]);
}

export async function refundPayment(paymentId: string, amountCents: number | undefined, reason: string | undefined, adminId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw notFound("Payment");
  if (!["SUCCEEDED", "PARTIALLY_REFUNDED"].includes(payment.status)) throw unprocessable("Only successful payments can be refunded");
  const refundable = payment.amountCents - payment.amountRefundedCents;
  const amount = amountCents ?? refundable;
  if (amount <= 0 || amount > refundable) throw unprocessable(`You can refund up to ${(refundable / 100).toFixed(2)}`);
  const refund = await requireStripe().refunds.create(
    { payment_intent: payment.stripePaymentIntentId, amount, reason: "requested_by_customer", metadata: { note: reason ?? "", adminId } },
    { idempotencyKey: `refund:${payment.id}:${payment.amountRefundedCents}:${amount}` },
  );
  const row = await prisma.refund.upsert({
    where: { stripeRefundId: refund.id },
    create: { paymentId: payment.id, stripeRefundId: refund.id, amountCents: amount, reason: reason ?? null, status: refund.status ?? "pending", createdById: adminId },
    update: { status: refund.status ?? "pending" },
  });
  return row;
}
