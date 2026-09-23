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
import { AnalysisAside, AnalysisStep } from "./AnalysisStep";
import { PreviewStep } from "./PreviewStep";
import { DomainsStep, InboxesStep, PaymentStep, SetupAside, VolumeStep, type Draft } from "./SetupSteps";
import { LaunchStep } from "./LaunchStep";
import { recommendedVolume, totals } from "./sizing";
import type { PayHandle } from "./Payment";

const STEPS: [string, IconId][] = [
  ["Account", "st-user"],
  ["Analysis", "st-scan"],
  ["Preview", "st-mail"],
  ["Volume", "st-gauge"],
  ["Domains", "globe"],
  ["Inboxes", "inbox"],
  ["Payment", "st-card"],
  ["Launch", "st-send"],
];
const PAID = ["ACTIVE", "TRIALING", "PAST_DUE"];

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

function Header({ cur, max, onGo, exitLabel, onExit, locked }: { cur: number; max: number; onGo: (i: number) => void; exitLabel: string; onExit: () => void; locked: boolean }) {
  const barRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    const c = bar?.querySelector<HTMLElement>(".sp.cur");
    if (bar && c) bar.scrollLeft = c.offsetLeft - bar.clientWidth / 2 + c.offsetWidth / 2;
  }, [cur]);
  return (
    <header className="obh">
      <div className="obh-in nav-in glass">
        <Link className="logo" href="/" aria-label="Aperture home">
          <Mark />
          <span>Aperture</span>
        </Link>
        <nav className="sp-bar" aria-label="Setup steps" ref={barRef}>
          {STEPS.map(([l, icon], i) => {
            const st = i < cur ? "done" : i === cur ? "cur" : "todo";
            const can = !locked && i > 0 && i <= max && i !== cur && cur !== 7 && i < 7;
            return (
              <span key={l} style={{ display: "contents" }}>
                {i ? <span className={`sp-line${i <= cur ? " on" : ""}`} aria-hidden="true" /> : null}
                <button type="button" className={`sp ${st}`} disabled={!can} aria-current={i === cur ? "step" : undefined} title={l} onClick={() => onGo(i)}>
                  <span className="sp-ic">{st === "done" ? <Icon id="check" /> : <Icon id={icon} />}</span>
                  <span className="sp-l">{l}</span>
                </button>
              </span>
            );
          })}
        </nav>
        <button type="button" className="obh-exit" onClick={onExit}>
          {cur === 0 ? <Icon id="back" /> : null}
          <span>{exitLabel}</span>
        </button>
      </div>
    </header>
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
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
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

  const o = state?.onboarding ?? null;
  const groupsKey = o ? o.groups.filter((g) => g.on).map((g) => g.id).join(",") : "";
  const wantMarket = !!o?.analyzedAt && !!groupsKey;
  const { data: market, isFetching: marketLoading } = useOnboardingMarketQuery(groupsKey, { skip: !wantMarket });
  const { data: sub } = useSubscriptionQuery(undefined, { skip: !authed || !awaiting, pollingInterval: awaiting ? 2500 : 0 });

  const go = useCallback((n: number) => {
    setStep(n);
    setMax((m) => Math.max(m, n));
    window.scrollTo(0, 0);
    setTimeout(() => viewRef.current?.focus({ preventScroll: true }), 0);
  }, []);

  useEffect(() => {
    if (!authed || !state || o || !paramDomain || startedFor.current === paramDomain) return;
    startedFor.current = paramDomain;
    start({ domain: paramDomain })
      .unwrap()
      .catch((e) => setStartErr(errorMessage(e)));
  }, [authed, state, o, paramDomain, start]);

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
    const t = setTimeout(() => setAwaiting(false), 120_000);
    return () => clearTimeout(t);
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
  const cur = authed && hasOrg && o ? step ?? 1 : 0;
  const wide = cur === 2 || cur === 7;

  async function next() {
    if (!draft || !cat || step === null) return;
    setBusy(true);
    try {
      if (step === 1 || step === 2) {
        if (step === 2) await update({ volume: draft.volume }).unwrap();
        go(step + 1);
      } else if (step === 3) {
        await update({ volume: draft.volume }).unwrap();
        go(4);
      } else if (step === 4 || step === 5) {
        if (step === 5) {
          const senders = draft.senders.filter((s) => s.first.trim());
          if (!senders.length) throw new Error("Add at least one sender name");
          await update({ warmupDays: draft.warmup, inboxesPerDomain: draft.defPer, provider: draft.provider, fastStart: draft.fast, senders }).unwrap();
        }
        await saveDomains({ domains: draft.picks.map((name) => ({ name, inboxes: draft.per[name] ?? draft.defPer })) }).unwrap();
        go(step + 1);
      } else if (step === 6 && payRef.current) await payRef.current();
    } catch (e) {
      toast(errorMessage(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  let aside: React.ReactNode = null;
  if (!authed)
    body = (
      <AuthCard
        mode={mode}
        onMode={setMode}
        domain={domain || undefined}
        next={`/onboarding${domain ? `?domain=${domain}` : ""}`}
        changeHref="/"
        onDone={() => undefined}
      />
    );
  else if (!hasOrg) body = <DomainPrompt busy={workspace.isLoading} error={startErr} initial={paramDomain} onStart={(d) => workspace.run(d).catch((e) => setStartErr(errorMessage(e)))} />;
  else if (isError) body = <ErrorState error={error} onRetry={refetch} />;
  else if (isLoading || !state || !cat) body = <OnboardingSkeleton />;
  else if (!o) body = <DomainPrompt busy={startState.isLoading} error={startErr} initial={paramDomain} onStart={(d) => start({ domain: d }).unwrap().catch((e) => setStartErr(errorMessage(e)))} />;
  else if (!draft || !t || step === null) body = <OnboardingSkeleton />;
  else {
    const common = { draft, cat, t, patch, domain };
    const summary = <SetupAside step={cur} draft={draft} cat={cat} t={t} domain={domain} />;
    if (cur === 1) {
      body = <AnalysisStep state={state} market={market} setNextDisabled={setNextDisabled} />;
      aside = <AnalysisAside state={state} market={market} />;
    } else if (cur === 2)
      body = (
        <PreviewStep
          state={state}
          cat={cat}
          market={market}
          marketLoading={marketLoading}
          volume={draft.volume}
          onVolume={(v) => patch({ volume: v, volSet: true })}
          senders={draft.senders}
          firstDomain={draft.picks[0] ?? `get${domain.split(".")[0]}.com`}
          onBack={() => go(1)}
          setNextDisabled={setNextDisabled}
        />
      );
    else if (cur === 3) body = <VolumeStep {...common} market={market} summary={summary} />;
    else if (cur === 4) body = <DomainsStep {...common} summary={summary} />;
    else if (cur === 5) body = <InboxesStep {...common} summary={summary} />;
    else if (cur === 6)
      body = <PaymentStep {...common} orgId={activeOrgId ?? ""} awaiting={awaiting} register={registerPay} onPaid={onPaid} onBusy={setBusy} email={user?.email ?? ""} summary={summary} />;
    else body = <LaunchStep state={state} cat={cat} t={t} draft={draft} market={market} onOpenApp={() => router.push("/app")} />;
    if (cur >= 3 && cur <= 6) aside = summary;
  }

  const showFoot = authed && !!o && !!draft && !!t && cur >= 1 && cur <= 6;
  const labels = ["", "See my free preview", draft ? `Continue with ${draft.volume.toLocaleString("en-US")} a day` : "Continue", "Choose domains", "Set up inboxes", "Review and pay", t?.dueCents != null ? `Pay ${money(t.dueCents)}` : "Pay and start setup", ""];
  const disabled = busy || nextDisabled || (cur === 4 && !draft?.picks.length) || (cur === 5 && !t?.inboxes) || (cur === 6 && (!payReady || awaiting));
  const isAuth = cur === 0;

  return (
    <div id="onboard" className={`${isAuth ? "is-auth" : ""}${wide ? " is-wide" : ""}`} style={{ minHeight: "100vh" }}>
      <Header
        cur={cur}
        max={max}
        locked={awaiting}
        onGo={go}
        exitLabel={isAuth ? "Back to site" : "Save and exit"}
        onExit={() => router.push(isAuth ? "/" : authed ? "/app" : "/")}
      />
      <div className="ob">
        <div className="ob-main">
          <div className="ob-view" ref={viewRef} tabIndex={-1} key={cur}>
            {body}
          </div>
          {showFoot ? (
            <div className="ob-foot glass" id="foot">
              <button className="btn btn-text" type="button" onClick={() => (cur > 1 ? go(cur - 1) : router.push("/"))} disabled={awaiting}>
                <Icon id="back" className="arr" />
                Back
              </button>
              {cur >= 4 && t ? (
                <div className="due">
                  <small>Due today</small>
                  <b>{t.dueCents != null ? money(t.dueCents) : `${money(t.plan.priceMonthlyCents)} + fees`}</b>
                </div>
              ) : cur === 3 && t ? (
                <div className="due">
                  <small>{t.plan.name} plan</small>
                  <b>{money(t.plan.priceMonthlyCents)}/mo</b>
                </div>
              ) : (
                <span className="spacer" />
              )}
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
            </div>
          ) : null}
        </div>
        {aside && !wide ? (
          <aside className="aside" aria-label="Your setup">
            {aside}
          </aside>
        ) : null}
      </div>
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
