"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";
import { errorMessage, useImportContactsMutation, useLaunchMutation, type LaunchResult } from "@/store/api";
import type { Catalogue, MarketView, OnboardingState } from "@/lib/types";
import { ago, n0 } from "@/lib/format";
import { dayN, schedule, type Totals } from "./sizing";
import type { Draft } from "./SetupSteps";
import { useDock, useDockWhen } from "./live/motion";
import type { RunState } from "./live/run";

type RowState = "done" | "run" | "wait";

function StateIcon({ s }: { s: RowState }) {
  if (s === "done")
    return (
      <span className="ps done">
        <Icon id="check" />
      </span>
    );
  return <span className={`ps ${s}`} />;
}

function CsvCard({ campaignId }: { campaignId: string | null }) {
  const [file, setFile] = useState<{ name: string; rows: number; hasEmail: boolean; text: string } | null>(null);
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [run, { isLoading }] = useImportContactsMutation();

  const read = async (f: File | undefined) => {
    if (!f) return;
    setErr("");
    setResult(null);
    if (f.size > 4_400_000) return setErr("That file is too large. Split it into smaller files.");
    const text = await f.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    setFile({ name: f.name, rows: Math.max(0, lines.length - 1), hasEmail: /e-?mail/i.test(lines[0] ?? ""), text });
  };

  return (
    <section className="pv-card">
      <div className="pv-h">
        <div>
          <h2>
            Add your own contacts <span className="fs-tag">Optional</span>
          </h2>
          <p>Upload a CSV and we&apos;ll add these people to the campaign alongside the audience we found.</p>
        </div>
      </div>
      {result ? (
        <div className="ok-line g">
          <Icon id="check" />
          <span>{result}</span>
        </div>
      ) : file ? (
        <>
          <div className={`csv-file${file.hasEmail ? "" : " bad"}`}>
            <span className="csv-ic">
              <Icon id={file.hasEmail ? "check" : "alert"} />
            </span>
            <div>
              <b>{file.name}</b>
              <span>{file.hasEmail ? `${n0(file.rows)} contacts · we check every address before sending` : "We couldn't find an email column. Add a column named “email” and upload again."}</span>
            </div>
            <button type="button" className="btn btn-text btn-sm" onClick={() => setFile(null)}>
              Remove
            </button>
          </div>
          {file.hasEmail ? (
            <Button
              variant="ghost"
              size="sm"
              style={{ marginTop: 12 }}
              loading={isLoading}
              disabled={!campaignId}
              onClick={() =>
                run({ text: file.text, campaignId: campaignId ?? undefined })
                  .unwrap()
                  .then((r) => (setResult(r.message), setFile(null)))
                  .catch((e) => setErr(errorMessage(e)))
              }
            >
              Add to the campaign
            </Button>
          ) : null}
        </>
      ) : (
        <label
          className={`drop${over ? " over" : ""}`}
          htmlFor="csvIn"
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void read(e.dataTransfer.files[0]);
          }}
        >
          <input type="file" id="csvIn" accept=".csv,text/csv" className="sr" onChange={(e) => void read(e.target.files?.[0])} />
          <Icon id="st-mail" />
          <b>Choose a CSV file</b>
          <span>or drop it here · needs an email column</span>
        </label>
      )}
      {err ? (
        <p className="au-err" role="alert" style={{ marginTop: 10 }}>
          {err}
        </p>
      ) : null}
    </section>
  );
}

