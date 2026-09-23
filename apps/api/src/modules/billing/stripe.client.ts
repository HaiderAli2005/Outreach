import Stripe from "stripe";
import { env } from "../../config/env.js";
import { notConfigured } from "../../lib/errors.js";

let override: Stripe | null | undefined;
let cached: Stripe | null | undefined;

export function getStripe(): Stripe | null {
  if (override !== undefined) return override;
  if (cached === undefined) cached = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, appInfo: { name: "Aperture" } }) : null;
  return cached;
}

export function requireStripe(): Stripe {
  const s = getStripe();
  if (!s) throw notConfigured("Billing (STRIPE_SECRET_KEY)");
  return s;
}

export function setStripeClient(client: Stripe | null | undefined): void {
  override = client;
}

let verifier: Stripe | null = null;
export function webhookVerifier(): Stripe {
  verifier ??= new Stripe(env.STRIPE_SECRET_KEY ?? "sk_test_webhook_verification_only");
  return verifier;
}
