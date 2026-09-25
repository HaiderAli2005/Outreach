import type Stripe from "stripe";
import type { PaymentStatus, Prisma, SubscriptionStatus } from "@prisma/client";
import { prisma, isUniqueViolation } from "../../lib/prisma.js";
import { badRequest } from "../../lib/errors.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { logSystem } from "../../domain/systemLog.js";
import { getStripe, webhookVerifier } from "./stripe.client.js";

const STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: "ACTIVE",
  trialing: "TRIALING",
  past_due: "PAST_DUE",
  unpaid: "UNPAID",
  canceled: "CANCELED",
  incomplete: "INCOMPLETE",
  incomplete_expired: "INCOMPLETE_EXPIRED",
  paused: "PAST_DUE",
};

export function verifyStripeEvent(rawBody: Buffer | undefined, signature: string | undefined): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) throw badRequest("Stripe webhook secret is not configured");
  if (!rawBody || !signature) throw badRequest("Missing Stripe signature");
  try {
    return webhookVerifier().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw badRequest("Invalid Stripe signature");
  }
}

async function orgForCustomer(customer: string | { id: string } | null | undefined): Promise<string | null> {
  const id = typeof customer === "string" ? customer : customer?.id;
  if (!id) return null;
  const org = await prisma.organization.findUnique({ where: { stripeCustomerId: id }, select: { id: true } });
  return org?.id ?? null;
}

function subscriptionIdOfInvoice(inv: Stripe.Invoice): string | null {
  const s = inv.parent?.subscription_details?.subscription;
  return typeof s === "string" ? s : (s?.id ?? null);
}

function periodEnd(sub: Stripe.Subscription): Date | null {
  const ends = sub.items?.data?.map((i) => i.current_period_end).filter((n): n is number => typeof n === "number") ?? [];
  return ends.length ? new Date(Math.max(...ends) * 1000) : null;
}

async function syncSubscription(sub: Stripe.Subscription): Promise<void> {
  const status = STATUS_MAP[sub.status] ?? "INCOMPLETE";
  const inboxItem = sub.items?.data?.find((i) => i.price?.id === env.STRIPE_PRICE_INBOX);
  const planItem = sub.items?.data?.find((i) => i.price?.id !== env.STRIPE_PRICE_INBOX);
  const plan = planItem?.price?.id ? await prisma.plan.findFirst({ where: { stripePriceId: planItem.price.id } }) : null;
  const existing = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: sub.id } });
  const orgId = existing?.organizationId ?? (sub.metadata?.organizationId || (await orgForCustomer(sub.customer as string)));
  if (!orgId) return;
  const data = {
    status,
    currentPeriodEnd: periodEnd(sub),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    ...(plan ? { planId: plan.id } : {}),
    ...(inboxItem?.quantity ? { inboxQuantity: inboxItem.quantity } : {}),
  };
  if (existing) await prisma.subscription.update({ where: { id: existing.id }, data });
  else if (plan) {
    await prisma.subscription.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, stripeSubscriptionId: sub.id, planId: plan.id, dailyVolume: Number(sub.metadata?.dailyVolume || plan.maxDailyVolume), inboxQuantity: inboxItem?.quantity ?? 0, ...data },
      update: { stripeSubscriptionId: sub.id, ...data },
    });
  }
  if (status === "CANCELED") {
    await prisma.orgSettings.updateMany({ where: { organizationId: orgId }, data: { autopilotEnabled: false, autoReplyMode: "OFF" } });
  }
}

async function upsertInvoice(orgId: string, inv: Stripe.Invoice): Promise<void> {
  const data = {
    number: inv.number ?? null,
    status: String(inv.status ?? "draft"),
    amountDueCents: inv.amount_due ?? 0,
    amountPaidCents: inv.amount_paid ?? 0,
    currency: inv.currency ?? "usd",
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    pdfUrl: inv.invoice_pdf ?? null,
    periodStart: inv.period_start ? new Date(inv.period_start * 1000) : null,
    periodEnd: inv.period_end ? new Date(inv.period_end * 1000) : null,
  };
  await prisma.invoice.upsert({ where: { stripeInvoiceId: inv.id! }, create: { organizationId: orgId, stripeInvoiceId: inv.id!, ...data }, update: data });
}

