import { prisma } from "../lib/prisma.js";
import { getStripe } from "../modules/billing/stripe.client.js";
import { dispatchStripeEvent } from "../modules/billing/webhook.service.js";
import type Stripe from "stripe";

export async function runBillingSyncJob() {
  const stripe = getStripe();
  if (!stripe) return { skipped: "stripe-not-configured" };
  const subs = await prisma.subscription.findMany({
    where: { stripeSubscriptionId: { not: null }, OR: [{ status: { in: ["INCOMPLETE", "PAST_DUE", "UNPAID"] } }, { updatedAt: { lt: new Date(Date.now() - 86_400_000) } }] },
    take: 200,
  });
  let synced = 0;
  for (const s of subs) {
    try {
      const remote = await stripe.subscriptions.retrieve(s.stripeSubscriptionId!);
      await dispatchStripeEvent({ id: `sync_${s.id}`, type: "customer.subscription.updated", data: { object: remote } } as unknown as Stripe.Event);
      synced++;
    } catch {
      /* next run retries */
    }
  }
  return { synced, checked: subs.length };
}
