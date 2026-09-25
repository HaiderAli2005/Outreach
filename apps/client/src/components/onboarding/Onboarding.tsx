"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon, Mark, type IconId } from "@/components/ui/Icon";
import { ErrorState } from "@/components/ui/primitives";
import { FullPageLoader, useSessionBootstrap } from "@/components/shell/session";
import { useCreateWorkspace } from "@/components/shell/NoWorkspace";
import { useAppSelector, useToast } from "@/store";
import {
  errorMessage,
  useOnboardingMarketQuery,
  useOnboardingQuery,
  useOnboardingStartMutation,
  useOnboardingUpdateMutation,
  usePlansQuery,
  useSaveDomainsMutation,
  useSubscriptionQuery,
} from "@/store/api";
import type { OnboardingState } from "@/lib/types";
import { money, normDomain, validDomain } from "@/lib/format";
import { AuthCard } from "./AuthStep";
import { AnalysisStep } from "./AnalysisStep";
import { PreviewStep } from "./PreviewStep";
import { DomainsStep, InboxesStep, PaymentStep, VolumeStep, type Draft } from "./SetupSteps";
import { DockProvider, ProgressRing, useDock } from "./live/motion";
import { useRunStream } from "./live/run";
import { Rail, type RailLog } from "./live/Rail";
import { AnalysisFlow, type AnalysisView } from "./live/AnalysisFlow";
import { PHASES, type PhaseKey } from "./live/LiveAnalysis";
import { railCards, runningTotal } from "./live/cards";
import { LaunchStep } from "./LaunchStep";
import { recommendedVolume, totals } from "./sizing";
import type { PayHandle } from "./Payment";

const STEPS: [string, IconId][] = [
  ["Domain", "globe"],
  ["Sign up", "st-user"],
  ["Analysis", "st-scan"],
  ["Free overview", "st-mail"],
  ["Emails per day", "st-gauge"],
  ["Sending domains", "globe"],
  ["Inboxes and warmup", "inbox"],
  ["Payment", "st-card"],
  ["Campaign start", "st-send"],
];
const PAID = ["ACTIVE", "TRIALING", "PAST_DUE"];
const LIVE_KEYS = ["business", "buyers", "market", "sequence"];
const ALL_KEYS = [...LIVE_KEYS, "volume", "domains", "inboxes", "setup"];

function initialStep(s: OnboardingState): number {
  if (s.subscription && PAID.includes(s.subscription.status)) return 7;
  if (s.domains.some((d) => d.status === "SELECTED")) return 6;
  if (s.onboarding?.preview?.length) return 3;
  return 1;
}

function draftFrom(s: OnboardingState, userName: string | null): Draft {
  const o = s.onboarding!;
  const chosen = s.domains.filter((d) => d.status !== "FAILED");
  const per: Record<string, number> = {};
  const prices: Record<string, number> = {};
  for (const d of chosen) {
    per[d.name] = s.mailboxes.filter((m) => m.sendingDomainId === d.id).length || o.inboxesPerDomain;
    prices[d.name] = d.priceCents;
  }
  const parts = (userName ?? "").trim().split(/\s+/).filter(Boolean);
  return {
    volume: o.volume,
    volSet: chosen.length > 0,
    warmup: o.warmupDays,
    defPer: o.inboxesPerDomain,
    provider: o.provider,
    fast: o.fastStart,
    senders: o.senders.length ? o.senders : [{ first: parts[0] ?? "", last: parts.slice(1).join(" ") }],
    picks: chosen.map((d) => d.name),
    per,
    prices,
    manual: chosen.length > 0,
    pickedFor: chosen.length ? o.volume : 0,
  };
}

