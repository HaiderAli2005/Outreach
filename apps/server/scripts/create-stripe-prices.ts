import Stripe from "stripe";
import { INBOX_PRICE_CENTS, PLAN_DEFINITIONS } from "../src/config/plans.js";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("Set STRIPE_SECRET_KEY first");
const stripe = new Stripe(key);

async function main() {
  const lines: string[] = [];
  for (const p of PLAN_DEFINITIONS) {
    const product = await stripe.products.create({ name: `Aperture ${p.name}`, metadata: { planId: p.id } }, { idempotencyKey: `aperture-product-${p.id}` });
    const price = await stripe.prices.create(
      { product: product.id, currency: "usd", unit_amount: p.priceMonthlyCents, recurring: { interval: "month" }, metadata: { planId: p.id } },
      { idempotencyKey: `aperture-price-${p.id}-${p.priceMonthlyCents}` },
    );
    lines.push(`STRIPE_PRICE_${p.id.toUpperCase()}=${price.id}`);
  }
  const inbox = await stripe.products.create({ name: "Aperture inbox" }, { idempotencyKey: "aperture-product-inbox" });
  const inboxPrice = await stripe.prices.create(
    { product: inbox.id, currency: "usd", unit_amount: INBOX_PRICE_CENTS, recurring: { interval: "month" } },
    { idempotencyKey: `aperture-price-inbox-${INBOX_PRICE_CENTS}` },
  );
  lines.push(`STRIPE_PRICE_INBOX=${inboxPrice.id}`);
  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
