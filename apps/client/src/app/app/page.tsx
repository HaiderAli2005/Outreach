"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button, Chip, Empty, ErrorState, Skeleton, StatePill, ViewHead } from "@/components/ui/primitives";
import { Confirm } from "@/components/ui/overlays";
import { useRole, useToast } from "@/store";
import { errorMessage, useCockpitQuery, useEngineStartMutation, useEngineStopMutation } from "@/store/api";
import { REPLY_LABEL, REPLY_TONE, ago, dateShort, n0 } from "@/lib/format";
import type { Cockpit } from "@/lib/types";

const STATE: Record<Cockpit["engine"]["state"], { label: string; tone: "go" | "warm" | "off" | "bad"; text: string }> = {
  running: { label: "Running", tone: "go", text: "Finding, writing and sending on schedule." },
  reviewing: { label: "Waiting on you", tone: "warm", text: "A week of leads is ready for your review before it sends." },
  resting: { label: "Resting", tone: "off", text: "Weekends are quiet. Sending resumes on the next working day." },
  paused: { label: "Paused", tone: "off", text: "Nothing is being sent. Start again whenever you're ready." },
  unpaid: { label: "No active plan", tone: "bad", text: "Sending needs an active subscription." },
};

function delta(now: number, before: number) {
  if (!before) return null;
  const d = Math.round(((now - before) / before) * 100);
  return <div className={`delta ${d >= 0 ? "up" : "down"}`}>{d >= 0 ? `+${d}` : d}% vs last week</div>;
}

