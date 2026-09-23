import { beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { api, createTenant, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setStripeClient } from "../src/modules/billing/stripe.client.js";

const WEBHOOK_SECRET = "whsec_test_secret";
const signer = new Stripe("sk_test_fake");

function signed(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
}

function fakeStripe() {
  const calls: { op: string; args: unknown[] }[] = [];
  let subCounter = 0;
  const subscriptions = new Map<string, Record<string, unknown>>();
  const client = {
    calls,
    customers: { create: async (...args: unknown[]) => (calls.push({ op: "customers.create", args }), { id: "cus_test_1" }) },
    invoiceItems: { create: async (...args: unknown[]) => (calls.push({ op: "invoiceItems.create", args }), { id: `ii_${calls.length}` }) },
    subscriptions: {
      create: async (...args: unknown[]) => {
        calls.push({ op: "subscriptions.create", args });
        const opts = args[1] as { idempotencyKey?: string };
        const existing = [...subscriptions.values()].find((s) => s._key === opts?.idempotencyKey);
        if (existing) return existing;
        subCounter++;
        const sub = {
          id: `sub_test_${subCounter}`,
          _key: opts?.idempotencyKey,
          status: "incomplete",
          customer: "cus_test_1",
          metadata: (args[0] as { metadata: Record<string, string> }).metadata,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_growth" }, quantity: 1, current_period_end: 1893456000 }, { price: { id: "price_inbox" }, quantity: 6, current_period_end: 1893456000 }] },
          latest_invoice: { id: "in_1", confirmation_secret: { client_secret: `pi_secret_${subCounter}` } },
        };
        subscriptions.set(sub.id, sub);
        return sub;
      },
      retrieve: async (id: string) => {
        calls.push({ op: "subscriptions.retrieve", args: [id] });
        return subscriptions.get(id);
      },
    },
    billingPortal: { sessions: { create: async () => ({ url: "https://billing.stripe.test/session" }) } },
    refunds: { create: async (...args: unknown[]) => (calls.push({ op: "refunds.create", args }), { id: `re_${calls.length}`, status: "pending" }) },
    setStatus(id: string, status: string) {
      const s = subscriptions.get(id);
      if (s) s.status = status;
    },
  };
  return client;
}

async function readyForCheckout(orgId: string) {
  await prisma.onboarding.create({ data: { organizationId: orgId, domain: "northwind.io", brand: "Northwind", icp: {}, volume: 1000 } });
  const d = await prisma.sendingDomain.create({ data: { organizationId: orgId, name: "getnorthwind.com", priceCents: 1499 } });
  await prisma.mailbox.createMany({ data: [1, 2, 3].map((i) => ({ organizationId: orgId, sendingDomainId: d.id, address: `a${i}@getnorthwind.com` })) });
}

describe("billing", () => {
  let stripe: ReturnType<typeof fakeStripe>;
  beforeEach(async () => {
    await resetDb();
    stripe = fakeStripe();
    setStripeClient(stripe as unknown as Stripe);
  });

  it("serves the plan catalogue publicly", async () => {
    const res = await api().get("/api/v1/billing/plans").expect(200);
    expect(res.body.data.plans.map((p: { id: string }) => p.id)).toEqual(["launch", "growth", "scale"]);
    expect(res.body.data.sizing.sendsPerWarmInbox).toBe(40);
  });

  it("creates a customer, domain items and an incomplete subscription at checkout", async () => {
    const t = await createTenant({ subscribed: false });
    await readyForCheckout(t.orgId);
    const res = await api().post("/api/v1/billing/checkout").set(t.auth).set("Idempotency-Key", "checkout-attempt-1");
    expect(res.status).toBe(200);
    expect(res.body.data.clientSecret).toBe("pi_secret_1");
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(sub.status).toBe("INCOMPLETE");
    expect(sub.planId).toBe("growth");
    expect(sub.inboxQuantity).toBe(3);
    const create = stripe.calls.find((c) => c.op === "subscriptions.create")!;
    expect((create.args[0] as { items: unknown[] }).items).toEqual([{ price: "price_growth" }, { price: "price_inbox", quantity: 3 }]);
    expect((create.args[1] as { idempotencyKey: string }).idempotencyKey).toBe("checkout-attempt-1:subscription");
    expect(stripe.calls.filter((c) => c.op === "invoiceItems.create")).toHaveLength(1);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: t.orgId } });
    expect(org.stripeCustomerId).toBe("cus_test_1");
  });

  it("reuses the pending subscription instead of creating a second one", async () => {
    const t = await createTenant({ subscribed: false });
    await readyForCheckout(t.orgId);
    const a = await api().post("/api/v1/billing/checkout").set(t.auth).set("Idempotency-Key", "attempt-aaaa");
    const b = await api().post("/api/v1/billing/checkout").set(t.auth).set("Idempotency-Key", "attempt-bbbb");
    expect(b.body.data.subscriptionId).toBe(a.body.data.subscriptionId);
    expect(b.body.data.reused).toBe(true);
    expect(stripe.calls.filter((c) => c.op === "subscriptions.create")).toHaveLength(1);
  });

  it("requires an idempotency key and a completed setup", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/billing/checkout").set(t.auth).expect(400);
    await api().post("/api/v1/billing/checkout").set(t.auth).set("Idempotency-Key", "attempt-cccc").expect(422);
  });

  it("rejects webhooks with a bad signature", async () => {
    const res = await api().post("/api/v1/billing/webhook").set("Stripe-Signature", "t=1,v1=deadbeef").set("Content-Type", "application/json").send(JSON.stringify({ id: "evt_1" }));
    expect(res.status).toBe(400);
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it("activates the subscription on invoice.paid and ignores the duplicate delivery", async () => {
    const t = await createTenant({ subscribed: false });
    await readyForCheckout(t.orgId);
    const co = await api().post("/api/v1/billing/checkout").set(t.auth).set("Idempotency-Key", "attempt-paid");
    stripe.setStatus(co.body.data.subscriptionId, "active");
    const event = {
      id: "evt_paid_1",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1", customer: "cus_test_1", status: "paid", amount_due: 23799, amount_paid: 23799, currency: "usd", number: "A-1",
          parent: { subscription_details: { subscription: co.body.data.subscriptionId } },
        },
      },
    };
    const { payload, header } = signed(event);
    const r1 = await api().post("/api/v1/billing/webhook").set("Stripe-Signature", header).set("Content-Type", "application/json").send(payload);
    expect(r1.status).toBe(200);
    expect(r1.body.data.duplicate).toBe(false);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(sub.status).toBe("ACTIVE");
    expect(sub.currentPeriodEnd).not.toBeNull();
    expect((await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } })).paidAt).not.toBeNull();
    expect((await prisma.sendingDomain.findFirstOrThrow({ where: { organizationId: t.orgId } })).status).toBe("PENDING_REGISTRATION");
    expect(await prisma.invoice.count({ where: { organizationId: t.orgId } })).toBe(1);

    const again = signed(event);
    const r2 = await api().post("/api/v1/billing/webhook").set("Stripe-Signature", again.header).set("Content-Type", "application/json").send(again.payload);
    expect(r2.body.data.duplicate).toBe(true);
    expect(stripe.calls.filter((c) => c.op === "subscriptions.retrieve")).toHaveLength(1);
  });

  it("records successful and failed payments and moves a failing subscription to past due", async () => {
    const t = await createTenant();
    await prisma.organization.update({ where: { id: t.orgId }, data: { stripeCustomerId: "cus_test_1" } });
    await prisma.subscription.update({ where: { organizationId: t.orgId }, data: { stripeSubscriptionId: "sub_live" } });
    const ok = signed({ id: "evt_pi_ok", type: "payment_intent.succeeded", data: { object: { id: "pi_1", customer: "cus_test_1", amount: 23799, currency: "usd" } } });
    await api().post("/api/v1/billing/webhook").set("Stripe-Signature", ok.header).set("Content-Type", "application/json").send(ok.payload).expect(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { stripePaymentIntentId: "pi_1" } })).status).toBe("SUCCEEDED");

    const failPi = signed({ id: "evt_pi_fail", type: "payment_intent.payment_failed", data: { object: { id: "pi_2", customer: "cus_test_1", amount: 23799, currency: "usd", last_payment_error: { message: "Your card was declined." } } } });
    await api().post("/api/v1/billing/webhook").set("Stripe-Signature", failPi.header).set("Content-Type", "application/json").send(failPi.payload).expect(200);
    const failed = await prisma.payment.findUniqueOrThrow({ where: { stripePaymentIntentId: "pi_2" } });
    expect(failed.status).toBe("FAILED");
    expect(failed.failureMessage).toBe("Your card was declined.");

    const inv = signed({ id: "evt_inv_fail", type: "invoice.payment_failed", data: { object: { id: "in_9", customer: "cus_test_1", status: "open", amount_due: 23799, amount_paid: 0, currency: "usd", parent: { subscription_details: { subscription: "sub_live" } } } } });
    await api().post("/api/v1/billing/webhook").set("Stripe-Signature", inv.header).set("Content-Type", "application/json").send(inv.payload).expect(200);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { organizationId: t.orgId } })).status).toBe("PAST_DUE");
    expect(await prisma.systemLog.count({ where: { organizationId: t.orgId, source: "billing" } })).toBe(1);

    await api().post("/api/v1/engine/start").set(t.auth).expect(402);
  });

  it("lets a platform admin refund a payment and syncs the refund from the webhook", async () => {
    const t = await createTenant();
    await prisma.user.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    const payment = await prisma.payment.create({ data: { organizationId: t.orgId, stripePaymentIntentId: "pi_refund", amountCents: 10000, status: "SUCCEEDED" } });
    const tooMuch = await api().post(`/api/v1/admin/payments/${payment.id}/refund`).set(t.auth).send({ amountCents: 20000 });
    expect(tooMuch.status).toBe(422);
    const res = await api().post(`/api/v1/admin/payments/${payment.id}/refund`).set(t.auth).send({ amountCents: 4000, reason: "goodwill" });
    expect(res.status).toBe(200);
    const call = stripe.calls.find((c) => c.op === "refunds.create")!;
    expect(call.args[0]).toMatchObject({ payment_intent: "pi_refund", amount: 4000 });
    const ev = signed({ id: "evt_refund", type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: "pi_refund", amount_refunded: 4000 } } });
    await api().post("/api/v1/billing/webhook").set("Stripe-Signature", ev.header).set("Content-Type", "application/json").send(ev.payload).expect(200);
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(p.status).toBe("PARTIALLY_REFUNDED");
    expect(p.amountRefundedCents).toBe(4000);
  });

  it("switches the engine off when a subscription is cancelled", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: true } });
    await prisma.subscription.update({ where: { organizationId: t.orgId }, data: { stripeSubscriptionId: "sub_c" } });
    const ev = signed({ id: "evt_del", type: "customer.subscription.deleted", data: { object: { id: "sub_c", status: "canceled", customer: "cus_x", metadata: {}, items: { data: [] } } } });
    await api().post("/api/v1/billing/webhook").set("Stripe-Signature", ev.header).set("Content-Type", "application/json").send(ev.payload).expect(200);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { organizationId: t.orgId } })).status).toBe("CANCELED");
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } })).autopilotEnabled).toBe(false);
  });
});