function ValueBar({ cta, onExit, exitLabel, compact }: { cta: React.ReactNode; onExit: () => void; exitLabel: string; compact: boolean }) {
  return (
    <header className="vb">
      <div className="vb-in">
        <Link className="logo" href="/" aria-label="Aperture home">
          <Mark />
          <span>Aperture</span>
        </Link>
        {!compact ? (
          <div className="vb-val">
            <b>Your first outbound campaign, set up while you watch</b>
            <ul className="vb-proofs">
              <li>
                <Icon id="check" />
                Nothing sends until you launch
              </li>
              <li>
                <Icon id="check" />
                Your main domain never sends cold email
              </li>
              <li>
                <Icon id="check" />
                Every fact shows where it came from
              </li>
            </ul>
          </div>
        ) : (
          <span className="spacer" />
        )}
        <button type="button" className="obh-exit" onClick={onExit}>
          <span>{exitLabel}</span>
        </button>
        {cta ? <div className="vb-cta">{cta}</div> : null}
      </div>
    </header>
  );
}

function StepPills({ cur, max, onGo, locked, hasDomain, onBack, canBack }: { cur: number; max: number; onGo: (i: number) => void; locked: boolean; hasDomain: boolean; onBack: () => void; canBack: boolean }) {
  const barRef = useRef<HTMLOListElement>(null);
  const at = cur + 1;
  useEffect(() => {
    const bar = barRef.current;
    const c = bar?.querySelector<HTMLElement>(".pill.cur");
    if (bar && c) bar.scrollLeft = c.offsetLeft - bar.clientWidth / 2 + c.offsetWidth / 2;
  }, [cur]);
  return (
    <nav className="pills" aria-label="Setup steps">
      {canBack ? (
        <button type="button" className="pills-back" onClick={onBack} disabled={locked}>
          <Icon id="back" />
          <span>Back</span>
        </button>
      ) : null}
      <ol ref={barRef}>
        {STEPS.map(([label], i) => {
          const done = i === 0 ? hasDomain : i < at;
          const st = i === at ? "cur" : done ? "done" : "todo";
          const step = i - 1;
          const can = !locked && step >= 1 && step <= max && step !== cur && cur !== 7 && step < 7;
          return (
            <li key={label} className={`pill ${st}`}>
              {i ? <span className="pill-line" aria-hidden="true" /> : null}
              <button type="button" disabled={!can} aria-current={st === "cur" ? "step" : undefined} onClick={() => onGo(step)} title={label}>
                <span className="pill-n">{done && st !== "cur" ? <Icon id="check" /> : i + 1}</span>
                {st === "cur" ? <span className="pill-l">{label}</span> : <span className="sr">{label}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function DomainPrompt({ onStart, busy, error, initial = "" }: { onStart: (d: string) => void; busy: boolean; error: string; initial?: string }) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState("");
  return (
    <div className="au-page">
      <div className="au-shell">
        <section className="au-col">
          <h1 className="au-h">Which domain do you sell from?</h1>
          <p className="au-p">We read it to learn what you sell and who buys it. It never sends a cold email itself.</p>
          <form
            className="au-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const d = normDomain(v);
              if (!validDomain(d)) return setErr("That doesn't look like a domain. Try something like northwind.io");
              setErr("");
              onStart(d);
            }}
          >
            <div className="au-field">
              <label htmlFor="obDomain">Company domain</label>
              <div className="au-ctl">
                <span className="au-lead">
                  <Icon id="globe" />
                </span>
                <input id="obDomain" className={`au-input${err || error ? " bad" : ""}`} placeholder="yourcompany.com" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
              </div>
            </div>
            <p className="au-err" role="alert">
              {err || error}
            </p>
            <button className="au-btn" type="submit" disabled={busy}>
              {busy ? <span className="au-spin" /> : null}
              Analyze my domain
              {!busy ? <Icon id="arr" /> : null}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

export function Onboarding() {
  return (
    <DockProvider>
      <OnboardingFlow />
    </DockProvider>
  );
}

function OnboardingFlow() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const dock = useDock();
  const status = useSessionBootstrap();
  const authed = status === "authed";
  const { user, activeOrgId } = useAppSelector((s) => s.auth);
  const hasOrg = useAppSelector((s) => s.auth.organizations.length > 0);
  const workspace = useCreateWorkspace();
  const paramDomain = (() => {
    const d = normDomain(params.get("domain") ?? "");
    return validDomain(d) ? d : "";
  })();
  const [mode, setMode] = useState<"up" | "in">(params.get("mode") === "in" ? "in" : "up");

  const { data: state, isLoading, isError, error, refetch } = useOnboardingQuery(undefined, { skip: !authed || !hasOrg });
  const { data: cat } = usePlansQuery();
  const [start, startState] = useOnboardingStartMutation();
  const [update] = useOnboardingUpdateMutation();
  const [saveDomains] = useSaveDomainsMutation();

  const [step, setStep] = useState<number | null>(null);
  const [max, setMax] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [nextDisabled, setNextDisabled] = useState(false);
  const [awaiting, setAwaiting] = useState(params.get("paid") === "1");
  const [startErr, setStartErr] = useState("");
  const payRef = useRef<PayHandle | null>(null);
  const [payReady, setPayReady] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const startedFor = useRef("");
  const [presenting, setPresenting] = useState(false);
  const [staleRun, setStaleRun] = useState<string | null>(null);
  const [view, setView] = useState<AnalysisView>("review");
  const [audience, setAudience] = useState<string | null>(null);
  const [resumePhase, setResumePhase] = useState<PhaseKey | null>(null);

  const o = state?.onboarding ?? null;
  const groupsKey = o ? o.groups.filter((g) => g.on).map((g) => `${g.id}:${g.keywords.join("|")}`).join(",") : "";
  const wantMarket = !!o?.analyzedAt && !!groupsKey && !presenting;
  const { data: market, isFetching: marketLoading } = useOnboardingMarketQuery(groupsKey, { skip: !wantMarket });
  const { data: sub } = useSubscriptionQuery(undefined, { skip: !authed || !awaiting, pollingInterval: awaiting ? 2500 : 0 });

  const liveRun = state?.analysisRun ?? null;
  const runPath = presenting && liveRun && liveRun.id !== staleRun ? `/analyses/${liveRun.id}/stream` : null;
  const { run, connection } = useRunStream(runPath);
  const paid = !!state?.subscription && PAID.includes(state.subscription.status);
  const cur = authed && hasOrg && o ? step ?? 1 : 0;
  const provPath = cur === 7 && paid && activeOrgId ? `/orgs/${activeOrgId}/provisioning/stream` : null;
  const { run: prov, connection: provConnection } = useRunStream(provPath);

  const go = useCallback((n: number) => {
    setStep(n);
    setMax((m) => Math.max(m, n));
    window.scrollTo(0, 0);
    setTimeout(() => viewRef.current?.focus({ preventScroll: true }), 0);
  }, []);

  /** Keeps the running phase in the URL (?phase=audiences) without a navigation. */
  const setPhaseParam = useCallback((p: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (p) url.searchParams.set("phase", p);
    else url.searchParams.delete("phase");
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const onPresent = useCallback(
    (fresh: boolean) => {
      const fromUrl = params.get("phase");
      setResumePhase(!fresh && fromUrl && (PHASES as readonly string[]).includes(fromUrl) ? (fromUrl as PhaseKey) : null);
      setStaleRun(fresh ? (state?.analysisRun?.id ?? null) : null);
      dock.reset(LIVE_KEYS);
      setView("review");
      setPresenting(true);
    },
    [state?.analysisRun?.id, dock, params],
  );
  const onPresented = useCallback(() => {
    setPresenting(false);
    setPhaseParam(null);
    dock.settle(["business", "buyers", "market"]);
  }, [dock, setPhaseParam]);

  useEffect(() => {
    if (!authed || !state || !paramDomain || startedFor.current === paramDomain) return;
    if (o && o.domain === paramDomain) return;
    startedFor.current = paramDomain;
    if (o?.paidAt) {
      toast(`Setup for ${o.domain} is already paid for, so it wasn't switched to ${paramDomain}.`, "bad");
      return;
    }
    start({ domain: paramDomain })
      .unwrap()
      .then((fresh) => {
        // Work out the step from the new domain's setup, not the one still on screen.
        const s = initialStep(fresh);
        dock.reset(ALL_KEYS);
        setPresenting(false);
        setDraft(fresh.onboarding ? draftFrom(fresh, user?.name ?? null) : null);
        setStep(s);
        setMax(s);
      })
      .catch((e) => {
        setStartErr(errorMessage(e));
        toast(`Couldn't switch to ${paramDomain}: ${errorMessage(e)}`, "bad");
      });
  }, [authed, state, o, paramDomain, start, toast, dock, user?.name]);

  useEffect(() => {
    if (!state?.onboarding) return;
    setDraft((d) => d ?? draftFrom(state, user?.name ?? null));
    if (step === null) {
      const s = awaiting ? 6 : initialStep(state);
      setStep(s);
      setMax(s);
    }
  }, [state, step, user?.name, awaiting]);

  useEffect(() => {
    if (!draft || draft.volSet || !market) return;
    const rec = recommendedVolume(market.verified ?? market.people);
    if (rec && rec !== draft.volume) setDraft((d) => (d ? { ...d, volume: rec } : d));
  }, [market, draft]);

  useEffect(() => {
    if (!awaiting || !sub || !PAID.includes(sub.status)) return;
    setAwaiting(false);
    refetch();
    go(7);
  }, [awaiting, sub, refetch, go]);

  useEffect(() => {
    if (!awaiting) return;
    const tm = setTimeout(() => setAwaiting(false), 120_000);
    return () => clearTimeout(tm);
  }, [awaiting]);

  const t = useMemo(() => (cat && draft ? totals(cat, draft.volume, draft.picks, draft.per, draft.defPer, draft.prices, draft.fast) : null), [cat, draft]);
  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d)), []);
  const registerPay = useCallback((h: PayHandle | null) => {
    payRef.current = h;
    setPayReady(!!h);
  }, []);
  const onPaid = useCallback(() => setAwaiting(true), []);

  if (status === "idle" || status === "loading") return <FullPageLoader />;

  const domain = o?.domain ?? paramDomain;
  const live = presenting && run.started;
  const DOCK_ON_NEXT: Record<number, string> = { 3: "volume", 4: "domains", 5: "inboxes" };

  async function next() {
    if (!draft || !cat || step === null) return;
    setBusy(true);
    try {
      if (step === 1 || step === 2) {
        if (step === 2) await update({ volume: draft.volume }).unwrap();
        if (step === 1 && view === "review") await dock.dock("sequence");
        go(step + 1);
      } else if (step === 3) {
        await update({ volume: draft.volume }).unwrap();
        await dock.dock("volume");
        go(4);
      } else if (step === 4 || step === 5) {
        if (step === 5) {
          const senders = draft.senders.filter((x) => x.first.trim());
          if (!senders.length) throw new Error("Add at least one sender name");
          await update({ warmupDays: draft.warmup, inboxesPerDomain: draft.defPer, provider: draft.provider, fastStart: draft.fast, senders }).unwrap();
        }
        await saveDomains({ domains: draft.picks.map((name) => ({ name, inboxes: draft.per[name] ?? draft.defPer })) }).unwrap();
        await dock.dock(DOCK_ON_NEXT[step]);
        go(step + 1);
      } else if (step === 6 && payRef.current) await payRef.current();
    } catch (e) {
      toast(errorMessage(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (!authed)
    body = (
      <>
        <AuthCard mode={mode} onMode={setMode} domain={domain || undefined} next={`/onboarding${domain ? `?domain=${domain}` : ""}`} changeHref="/" onDone={() => undefined} />
        {domain ? (
          <p className="lv-signline">
            <ProgressRing value={0.08} />
            Ready to read <b>{domain}</b> the moment you&apos;re in
          </p>
        ) : null}
      </>
    );
  else if (!hasOrg) body = <DomainPrompt busy={workspace.isLoading} error={startErr} initial={paramDomain} onStart={(d) => workspace.run(d).catch((e) => setStartErr(errorMessage(e)))} />;
  else if (isError) body = <ErrorState error={error} onRetry={refetch} />;
  else if (isLoading || !state || !cat) body = <OnboardingSkeleton />;
  else if (!o) body = <DomainPrompt busy={startState.isLoading} error={startErr} initial={paramDomain} onStart={(d) => start({ domain: d }).unwrap().catch((e) => setStartErr(errorMessage(e)))} />;
  else if (!draft || !t || step === null) body = <OnboardingSkeleton />;
  else {
    const common = { draft, cat, t, patch, domain };
    const firstDomain = draft.picks[0] ?? `get${domain.split(".")[0]}.com`;
    if (cur === 1)
      body =
        state.analysisStream === false ? (
          <AnalysisStep state={state} market={market} setNextDisabled={setNextDisabled} />
        ) : (
          <AnalysisFlow
            state={state}
            run={run}
            presenting={presenting}
            onPresent={onPresent}
            onPresented={onPresented}
            setNextDisabled={setNextDisabled}
            market={market}
            audience={audience}
            view={view}
            onView={setView}
            resumePhase={resumePhase}
            onPhase={setPhaseParam}
            sender={draft.senders[0]?.first ?? ""}
          />
        );
    else if (cur === 2) {
      body = (
        <PreviewStep
          state={state}
          cat={cat}
          market={market}
          marketLoading={marketLoading}
          volume={draft.volume}
          onVolume={(v) => patch({ volume: v, volSet: true })}
          onBack={() => go(1)}
          setNextDisabled={setNextDisabled}
          audience={audience}
          onAudience={setAudience}
        />
      );
    } else if (cur === 3) body = <VolumeStep {...common} market={market} summary={null} />;
    else if (cur === 4) body = <DomainsStep {...common} summary={null} />;
    else if (cur === 5) body = <InboxesStep {...common} summary={null} />;
    else if (cur === 6)
      body = <PaymentStep {...common} orgId={activeOrgId ?? ""} awaiting={awaiting} register={registerPay} onPaid={onPaid} onBusy={setBusy} email={user?.email ?? ""} summary={null} />;
    else body = <LaunchStep state={state} cat={cat} t={t} draft={draft} market={market} prov={prov} onOpenApp={() => router.push("/app")} />;
  }

  const isAuth = cur === 0;
  const ready = authed && !!o && !!draft && !!t;
  const labels = ["", "See my free overview", draft ? `Continue with ${draft.volume.toLocaleString("en-US")} a day` : "Continue", "Choose domains", "Set up inboxes", "Review and pay", t?.dueCents != null ? `Pay ${money(t.dueCents)}` : "Pay and start setup", ""];
  const disabled = busy || nextDisabled || (cur === 4 && !draft?.picks.length) || (cur === 5 && !t?.inboxes) || (cur === 6 && (!payReady || awaiting));
  const cta =
    ready && cur >= 1 && cur <= 6 ? (
      <button className="btn btn-primary" type="button" disabled={disabled} onClick={next}>
        {busy || awaiting ? (
          <>
            <span className="spinner" />
            {awaiting ? "Confirming payment" : "Processing"}
          </>
        ) : (
          <>
            {labels[cur]}
            <Icon id="arr" className="arr" />
          </>
        )}
      </button>
    ) : ready && cur === 7 ? (
      <button className="btn btn-primary" type="button" onClick={() => router.push("/app")}>
        Go to your dashboard
        <Icon id="arr" className="arr" />
      </button>
    ) : null;

  const cards =
    ready && state && o
      ? railCards({ state, run, live, market, draft, t, max, docked: dock.phase, setupDone: !!prov.done })
      : [];
  // Cards only wait off the rail while they fly in from the analysis. After that every decision stays put.
  const hidden = new Set<string>(presenting ? LIVE_KEYS.filter((k) => dock.phase[k] !== "landed") : []);
  const active = new Set<string>(
    presenting ? [] : cur === 1 ? [view === "review" ? "sequence" : view] : cur === 2 ? ["buyers", "market"] : cards.filter((c) => c.step === cur).map((c) => c.key),
  );
  const provRunning = cur === 7 && prov.started && !prov.done;
  const log: RailLog | null =
    presenting && run.started && !run.done && !run.error
      ? {
          lines: run.logs,
          stepIndex: run.steps.findIndex((k) => run.stepState[k] === "running") + 1 || run.steps.filter((k) => run.stepState[k] === "done").length,
          stepCount: run.steps.length || 6,
          connection,
        }
      : provRunning
        ? { lines: prov.logs, stepIndex: prov.steps.filter((k) => prov.stepState[k] === "done").length + 1, stepCount: prov.steps.length, connection: provConnection, label: "Setting up your sending" }
        : null;
  const total = ready && draft && cat && t && cur >= 3 ? runningTotal(cur, draft, cat, t) : null;
  // The value bar appears once there is something worth buying: when the market numbers land.
  const valueReady = ready && cur >= 1 && cur <= 6 && (presenting ? run.stepState.size === "done" : !!o?.analyzedAt && !!market);
  const showRail = ready && !isAuth;

  return (
    <div id="onboard" className={`lv-app${isAuth ? " is-auth" : ""}`} style={{ minHeight: "100vh" }}>
      <ValueBar cta={valueReady ? cta : null} compact={!valueReady} exitLabel={isAuth ? "Back to site" : "Save and exit"} onExit={() => router.push(isAuth ? "/" : authed ? "/app" : "/")} />
      <div className={`lv-shell${showRail ? "" : " no-rail"}`}>
        {showRail ? (
          <Rail
            cards={cards}
            hidden={hidden}
            active={active}
            onOpen={(n, key) => {
              if (presenting) return;
              // Each finished card opens its own section. Before the overview has been reached,
              // buyers and market open inside the analysis step; after it, they open the overview.
              const inAnalysis = key === "business" || key === "sequence" || ((key === "buyers" || key === "market") && (cur === 1 || max < 2));
              if (inAnalysis) {
                setView(key === "business" ? "business" : key === "buyers" ? "buyers" : key === "market" ? "market" : "review");
                if (cur !== 1) go(1);
                return;
              }
              if (n <= max && n !== cur) go(n);
            }}
            log={log}
            total={total}
            domain={domain}
            selected={audience}
            onSelect={(id) => {
              setAudience(id);
              if (id && cur > 2 && !presenting) go(2);
            }}
          />
        ) : null}
        <main className="lv-centre">
          {!isAuth && ready ? (
            <StepPills cur={cur} max={max} onGo={go} locked={awaiting} hasDomain={!!domain} canBack={cur > 1 && cur < 7} onBack={() => go(cur - 1)} />
          ) : null}
          <div className="ob-view" ref={viewRef} tabIndex={-1} key={`${cur}-${domain}`}>
            <div ref={DOCK_ON_NEXT[cur] ? dock.source(DOCK_ON_NEXT[cur]) : undefined}>{body}</div>
          </div>
          {!valueReady && cta && !isAuth && !presenting && !(cur === 1 && !o?.analyzedAt) ? <div className="lv-next">{cta}</div> : null}
        </main>
      </div>
      {ready && !isAuth && (cta || total) ? (
        <div className="lv-mbar">
          {total ? (
            <div className="due">
              <small>{total.estimated ? "Due today, est." : "Due today"}</small>
              <b>{total.dueCents != null ? money(total.dueCents) : `${money(total.planCents)} + fees`}</b>
            </div>
          ) : (
            <span className="spacer" />
          )}
          {cta}
        </div>
      ) : null}
    </div>
  );
}

function OnboardingSkeleton() {
  return (
    <div style={{ display: "grid", gap: 16 }} aria-busy="true">
      <div className="an-sk w1" />
      <div className="an-sk w2" />
      <div className="an-sk w3" style={{ height: 220, borderRadius: 16 }} />
    </div>
  );
}