function Engine({ c }: { c: Cockpit }) {
  const { canManage } = useRole();
  const toast = useToast();
  const [stop, stopState] = useEngineStopMutation();
  const [start, startState] = useEngineStartMutation();
  const [confirm, setConfirm] = useState(false);
  const s = STATE[c.engine.state];
  const pct = c.engine.todayTarget ? Math.min(100, (c.engine.todaySent / c.engine.todayTarget) * 100) : 0;
  return (
    <div className="engine glass">
      <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <StatePill tone={s.tone} pulse={c.engine.state === "running"}>
            {s.label}
          </StatePill>
          <span className="muted" style={{ fontSize: 13 }}>
            Sending window {c.engine.window} · {c.engine.timezone}
          </span>
        </div>
        <p style={{ margin: 0, color: "var(--ink-2)" }}>{s.text}</p>
      </div>
      <div style={{ minWidth: 220, flex: "0 1 320px" }}>
        <div className="sent-top">
          <span>Sent today</span>
          <b className="num">
            {n0(c.engine.todaySent)} / {n0(c.engine.todayTarget)}
          </b>
        </div>
        <div className="track">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>
      {canManage ? (
        c.engine.on ? (
          <Button variant="ghost" icon="power" onClick={() => setConfirm(true)}>
            Stop outreach
          </Button>
        ) : c.engine.state !== "unpaid" ? (
          <Button
            variant="primary"
            icon="power"
            loading={startState.isLoading}
            onClick={() =>
              start()
                .unwrap()
                .then(() => toast("Outreach started", "good"))
                .catch((e) => toast(errorMessage(e), "bad"))
            }
          >
            Start outreach
          </Button>
        ) : (
          <Link className="btn btn-primary" href="/onboarding">
            Choose a plan
          </Link>
        )
      ) : null}
      {confirm ? (
        <Confirm
          title="Stop all outreach?"
          danger
          confirmLabel="Stop outreach"
          loading={stopState.isLoading}
          onClose={() => setConfirm(false)}
          onConfirm={() =>
            stop()
              .unwrap()
              .then((r) => {
                setConfirm(false);
                toast(`Outreach stopped. ${r.smartleadCampaignsPaused} sending campaign${r.smartleadCampaignsPaused === 1 ? "" : "s"} paused, ${r.autoRepliesCancelled} queued repl${r.autoRepliesCancelled === 1 ? "y" : "ies"} cancelled.`, "good");
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body="Autopilot turns off, sending campaigns are paused and queued automatic replies are cancelled. Replies still arrive in your inbox."
        />
      ) : null}
    </div>
  );
}

function Heartbeat({ c }: { c: Cockpit }) {
  const max = Math.max(1, ...c.heartbeat.map((h) => h.sent + h.replies));
  return (
    <div className="panel glass">
      <h3>
        Last 7 days<small>sent and replies</small>
      </h3>
      <div className="spark" style={{ marginTop: 16 }} role="img" aria-label="Emails sent and replies received per day for the last 7 days">
        {c.heartbeat.map((h) => (
          <div className="col" key={h.day} title={`${dateShort(h.day)}: ${h.sent} sent, ${h.replies} replies`}>
            <i className="r" style={{ height: `${(h.replies / max) * 100}%` }} />
            <i className="s" style={{ height: `${(h.sent / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="spark-l">
        {c.heartbeat.map((h) => (
          <span key={h.day}>{new Date(`${h.day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short" })}</span>
        ))}
      </div>
    </div>
  );
}

function Journey({ c }: { c: Cockpit }) {
  const steps: [string, number][] = [
    ["Found", c.journey.found],
    ["Written", c.journey.written],
    ["Contacted", c.journey.contacted],
    ["Replied", c.journey.replied],
  ];
  const top = Math.max(1, c.journey.found);
  return (
    <div className="panel glass">
      <h3>
        Lead journey<small>all time</small>
      </h3>
      <div className="stack" style={{ marginTop: 14 }}>
        {steps.map(([l, v]) => (
          <div key={l}>
            <div className="sent-top">
              <span>{l}</span>
              <b className="num">{n0(v)}</b>
            </div>
            <div className="track">
              <i style={{ width: `${(v / top) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CockpitPage() {
  const { data: c, isLoading, isError, error, refetch } = useCockpitQuery(undefined, { pollingInterval: 120_000, skipPollingIfUnfocused: true });

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !c)
    return (
      <div className="stack" aria-busy="true">
        <Skeleton h={40} w="40%" />
        <Skeleton h={96} r={24} />
        <Skeleton h={110} r={22} />
        <div className="grid2">
          <Skeleton h={220} r={24} />
          <Skeleton h={220} r={24} />
        </div>
      </div>
    );

  const needs = c.needsYou;
  const nothing = !needs.pendingWeeks.length && !needs.repliesWaiting;

  return (
    <>
      <ViewHead kicker="Cockpit" title="Today at a glance." sub={`${new Date(`${c.engine.dayKey}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`} />
      <Engine c={c} />

      <div className="section-h">
        <h2>Needs you</h2>
      </div>
      {nothing ? (
        <div className="ok-line g">
          <Icon id="check" />
          <span>Nothing needs you right now. New replies and weekly lead lists show up here.</span>
        </div>
      ) : (
        <div className="grid2">
          {needs.pendingWeeks.map((w) => (
            <Link key={w.batchId} href={`/app/leads?batch=${w.batchId}`} className="need glass" style={{ textDecoration: "none" }}>
              <span className="ic">
                <Icon id="users" />
              </span>
              <div>
                <b>Week of {w.label}</b> is ready: {n0(w.sendable)} of {n0(w.total)} leads can send. Review and approve.
              </div>
            </Link>
          ))}
          {needs.repliesWaiting ? (
            <Link href="/app/inbox?filter=needs" className="need glass" style={{ textDecoration: "none" }}>
              <span className="ic">
                <Icon id="inbox" />
              </span>
              <div>
                <b>
                  {n0(needs.repliesWaiting)} repl{needs.repliesWaiting === 1 ? "y" : "ies"}
                </b>{" "}
                waiting for an answer{needs.urgentReplies ? `, ${needs.urgentReplies} marked urgent` : ""}.
              </div>
            </Link>
          ) : null}
        </div>
      )}

      <div className="stats4 glass">
        {(
          [
            ["Sent this week", c.week.sent, c.lastWeek.sent],
            ["Replies", c.week.replies, c.lastWeek.replies],
            ["Leads found", c.week.found, c.lastWeek.found],
            ["Companies reached", c.week.companies, c.lastWeek.companies],
          ] as [string, number, number][]
        ).map(([l, v, b]) => (
          <div className="stat" key={l}>
            <div className="big num">{n0(v)}</div>
            <div className="sub">{l}</div>
            {delta(v, b)}
          </div>
        ))}
      </div>

      <div className="grid2">
        <Heartbeat c={c} />
        <Journey c={c} />
      </div>

      <div className="grid2">
        <div className="panel glass" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "20px 22px 8px" }}>
            <h3 style={{ margin: 0 }}>
              Latest replies<small>newest and urgent first</small>
            </h3>
          </div>
          {needs.latestReplies.length ? (
            needs.latestReplies.map((r) => (
              <Link key={r.id} href={`/app/inbox?c=${r.id}`} className="list-row" style={{ textDecoration: "none", gridTemplateColumns: "minmax(0,1fr) auto" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="who">
                    {r.lastMessageDirection === "INBOUND" ? <span className="unread" /> : null}
                    <b>{r.fullName ?? r.email}</b>
                    {r.company ? <span className="co">{r.company}</span> : null}
                  </div>
                  <p>{r.lastMessagePreview}</p>
                  {r.replyClass ? <Chip tone={REPLY_TONE[r.replyClass] ?? "v"}>{REPLY_LABEL[r.replyClass] ?? r.replyClass}</Chip> : null}
                </div>
                <span className="when">{ago(r.lastMessageAt)}</span>
              </Link>
            ))
          ) : (
            <Empty icon="inbox" title="No replies yet">
              When prospects answer, their replies appear here and in your inbox.
            </Empty>
          )}
        </div>
        <div className="panel glass">
          <h3>
            Recent activity<small>last two weeks</small>
          </h3>
          {c.activity.length ? (
            <ol className="timeline">
              {c.activity.map((a, i) => (
                <li key={i}>
                  <i />
                  <span>{a.title}</span>
                  <small>{ago(a.at)}</small>
                </li>
              ))}
            </ol>
          ) : (
            <p style={{ marginTop: 10 }}>Activity shows up here once sending starts.</p>
          )}
        </div>
      </div>

      {c.markets.length ? (
        <div className="tbl-wrap glass">
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th className="right">Contacted</th>
                  <th className="right">Replies</th>
                  <th className="right">Reply rate</th>
                </tr>
              </thead>
              <tbody>
                {c.markets.map((m) => (
                  <tr key={m.id}>
                    <td className="strong">
                      <Link href={`/app/campaigns/${m.id}`}>{m.name}</Link>
                    </td>
                    <td className="num-cell">{n0(m.contacted)}</td>
                    <td className="num-cell">{n0(m.replies)}</td>
                    <td className="num-cell">{m.replyRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
