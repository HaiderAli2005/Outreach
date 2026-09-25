"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Chip, Empty, ErrorState, Pager, SkeletonRows, StatePill, ViewHead } from "@/components/ui/primitives";
import { useRole, useToast } from "@/store";
import { errorMessage, useInvoicesQuery, usePaymentsQuery, usePortalMutation, useSubscriptionQuery } from "@/store/api";
import { dateLong, money, n0, titleCase } from "@/lib/format";
import type { SubscriptionStatus } from "@/lib/types";

const SUB_TONE: Record<SubscriptionStatus, "go" | "warm" | "off" | "bad"> = {
  ACTIVE: "go",
  TRIALING: "go",
  PAST_DUE: "bad",
  UNPAID: "bad",
  INCOMPLETE: "warm",
  INCOMPLETE_EXPIRED: "off",
  CANCELED: "off",
};

const PAY_TONE: Record<string, "g" | "b" | "v" | "y" | "r"> = { SUCCEEDED: "g", PROCESSING: "b", REQUIRES_PAYMENT: "y", FAILED: "r", REFUNDED: "v", PARTIALLY_REFUNDED: "v" };

export default function BillingPage() {
  const { canManage } = useRole();
  const toast = useToast();
  const { data: sub, isLoading, isError, error, refetch } = useSubscriptionQuery();
  const [invPage, setInvPage] = useState(1);
  const [payPage, setPayPage] = useState(1);
  const { data: invoices, isLoading: invLoading } = useInvoicesQuery({ page: invPage });
  const { data: payments, isLoading: payLoading } = usePaymentsQuery({ page: payPage });
  const [portal, { isLoading: opening }] = usePortalMutation();

  const openPortal = () =>
    portal()
      .unwrap()
      .then((r) => (window.location.href = r.url))
      .catch((e) => toast(errorMessage(e), "bad"));

  return (
    <>
      <ViewHead
        kicker="Billing"
        title="Plan and payments."
        sub="Card changes, plan changes and cancellation happen in the secure Stripe billing portal."
        actions={
          canManage && sub ? (
            <Button variant="primary" icon="card" loading={opening} onClick={openPortal}>
              Manage billing
            </Button>
          ) : null
        }
      />
      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <SkeletonRows rows={2} h={80} />
      ) : !sub ? (
        <div className="glass" style={{ borderRadius: 22 }}>
          <Empty
            icon="card"
            title="No plan yet"
            action={
              <Link className="btn btn-primary btn-sm" href="/onboarding">
                Finish setup
              </Link>
            }
          >
            Pick a daily volume and sending domains to start your subscription.
          </Empty>
        </div>
      ) : (
        <div className="engine glass">
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <b style={{ font: "600 22px var(--f-display)", letterSpacing: "-.02em" }}>{sub.planName} plan</b>
              <StatePill tone={SUB_TONE[sub.status]}>{titleCase(sub.status)}</StatePill>
              {sub.cancelAtPeriodEnd ? <StatePill tone="warm">Cancels at period end</StatePill> : null}
            </div>
            <span className="muted" style={{ fontSize: 14 }}>
              {money(sub.priceMonthlyCents)}/mo plan · {sub.inboxQuantity} inboxes · up to {n0(sub.maxDailyVolume)} emails a day
              {sub.maxCampaigns ? ` · ${sub.maxCampaigns} campaign at a time` : " · unlimited campaigns"}
            </span>
          </div>
          <div className="kvgrid" style={{ minWidth: 260, flex: "0 1 420px" }}>
            <div>
              <small>Daily volume</small>
              <b>{n0(sub.dailyVolume)}</b>
            </div>
            <div>
              <small>{sub.cancelAtPeriodEnd ? "Ends" : "Renews"}</small>
              <b>{sub.currentPeriodEnd ? dateLong(sub.currentPeriodEnd) : "pending"}</b>
            </div>
          </div>
        </div>
      )}
      {sub && (sub.status === "PAST_DUE" || sub.status === "UNPAID") ? (
        <div className="banner bad" role="alert">
          <span>Your last payment failed. Update your card to keep sending.</span>
          {canManage ? (
            <Button size="sm" onClick={openPortal} loading={opening}>
              Update card
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="section-h">
        <h2>Invoices</h2>
      </div>
      <div className="tbl-wrap glass">
        {invLoading ? (
          <SkeletonRows rows={3} />
        ) : invoices?.data.length ? (
          <>
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Date</th>
                    <th>Status</th>
                    <th className="right">Amount</th>
                    <th aria-label="Links" />
                  </tr>
                </thead>
                <tbody>
                  {invoices.data.map((i) => (
                    <tr key={i.id}>
                      <td className="strong mono">{i.number ?? i.stripeInvoiceId}</td>
                      <td className="m">{dateLong(i.createdAt)}</td>
                      <td>
                        <Chip tone={i.status === "paid" ? "g" : i.status === "open" ? "y" : "v"}>{titleCase(i.status)}</Chip>
                      </td>
                      <td className="num-cell">{money(i.amountDueCents, { exact: true })}</td>
                      <td className="right">
                        {i.hostedInvoiceUrl ? (
                          <a className="btn btn-text btn-xs" href={i.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer">
                            View
                          </a>
                        ) : null}
                        {i.pdfUrl ? (
                          <a className="btn btn-text btn-xs" href={i.pdfUrl} target="_blank" rel="noopener noreferrer">
                            PDF
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={invPage} limit={20} total={invoices.meta.total ?? 0} onPage={setInvPage} />
          </>
        ) : (
          <Empty icon="list" title="No invoices yet" />
        )}
      </div>

      <div className="section-h">
        <h2>Payments</h2>
      </div>
      <div className="tbl-wrap glass">
        {payLoading ? (
          <SkeletonRows rows={3} />
        ) : payments?.data.length ? (
          <>
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Status</th>
                    <th className="right">Amount</th>
                    <th className="right">Refunded</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.data.map((p) => (
                    <tr key={p.id}>
                      <td className="m">{dateLong(p.createdAt)}</td>
                      <td>
                        {p.description ?? "Subscription payment"}
                        {p.failureMessage ? <div className="m" style={{ color: "var(--bad)" }}>{p.failureMessage}</div> : null}
                      </td>
                      <td>
                        <Chip tone={PAY_TONE[p.status] ?? "v"}>{titleCase(p.status)}</Chip>
                      </td>
                      <td className="num-cell">{money(p.amountCents, { exact: true })}</td>
                      <td className="num-cell">{p.amountRefundedCents ? money(p.amountRefundedCents, { exact: true }) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={payPage} limit={20} total={payments.meta.total ?? 0} onPage={setPayPage} />
          </>
        ) : (
          <Empty icon="card" title="No payments yet" />
        )}
      </div>
    </>
  );
}
