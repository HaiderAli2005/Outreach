"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { Button, Chip, ErrorState, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { Confirm } from "@/components/ui/overlays";
import { useToast } from "@/store";
import { errorMessage, useAdminOrganizationQuery, useAdminUpdateOrgMutation } from "@/store/api";
import { dateLong, dateTime, money, n0, titleCase } from "@/lib/format";
import type { Payment, SystemLog } from "@/lib/types";

interface OrgDetail {
  id: string;
  name: string;
  primaryDomain: string | null;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
  subscription: { status: string; dailyVolume: number; inboxQuantity: number; currentPeriodEnd: string | null; plan: { name: string; priceMonthlyCents: number } } | null;
  memberships: { id: string; role: string; status: string; invitedEmail: string | null; user: { id: string; email: string; name: string | null } | null }[];
  settings: { autopilotEnabled: boolean; autoReplyMode: string; defaultDailySendCap: number; timezone: string } | null;
  _count: { contacts: number; campaigns: number; messages: number; blocklist: number };
  payments: Payment[];
  logs: SystemLog[];
}

export default function AdminOrganization() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error, refetch } = useAdminOrganizationQuery(id);
  const [update, { isLoading: saving }] = useAdminUpdateOrgMutation();
  const [ask, setAsk] = useState(false);
  const toast = useToast();
  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !data) return <SkeletonRows rows={5} h={70} />;
  const o = data as unknown as OrgDetail;
  const suspend = o.status === "ACTIVE";
  return (
    <>
      <Link href="/admin/organizations" className="btn btn-text btn-sm" style={{ justifySelf: "start" }}>
        <Icon id="back" />
        Organizations
      </Link>
      <ViewHead
        kicker={<Chip tone={o.status === "ACTIVE" ? "g" : "r"}>{titleCase(o.status)}</Chip>}
        title={o.name}
        sub={`${o.primaryDomain ?? "No domain"} · created ${dateLong(o.createdAt)}`}
        actions={
          <Button variant={suspend ? "danger" : "primary"} onClick={() => setAsk(true)}>
            {suspend ? "Suspend" : "Reactivate"}
          </Button>
        }
      />
      <div className="stats4 glass">
        <div className="stat">
          <div className="big num">{n0(o._count.contacts)}</div>
          <div className="sub">Leads</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(o._count.campaigns)}</div>
          <div className="sub">Campaigns</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(o._count.messages)}</div>
          <div className="sub">Messages</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(o._count.blocklist)}</div>
          <div className="sub">Blocklist entries</div>
        </div>
      </div>
      <div className="grid2">
        <div className="panel glass">
          <h3>Subscription</h3>
          {o.subscription ? (
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="kv"><span>Plan</span><b>{o.subscription.plan.name} · {money(o.subscription.plan.priceMonthlyCents)}/mo</b></div>
              <div className="kv"><span>Status</span><b>{titleCase(o.subscription.status)}</b></div>
              <div className="kv"><span>Daily volume</span><b>{n0(o.subscription.dailyVolume)}</b></div>
              <div className="kv"><span>Inboxes</span><b>{n0(o.subscription.inboxQuantity)}</b></div>
              <div className="kv"><span>Period end</span><b>{o.subscription.currentPeriodEnd ? dateLong(o.subscription.currentPeriodEnd) : "n/a"}</b></div>
            </div>
          ) : (
            <p style={{ marginTop: 8 }}>No subscription.</p>
          )}
        </div>
        <div className="panel glass">
          <h3>Settings</h3>
          {o.settings ? (
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="kv"><span>Autopilot</span><b>{o.settings.autopilotEnabled ? "on" : "off"}</b></div>
              <div className="kv"><span>Automatic replies</span><b>{o.settings.autoReplyMode.toLowerCase()}</b></div>
              <div className="kv"><span>Daily send cap</span><b>{n0(o.settings.defaultDailySendCap)}</b></div>
              <div className="kv"><span>Time zone</span><b>{o.settings.timezone}</b></div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="panel glass">
        <h3>Members</h3>
        <div className="stack" style={{ marginTop: 12 }}>
          {o.memberships.map((m) => (
            <div className="kv" key={m.id}>
              <span>{m.user ? `${m.user.name ?? m.user.email} · ${m.user.email}` : `${m.invitedEmail} (invited)`}</span>
              <b>{m.role.toLowerCase()}</b>
            </div>
          ))}
        </div>
      </div>
      <div className="grid2">
        <div className="panel glass">
          <h3>Recent payments</h3>
          <div className="stack" style={{ marginTop: 12 }}>
            {o.payments.length ? o.payments.map((p) => (
              <div className="kv" key={p.id}>
                <span>{dateLong(p.createdAt)} · {titleCase(p.status)}</span>
                <b>{money(p.amountCents, { exact: true })}</b>
              </div>
            )) : <p>No payments.</p>}
          </div>
        </div>
        <div className="panel glass">
          <h3>Recent logs</h3>
          <div className="stack" style={{ marginTop: 12 }}>
            {o.logs.length ? o.logs.map((l) => (
              <div key={l.id} style={{ fontSize: 13.5 }}>
                <span className="m">{dateTime(l.createdAt)} · {l.level.toLowerCase()} · {l.source}</span>
                <div>{l.message}</div>
              </div>
            )) : <p>No log entries.</p>}
          </div>
        </div>
      </div>
      {ask ? (
        <Confirm
          title={suspend ? `Suspend ${o.name}?` : `Reactivate ${o.name}?`}
          danger={suspend}
          confirmLabel={suspend ? "Suspend" : "Reactivate"}
          loading={saving}
          onClose={() => setAsk(false)}
          onConfirm={() =>
            update({ id, status: suspend ? "SUSPENDED" : "ACTIVE" })
              .unwrap()
              .then(() => {
                setAsk(false);
                toast(suspend ? "Organization suspended" : "Organization reactivated", "good");
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body={suspend ? "Members lose access, autopilot and automatic replies are switched off and queued replies are cancelled. Billing is not changed." : "Members regain access. Autopilot stays off until they turn it back on."}
        />
      ) : null}
    </>
  );
}
