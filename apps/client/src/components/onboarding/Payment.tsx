"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Icon } from "@/components/ui/Icon";
import { Notice, Skeleton } from "@/components/ui/primitives";
import { errorMessage, useBillingConfigQuery, useCheckoutMutation } from "@/store/api";

const stripeCache = new Map<string, Promise<Stripe | null>>();
function stripeFor(key: string) {
  if (!stripeCache.has(key)) stripeCache.set(key, loadStripe(key));
  return stripeCache.get(key)!;
}

function idempotencyKey(orgId: string, signature: string): string {
  const k = `ap_ck_${orgId}_${signature}`;
  try {
    const found = sessionStorage.getItem(k);
    if (found) return found;
    const v = `${orgId}-${crypto.randomUUID()}`;
    sessionStorage.setItem(k, v);
    return v;
  } catch {
    return `${orgId}-${crypto.randomUUID()}`;
  }
}

export type PayHandle = () => Promise<void>;

function CardForm({ register, onPaid, onBusy, onError }: { register: (h: PayHandle | null) => void; onPaid: () => void; onBusy: (b: boolean) => void; onError: (m: string) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  useEffect(() => {
    if (!stripe || !elements) return register(null);
    register(async () => {
      onBusy(true);
      onError("");
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: `${window.location.origin}/onboarding?paid=1` },
        redirect: "if_required",
      });
      onBusy(false);
      if (error) onError(error.message ?? "The payment didn't go through. Try another card.");
      else onPaid();
    });
    return () => register(null);
  }, [stripe, elements, register, onPaid, onBusy, onError]);
  return <PaymentElement options={{ layout: "tabs" }} />;
}

export function PaymentForm({
  orgId,
  signature,
  register,
  onPaid,
  onBusy,
}: {
  orgId: string;
  signature: string;
  register: (h: PayHandle | null) => void;
  onPaid: () => void;
  onBusy: (b: boolean) => void;
}) {
  const { data: cfg, isLoading: cfgLoading } = useBillingConfigQuery();
  const [checkout, { isLoading }] = useCheckoutMutation();
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [payErr, setPayErr] = useState("");
  const started = useRef("");

  useEffect(() => {
    if (!cfg?.enabled || started.current === signature) return;
    started.current = signature;
    checkout({ idempotencyKey: idempotencyKey(orgId, signature) })
      .unwrap()
      .then((r) => setSecret(r.clientSecret))
      .catch((e) => setErr(errorMessage(e)));
  }, [cfg?.enabled, checkout, orgId, signature]);

  const stripePromise = useMemo(() => (cfg?.publishableKey ? stripeFor(cfg.publishableKey) : null), [cfg?.publishableKey]);

  if (cfgLoading) return <Skeleton h={220} r={24} />;
  if (!cfg?.enabled)
    return (
      <Notice tone="bad" title="Payments are not set up on this server">
        Stripe keys are missing, so checkout can&apos;t start. An administrator needs to add them before you can pay.
      </Notice>
    );

  return (
    <div className="cardform glass">
      <div className="top">
        <b>Card details</b>
        {cfg.publishableKey?.startsWith("pk_test") ? <span className="test">Test mode</span> : null}
      </div>
      {err ? (
        <div className="banner bad" role="alert">
          {err}
        </div>
      ) : !secret || !stripePromise || isLoading ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Skeleton h={48} />
          <Skeleton h={48} />
          <Skeleton h={48} />
        </div>
      ) : (
        <Elements
          stripe={stripePromise}
          options={{
            clientSecret: secret,
            appearance: {
              theme: "night",
              variables: { colorPrimary: "#D4AE72", colorBackground: "#1c1c1b", colorText: "#F2EEE7", colorDanger: "#E5836F", borderRadius: "12px", fontFamily: "system-ui, sans-serif" },
            },
          }}
        >
          <CardForm register={register} onPaid={onPaid} onBusy={onBusy} onError={setPayErr} />
        </Elements>
      )}
      {payErr ? (
        <div className="banner bad" role="alert">
          {payErr}
        </div>
      ) : null}
      <div className="secure">
        <Icon id="lock" />
        Payments are encrypted and processed by Stripe. Card details never touch our servers.
      </div>
    </div>
  );
}
