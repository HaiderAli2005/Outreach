"use client";

import { ErrorState, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { useAdminOverviewQuery } from "@/store/api";
import { money, n0 } from "@/lib/format";

export default function AdminOverview() {
  const { data, isLoading, isError, error, refetch } = useAdminOverviewQuery();
  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !data) return <SkeletonRows rows={4} h={90} />;
  const v = (k: string) => Number(data[k] ?? 0);
  return (
    <>
      <ViewHead kicker="Admin" title="Platform overview." sub="Figures across every organization. Revenue is from recorded Stripe payments in the last 30 days." />
      <div className="stats4 glass">
        <div className="stat">
          <div className="big num">{n0(v("organizations"))}</div>
          <div className="sub">Organizations · {n0(v("users"))} users</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(v("activeSubscriptions"))}</div>
          <div className="sub">Active subscriptions</div>
          {v("pastDue") ? <div className="delta down">{v("pastDue")} past due</div> : null}
        </div>
        <div className="stat">
          <div className="big num">{money(v("planMrrCents"))}</div>
          <div className="sub">Plan MRR (excludes inboxes)</div>
        </div>
        <div className="stat">
          <div className="big num">{money(v("revenue30dCents"))}</div>
          <div className="sub">Collected in 30 days · {money(v("refunded30dCents"))} refunded</div>
        </div>
      </div>
      <div className="stats4 glass">
        <div className="stat">
          <div className="big num">{n0(v("sent30d"))}</div>
          <div className="sub">Emails sent in 30 days</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(v("replies30d"))}</div>
          <div className="sub">Replies in 30 days</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(v("failedWebhooks"))}</div>
          <div className="sub">Failed webhook events</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(v("openCriticalLogs"))}</div>
          <div className="sub">Open critical alerts</div>
        </div>
      </div>
      {data.byPlan.length ? (
        <div className="panel glass">
          <h3>Active subscriptions by plan</h3>
          <div className="stack" style={{ marginTop: 12 }}>
            {data.byPlan.map((p) => (
              <div className="kv" key={p.planId}>
                <span>{p.planId}</span>
                <b>{n0(p.count)}</b>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
