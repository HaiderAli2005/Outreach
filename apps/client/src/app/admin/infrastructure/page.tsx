"use client";

import { useState } from "react";
import { Button, Chip, Empty, ErrorState, Notice, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { errorMessage, useAdminInfraQuery, useAdminInfraResumeMutation, useAdminInfraRetryMutation } from "@/store/api";
import { ago, money, n0, titleCase } from "@/lib/format";

const DOMAIN_TONE: Record<string, "g" | "b" | "v" | "y" | "r"> = { REGISTERED: "g", REGISTERING: "b", PENDING_REGISTRATION: "y", FAILED: "r" };
const BOX_TONE: Record<string, "g" | "b" | "v" | "y" | "r"> = { ACTIVE: "g", WARMING: "b", CONNECTING: "b", CREATING: "b", PENDING: "y", ERROR: "r", RELEASED: "v" };
const sum = (o: Record<string, number>, ...keys: string[]) => keys.reduce((s, k) => s + (o[k] ?? 0), 0);
const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

export default function AdminInfrastructure() {
  const { data, isLoading, isError, error, refetch, isFetching } = useAdminInfraQuery(undefined, { pollingInterval: 30_000 });
  const [retry] = useAdminInfraRetryMutation();
  const [resume] = useAdminInfraResumeMutation();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !data) return <SkeletonRows rows={4} h={90} />;

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doms = data.domains;
  const boxes = data.mailboxes;
  const domTotal = total(doms);
  const boxTotal = sum(boxes, "PENDING", "CREATING", "CONNECTING", "WARMING", "ACTIVE", "ERROR");

  return (
    <>
      <ViewHead
        kicker="Admin"
        title="Infrastructure."
        sub="Sending domains and inboxes bought through Infraforge for every customer. The setup job runs every two minutes; this page refreshes every 30 seconds."
        actions={
          <Button size="sm" icon="rotate" loading={isFetching && !busy} onClick={() => refetch()}>
            Refresh
          </Button>
        }
      />

      {!data.configured ? (
        <Notice tone="warn" title="Infraforge is not connected">
          Set INFRAFORGE_API_KEY on the API server. Until then paid setups keep their domains and inboxes queued and nothing is bought.
        </Notice>
      ) : null}
      {data.configured && data.missingContact.length ? (
        <Notice tone="bad" title="Registrant details are missing">
          Domains can&apos;t be bought until these are set on the API server: {data.missingContact.join(", ")}.
        </Notice>
      ) : null}
      {data.balanceError ? (
        <Notice tone="bad" title="Couldn't read the Infraforge balance">
          {data.balanceError}
        </Notice>
      ) : null}
      {actionError ? (
        <div className="banner bad" role="alert">
          {actionError}
        </div>
      ) : null}

      <div className="stats4 glass">
        <div className="stat">
          <div className="big num">{data.balance ? money(data.balance.availableCents, { exact: true }) : "—"}</div>
          <div className="sub">Infraforge credits</div>
          {data.balance ? <div className={`delta ${data.balance.autoTopup ? "up" : "down"}`}>{data.balance.autoTopup ? "Auto top-up on" : "Auto top-up off"}</div> : null}
        </div>
        <div className="stat">
          <div className="big num">{n0(data.workspaces)}</div>
          <div className="sub">
            Customer workspaces · {n0(data.dedicatedIps)} on dedicated IPs (from {n0(data.dedicatedIpFromVolume)} emails a day)
          </div>
        </div>
        <div className="stat">
          <div className="big num">
            {n0(doms.REGISTERED ?? 0)}
            <small className="muted"> / {n0(domTotal)}</small>
          </div>
          <div className="sub">Domains registered</div>
          {sum(doms, "PENDING_REGISTRATION", "REGISTERING") ? <div className="delta">{n0(sum(doms, "PENDING_REGISTRATION", "REGISTERING"))} in progress</div> : null}
        </div>
        <div className="stat">
          <div className="big num">
            {n0(sum(boxes, "WARMING", "ACTIVE"))}
            <small className="muted"> / {n0(boxTotal)}</small>
          </div>
          <div className="sub">Inboxes live · {n0(boxes.ACTIVE ?? 0)} sending</div>
          {sum(boxes, "PENDING", "CREATING", "CONNECTING") ? <div className="delta">{n0(sum(boxes, "PENDING", "CREATING", "CONNECTING"))} being set up</div> : null}
        </div>
      </div>

      {data.held.length ? (
        <div className="tbl-wrap glass">
          <div style={{ padding: "18px 20px 6px" }}>
            <h3 style={{ margin: 0, font: "600 17px var(--f-display)" }}>Paused setups</h3>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 13.5 }}>
              Purchases for these customers are paused. Low credit holds clear themselves after a top-up; checkouts need a payment in Infraforge, then Resume.
            </p>
          </div>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Reason</th>
                  <th>Since</th>
                  <th className="right" />
                </tr>
              </thead>
              <tbody>
                {data.held.map((h) => (
                  <tr key={h.orgId}>
                    <td className="strong">{h.orgName}</td>
                    <td className="m">{h.reason}</td>
                    <td className="m">{ago(h.since)}</td>
                    <td className="right">
                      <Button size="xs" icon="rotate" loading={busy === `resume:${h.orgId}`} onClick={() => act(`resume:${h.orgId}`, () => resume({ orgId: h.orgId }).unwrap())}>
                        Resume
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="tbl-wrap glass">
        <div style={{ padding: "18px 20px 6px" }}>
          <h3 style={{ margin: 0, font: "600 17px var(--f-display)" }}>Needs attention</h3>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13.5 }}>
            Domains and inboxes that failed or keep erroring. Retry sends one round again from the step where it stopped.
          </p>
        </div>
        {data.problems.length ? (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Domain or inbox</th>
                  <th>Organization</th>
                  <th>Status</th>
                  <th>What happened</th>
                  <th className="right">Tries</th>
                  <th>Updated</th>
                  <th className="right" />
                </tr>
              </thead>
              <tbody>
                {data.problems.map((p) => (
                  <tr key={`${p.kind}:${p.id}`}>
                    <td className="mono strong">{p.name}</td>
                    <td className="m">{p.orgName}</td>
                    <td>
                      <Chip tone={(p.kind === "domain" ? DOMAIN_TONE : BOX_TONE)[p.status] ?? "y"}>{titleCase(p.status)}</Chip>
                    </td>
                    <td className="m" style={{ maxWidth: 360 }}>
                      {p.error ?? ""}
                    </td>
                    <td className="num-cell">{p.attempts}</td>
                    <td className="m">{ago(p.updatedAt)}</td>
                    <td className="right">
                      <Button size="xs" icon="rotate" loading={busy === `${p.kind}:${p.id}`} onClick={() => act(`${p.kind}:${p.id}`, () => retry({ kind: p.kind, id: p.id }).unwrap())}>
                        Retry
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: "8px 20px 22px" }}>
            <Empty icon="check" title="Nothing needs attention">
              Every domain and inbox is on track.
            </Empty>
          </div>
        )}
      </div>

      <div className="panel glass">
        <h3>Status across every customer</h3>
        <div className="inf-dist">
          <div>
            <h4>Domains</h4>
            {["PENDING_REGISTRATION", "REGISTERING", "REGISTERED", "FAILED"].map((k) => (
              <div className="inf-row" key={k}>
                <Chip tone={DOMAIN_TONE[k]}>{titleCase(k)}</Chip>
                <span className="inf-bar" aria-hidden="true">
                  <i style={{ width: `${domTotal ? ((doms[k] ?? 0) / domTotal) * 100 : 0}%` }} />
                </span>
                <b className="num">{n0(doms[k] ?? 0)}</b>
              </div>
            ))}
          </div>
          <div>
            <h4>Inboxes</h4>
            {["PENDING", "CREATING", "CONNECTING", "WARMING", "ACTIVE", "ERROR", "RELEASED"].map((k) => (
              <div className="inf-row" key={k}>
                <Chip tone={BOX_TONE[k]}>{titleCase(k)}</Chip>
                <span className="inf-bar" aria-hidden="true">
                  <i style={{ width: `${total(boxes) ? ((boxes[k] ?? 0) / total(boxes)) * 100 : 0}%` }} />
                </span>
                <b className="num">{n0(boxes[k] ?? 0)}</b>
              </div>
            ))}
          </div>
        </div>
        <p className="muted" style={{ margin: "16px 0 0", fontSize: 13 }}>
          SSL forwarding is {data.sslForwarding ? "on" : "off"} for new domains.
        </p>
      </div>
    </>
  );
}