async function onInvoicePaid(inv: Stripe.Invoice): Promise<void> {
  const orgId = await orgForCustomer(inv.customer as string);
  if (!orgId) return;
  await upsertInvoice(orgId, inv);
  const subId = subscriptionIdOfInvoice(inv);
  if (subId) {
    const stripe = getStripe();
    if (stripe) {
      await syncSubscription(await stripe.subscriptions.retrieve(subId));
    } else {
      await prisma.subscription.updateMany({ where: { stripeSubscriptionId: subId }, data: { status: "ACTIVE" } });
    }
  }
  const onboarding = await prisma.onboarding.findUnique({ where: { organizationId: orgId } });
  if (onboarding && !onboarding.paidAt) {
    await prisma.$transaction([
      prisma.onboarding.update({ where: { organizationId: orgId }, data: { paidAt: new Date() } }),
      prisma.sendingDomain.updateMany({ where: { organizationId: orgId, status: "SELECTED" }, data: { status: "PENDING_REGISTRATION" } }),
      prisma.mailbox.updateMany({ where: { organizationId: orgId, status: "PLANNED" }, data: { status: "PENDING" } }),
    ]);
  }
}

async function onInvoiceFailed(inv: Stripe.Invoice): Promise<void> {
  const orgId = await orgForCustomer(inv.customer as string);
  if (!orgId) return;
  await upsertInvoice(orgId, inv);
  const subId = subscriptionIdOfInvoice(inv);
  if (subId) {
    await prisma.subscription.updateMany({ where: { stripeSubscriptionId: subId, status: { in: ["ACTIVE", "TRIALING"] } }, data: { status: "PAST_DUE" } });
  }
  await logSystem(orgId, "WARN", "billing", `A payment of ${((inv.amount_due ?? 0) / 100).toFixed(2)} ${String(inv.currency ?? "usd").toUpperCase()} failed. Update your card from Billing to keep sending.`);
}

async function upsertPayment(pi: Stripe.PaymentIntent, status: PaymentStatus): Promise<void> {
  const orgId = await orgForCustomer(pi.customer as string);
  if (!orgId) return;
  const data = {
    amountCents: pi.amount,
    currency: pi.currency,
    status,
    failureMessage: pi.last_payment_error?.message?.slice(0, 500) ?? null,
    description: pi.description ?? null,
  };
  await prisma.payment.upsert({ where: { stripePaymentIntentId: pi.id }, create: { organizationId: orgId, stripePaymentIntentId: pi.id, ...data }, update: data });
}

async function onChargeRefunded(charge: Stripe.Charge): Promise<void> {
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!piId) return;
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: piId } });
  if (!payment) return;
  const refunded = charge.amount_refunded ?? 0;
  await prisma.payment.update({
    where: { id: payment.id },
    data: { amountRefundedCents: refunded, status: refunded >= payment.amountCents ? "REFUNDED" : refunded > 0 ? "PARTIALLY_REFUNDED" : payment.status },
  });
  await prisma.refund.updateMany({ where: { paymentId: payment.id, status: "pending" }, data: { status: "succeeded" } });
}

export async function dispatchStripeEvent(event: Stripe.Event): Promise<boolean> {
  switch (event.type) {
    case "invoice.paid":
      await onInvoicePaid(event.data.object as Stripe.Invoice);
      return true;
    case "invoice.payment_failed":
      await onInvoiceFailed(event.data.object as Stripe.Invoice);
      return true;
    case "invoice.finalized":
    case "invoice.updated": {
      const inv = event.data.object as Stripe.Invoice;
      const orgId = await orgForCustomer(inv.customer as string);
      if (orgId) await upsertInvoice(orgId, inv);
      return true;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(event.data.object as Stripe.Subscription);
      return true;
    case "payment_intent.succeeded":
      await upsertPayment(event.data.object as Stripe.PaymentIntent, "SUCCEEDED");
      return true;
    case "payment_intent.payment_failed":
      await upsertPayment(event.data.object as Stripe.PaymentIntent, "FAILED");
      return true;
    case "payment_intent.processing":
      await upsertPayment(event.data.object as Stripe.PaymentIntent, "PROCESSING");
      return true;
    case "charge.refunded":
      await onChargeRefunded(event.data.object as Stripe.Charge);
      return true;
    default:
      return false;
  }
}

export async function handleStripeWebhook(event: Stripe.Event): Promise<{ duplicate: boolean }> {
  const key = { provider_externalId: { provider: "STRIPE" as const, externalId: event.id } };
  let row = await prisma.webhookEvent.findUnique({ where: key });
  if (row && row.status !== "FAILED") return { duplicate: true };
  if (!row) {
    try {
      row = await prisma.webhookEvent.create({
        data: { provider: "STRIPE", externalId: event.id, type: event.type, payload: event as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { duplicate: true };
      throw err;
    }
  }
  try {
    const handled = await dispatchStripeEvent(event);
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: handled ? "PROCESSED" : "IGNORED", processedAt: new Date(), error: null } });
    return { duplicate: false };
  } catch (err) {
    logger.error({ err, eventId: event.id, type: event.type }, "stripe webhook failed");
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: "FAILED", error: (err as Error).message.slice(0, 1000) } });
    throw err;
  }
}