export function LaunchStep({
  state,
  cat,
  t,
  draft,
  market,
  onOpenApp,
  prov,
}: {
  state: OnboardingState;
  cat: Catalogue;
  t: Totals;
  draft: Draft;
  market: MarketView | undefined;
  onOpenApp: () => void;
  /** The provisioning stream, when connected. */
  prov?: RunState;
}) {
  const dock = useDock();
  const o = state.onboarding!;
  const [launch, { isLoading, error }] = useLaunchMutation();
  const [result, setResult] = useState<LaunchResult | null>(null);
  const started = useRef(false);
  const paid = !!state.subscription && ["ACTIVE", "TRIALING", "PAST_DUE"].includes(state.subscription.status);
  const launched = !!(result || o.launchedAt);

  useEffect(() => {
    if (started.current || !paid || o.launchedAt) return;
    started.current = true;
    launch()
      .unwrap()
      .then(setResult)
      .catch(() => undefined);
  }, [paid, o.launchedAt, launch]);

  const k = schedule(cat, o.warmupDays, o.fastStart);
  const domains = state.domains;
  const boxes = state.mailboxes;
  const registered = domains.length > 0 && domains.every((d) => d.status === "REGISTERED");
  const boxesReady = boxes.length > 0 && boxes.every((m) => m.status === "WARMING" || m.status === "ACTIVE");
  const boxesActive = boxes.length > 0 && boxes.every((m) => m.status === "ACTIVE");
  const stage = !registered || !boxesReady ? 0 : boxesActive ? 2 : 1;
  const names = domains.slice(0, 2).map((d) => d.name).join(", ") + (domains.length > 2 ? ` +${domains.length - 2}` : "");
  const pendingDomains = domains.filter((d) => d.status === "PENDING_REGISTRATION").length;
  const failedDomains = domains.filter((d) => d.status === "FAILED").length;

  const rows: { t: string; d: string; s: RowState }[] = [
    {
      t: `Registering ${domains.length} domains`,
      d: registered ? names : failedDomains ? `${failedDomains} need attention` : pendingDomains ? `${pendingDomains} queued for registration` : "Waiting for payment",
      s: registered ? "done" : paid ? "run" : "wait",
    },
    { t: "Publishing SPF, DKIM and DMARC", d: registered ? `${domains.length * 4} records` : "After registration", s: registered ? "done" : "wait" },
    {
      t: `Creating ${boxes.length} inboxes`,
      d: boxesReady ? `${boxes.length} inboxes ready` : boxes.some((m) => m.status === "PENDING") ? "Queued" : "After registration",
      s: boxesReady ? "done" : registered ? "run" : "wait",
    },
    {
      t: o.fastStart ? "Connecting pre-warmed inboxes" : "Warming up inboxes",
      d: boxesActive ? "Complete" : boxesReady ? `Running · ${k.first} days` : `Starts when inboxes are ready · ${k.first} days`,
      s: boxesActive ? "done" : boxesReady ? "run" : "wait",
    },
    { t: "First campaign emails", d: boxesActive ? `Sending ${k.lo} to ${k.hi} per inbox a day` : `About day ${k.first} after inboxes are ready`, s: boxesActive ? "run" : "wait" },
  ];
  const streamed: { t: string; d: string; s: RowState }[] | null = prov?.started
    ? prov.steps.map((k) => {
        const s = prov.stepState[k];
        const last = prov.logs.filter((l) => l.step === k).at(-1);
        return { t: prov.labels[k] ?? k, d: last?.text ?? rows.find((r) => r.t === prov.labels[k])?.d ?? "", s: s === "done" ? "done" : s === "running" ? "run" : "wait" };
      })
    : null;
  const list = streamed ?? rows;
  const done = list.filter((r) => r.s === "done").length;
  const setupLanded = useDockWhen("setup", !!prov?.done, 1400);

  const head = !paid
    ? ["Waiting for payment", "Your subscription isn't active yet. Finish the payment step and setup starts straight away."]
    : [
        ["Setting up your sending", "Domains, DNS records and inboxes are being set up. You can close this page. It shows the latest status whenever you come back, and so does Setup status in the app."],
        [o.fastStart ? "Your inboxes are connected" : "Your inboxes are warming up", `No campaign emails go out during warmup. Your first emails go out about ${k.first} days after the inboxes were created.`],
        ["Your campaign is sending", `Emails are going out at ${k.lo} to ${k.hi} per inbox a day, rising to ${n0(t.capacity)} a day.`],
      ][stage];
  const pill = !paid ? (
    <span className="lp-pill warm">
      <span className="dot" />
      Payment pending
    </span>
  ) : stage === 0 ? (
    <span className="lp-pill run">
      <span className="spin" />
      Setting up
    </span>
  ) : stage === 1 ? (
    <span className="lp-pill warm">
      <span className="dot" />
      {o.fastStart ? "Connected" : "Warming up"}
    </span>
  ) : (
    <span className="lp-pill go">
      <span className="dot" />
      Sending
    </span>
  );
  const missing = result?.missing ?? [];

  return (
    <>
      <header className="an-head lp-head">
        {pill}
        <h1 className="an-h">{head[0]}</h1>
        <p className="an-p">{head[1]}</p>
      </header>
      {error ? (
        <div className="banner bad" role="alert" style={{ marginTop: 16 }}>
          <span>{errorMessage(error)}</span>
          <Button size="sm" icon="rotate" loading={isLoading} onClick={() => launch().unwrap().then(setResult).catch(() => undefined)}>
            Try again
          </Button>
        </div>
      ) : null}
      {missing.length ? (
        <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
          {missing.map((m) => (
            <div className="banner" key={m}>
              {m}
            </div>
          ))}
        </div>
      ) : null}
      {!setupLanded ? (
        <section className="pv-card lp-prov" ref={dock.source("setup")} aria-busy={!prov?.done || undefined}>
          <div className="pv-h">
            <div>
              <h2>Setup progress</h2>
              <p>
                {done} of {list.length} done{o.paidAt ? ` · paid ${ago(o.paidAt)}` : ""}
              </p>
            </div>
          </div>
          <ol className="prov2">
            {list.map((r, i) => (
              <li key={r.t} className={`${r.s} lv-arrive`} style={{ ["--i" as string]: i }}>
                <StateIcon s={r.s} />
                <b>{r.t}</b>
                <span>{r.d}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <div className="lp-grid">
        <div className="lp-main">
          <section className="pv-card lp-camp">
            <div className="pv-h">
              <div>
                <h2>{o.brand} · first campaign</h2>
                <p>
                  3 email sequence to {market?.people != null ? `${n0(market.people)} matching people` : "your buyer groups"}
                  {launched ? "" : isLoading ? " · creating the campaign" : ""}
                </p>
              </div>
            </div>
            <div className="lp-stats">
              <div>
                <small>{stage === 0 ? "Inboxes" : "Inboxes ready"}</small>
                <b>{boxes.length || t.inboxes}</b>
                <span>{stage === 0 ? "being set up" : o.fastStart ? "pre-warmed" : "warming up"}</span>
              </div>
              <div>
                <small>First campaign emails</small>
                <b>Day {k.first}</b>
                <span>
                  {k.lo} to {k.hi} per inbox · about {dayN(k.first)}
                </span>
              </div>
              <div>
                <small>Full volume</small>
                <b>Day {k.full}</b>
                <span>{n0(t.capacity || draft.volume)} a day</span>
              </div>
            </div>
          </section>
        </div>
        <aside className="lp-side">
          <CsvCard campaignId={result?.campaignId ?? state.campaign?.id ?? null} />
          <button type="button" className="btn btn-primary lp-close" onClick={onOpenApp}>
            Go to your dashboard
          </button>
          <p className="lp-back">Come back any time from Setup status in the app.</p>
        </aside>
      </div>
    </>
  );
}
