"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorCode, errorMessage, useOnboardingAnalyzeMutation, useOnboardingPreviewMutation, useOnboardingUpdateMutation } from "@/store/api";
import { useAppDispatch } from "@/store";
import type { MarketView, OnboardingState } from "@/lib/types";
import { BrandSheet, FactsSheet, Fallback } from "../AnalysisStep";
import { MarketTabs } from "../PreviewStep";
import { Icon } from "@/components/ui/Icon";
import { compact, n0 } from "@/lib/format";
import { audienceIcon } from "./cards";
import { EmailsPanel, LiveAnalysis, type Lead, type PhaseKey } from "./LiveAnalysis";
import { useDock } from "./motion";
import type { RunState } from "./run";

export type AnalysisView = "review" | "business" | "buyers" | "market";

const MAX_RESTARTS = 3;

function leadsFromMarket(market: MarketView | undefined, audience: string | null): Lead[] {
  return (market?.prospects ?? [])
    .filter((p) => !audience || !p.audienceId || p.audienceId === audience)
    .map((p, i) => ({ key: `${p.audienceId ?? "m"}-${i}-${p.firstName}`, audienceId: p.audienceId, firstName: p.firstName, lastMasked: `${p.lastInitial}***`, title: p.title, company: p.company, hasEmail: p.hasEmail }));
}

/**
 * Step 3 with the live stream. Starts the run once, follows it (a reload replays it), and when
 * the presentation has docked everything shows the facts to check.
 */
export function AnalysisFlow({
  state,
  run,
  presenting,
  onPresent,
  onPresented,
  setNextDisabled,
  market,
  audience,
  view,
  onView,
  resumePhase,
  onPhase,
  sender,
}: {
  state: OnboardingState;
  run: RunState;
  presenting: boolean;
  /** fresh: a new run is being started, so the previous run's id must not be followed. */
  onPresent: (fresh: boolean) => void;
  onPresented: () => void;
  setNextDisabled: (b: boolean) => void;
  market: MarketView | undefined;
  audience: string | null;
  view: AnalysisView;
  onView: (v: AnalysisView) => void;
  resumePhase: PhaseKey | null;
  onPhase: (p: PhaseKey) => void;
  sender: string;
}) {
  const o = state.onboarding!;
  const dock = useDock();
  const [writeEmails, writing] = useOnboardingPreviewMutation();
  const wrote = useRef(false);
  const dispatch = useAppDispatch();
  const [start, { isLoading: starting, error: startError }] = useOnboardingAnalyzeMutation();
  const [update, updateState] = useOnboardingUpdateMutation();
  const tried = useRef(false);
  /** Automatic restarts after a server restart cut a run off. Capped so a server that keeps crashing shows the error. */
  const restarts = useRef(0);
  const [ask, setAsk] = useState(false);
  const runState = state.analysisRun ?? null;

  const begin = useCallback(() => {
    onPresent(true);
    start().catch(() => undefined);
  }, [start, onPresent]);

  useEffect(() => {
    if (tried.current || !state.aiAvailable) return;
    if (runState?.status === "RUNNING") {
      tried.current = true;
      onPresent(false);
      return;
    }
    // A finished run with nothing saved means the domain was entered again after a switch, and an interrupted run
    // means the server restarted mid-run. Neither is the user's problem: analyse it fresh.
    const interrupted = runState?.status === "FAILED" && runState.error === "interrupted";
    if (o.analyzedAt || (runState?.status === "FAILED" && !interrupted) || o.siteReadable === false || o.analysisError === "low-confidence") return;
    tried.current = true;
    if (interrupted) restarts.current++;
    begin();
  }, [state.aiAvailable, runState, o.analyzedAt, o.siteReadable, o.analysisError, begin, onPresent]);

  // A run that was joined but had been cut off by a server restart starts again once, on its own.
  useEffect(() => {
    if (run.error?.code !== "interrupted" || restarts.current >= MAX_RESTARTS) return;
    restarts.current++;
    begin();
  }, [run.error, begin]);

  useEffect(() => {
    if (run.done || run.error) {
      dispatch(api.util.invalidateTags(["Onboarding"]));
    }
  }, [run.done, run.error, dispatch]);

  useEffect(() => {
    setNextDisabled(presenting || starting || !o.analyzedAt);
    return () => setNextDisabled(false);
  }, [presenting, starting, o.analyzedAt, setNextDisabled]);

  const needEmails = !presenting && !!o.analyzedAt && !o.preview?.length && state.aiAvailable && !!o.summary && o.groups.some((g) => g.on);
  useEffect(() => {
    if (!needEmails || wrote.current) return;
    wrote.current = true;
    writeEmails().catch(() => undefined);
  }, [needEmails, writeEmails]);

  if (presenting)
    return <LiveAnalysis domain={o.domain} run={run} onFinished={onPresented} initialPhase={resumePhase} onPhase={onPhase} audience={audience} brand={o.brand} sender={sender} />;

  if (!o.analyzedAt) {
    const aiDown = (startError && errorCode(startError) === "NOT_CONFIGURED") || !state.aiAvailable;
    const thin = o.analysisError === "low-confidence";
    const unreadable = o.siteReadable === false || run.error?.code === "site-unreadable";
    const detail = startError ? errorMessage(startError).replace(/^AI analysis: /, "") : run.error?.message ?? (o.analysisError && !thin ? o.analysisError : undefined);
    if (thin || unreadable || aiDown || startError || runState?.status === "FAILED" || run.error)
      return (
        <Fallback
          domain={o.domain}
          reason={unreadable ? "unreadable" : aiDown ? "no-ai" : thin ? "thin" : "failed"}
          detail={detail}
          canRetry={!aiDown}
          onRetry={begin}
          prefill={{ sell: o.analysis?.brandDetail?.one_liner, regions: o.analysis?.brandDetail?.geographies }}
        />
      );
    return (
      <div className="lv-an">
        <p className="lv-wait">
          <span className="lv-caret" aria-hidden="true" />
          Starting the analysis of {o.domain}
        </p>
      </div>
    );
  }

  const fromAnswers = o.facts.some((f) => f.source === "from your answers");
  const count = (id: string) => market?.groups.find((g) => g.id === id)?.count ?? null;
  const bestGuess = !fromAnswers && o.analysis?.source === "site" && o.analysis.lowConfidence;
  const guessNote = bestGuess ? (
    <p className="lv-guess" role="note">
      <Icon id="alert" />
      <span>
        Your site says little about who buys from you, so these audiences are our best guess.{" "}
        <button type="button" className="au-link" onClick={() => setAsk(true)}>
          Answer three questions to sharpen them
        </button>
      </span>
    </p>
  ) : null;

  if (ask && bestGuess)
    return (
      <>
        <p className="ph-back">
          <button type="button" className="au-link" onClick={() => setAsk(false)}>
            Keep the best guess
          </button>
        </p>
        <Fallback domain={o.domain} reason="thin" canRetry={!!state.aiAvailable} onRetry={begin} prefill={{ sell: o.analysis?.brandDetail?.one_liner, regions: o.analysis?.brandDetail?.geographies }} />
      </>
    );

  if (view === "buyers") {
    const groups = [...o.groups].filter((g) => g.on && (!audience || g.id === audience)).sort((a, b) => a.priority - b.priority);
    return (
      <div className="ph-stage">
        <div className="ph-panel">
          <header className="ph-head">
            <h1 className="ph-h">Who buys from you</h1>
            <p className="ph-sub">Each audience needs its own email. You can change keywords and switch audiences off on the next screen.</p>
          </header>
          {guessNote}
          <div className="aud-list">
            {groups.map((g) => (
              <article key={g.id} className="aud-card">
                <span className="aud-ic">
                  <Icon id={audienceIcon(g.name, g.keywords)} />
                </span>
                <div className="aud-body">
                  <h3>
                    {g.name}
                    {count(g.id) != null ? <span className="aud-n">{compact(count(g.id)!)} match</span> : null}
                  </h3>
                  {g.why || g.description ? <p className="aud-why">{g.why || g.description}</p> : null}
                  {g.pains.length ? (
                    <ul className="aud-pains">
                      {g.pains.slice(0, 4).map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  ) : null}
                  {g.keywords.length ? (
                    <div className="aud-kws">
                      {g.keywords.map((k) => (
                        <span key={k}>{k}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (view === "market")
    return (
      <div className="ph-stage">
        <div className="ph-panel">
          <header className="ph-head">
            <h1 className="ph-h">Your market</h1>
            <p className="ph-sub">People who match your audiences in the lead database.</p>
          </header>
          {market?.available ? (
            <div className="ph-card">
              <div className="mk-big">
                <div>
                  <span>People who match</span>
                  <b>{market.people != null ? n0(market.people) : "n/a"}</b>
                </div>
                <div>
                  <span>With a verified work email</span>
                  <b>{market.verified != null ? n0(market.verified) : "n/a"}</b>
                </div>
              </div>
              <ul className="mk-rows">
                {o.groups
                  .filter((g) => g.on && (!audience || g.id === audience))
                  .map((g) => {
                    const c = market.groups.find((x) => x.id === g.id);
                    const share = c?.count && c.verified != null ? Math.min(1, c.verified / c.count) : 0;
                    return (
                      <li key={g.id}>
                        <span className="mk-n">{g.name}</span>
                        <span className="mk-v">{c?.count != null ? n0(c.count) : "n/a"}</span>
                        <span className="mk-v muted">{c?.verified != null ? n0(c.verified) : "n/a"}</span>
                        <span className="mk-bar" aria-hidden="true">
                          <i style={{ width: `${share * 100}%` }} />
                        </span>
                      </li>
                    );
                  })}
              </ul>
              <div className="mk-legend" aria-hidden="true">
                <span>match</span>
                <span>reachable</span>
              </div>
              <MarketTabs market={market} people={market.people} audience={audience} />
            </div>
          ) : (
            <div className="ph-card">
              <p className="lv-note">
                {market?.reason === "not-connected" ? "Lead search isn't connected yet, so we can't count matching people." : market ? "The lead search didn't answer just now. Try again in a minute." : "Counting matching people"}
              </p>
            </div>
          )}
        </div>
      </div>
    );

  if (view === "review")
    return (
      <div className="ph-stage">
        <div className="ph-panel">
          <header className="ph-head">
            <h1 className="ph-h">Your first email</h1>
            <p className="ph-sub">Written from your analysis for a real lead in your market. Click any card on the left to see what we found about your business, buyers and market.</p>
          </header>
          {guessNote}
          <EmailsPanel
            leads={leadsFromMarket(market, audience)}
            drafts={(o.preview ?? []).map((d) => ({ subject: d.subject, body: d.body, tab: d.tab, day: d.day }))}
            animate={false}
            writing={writing.isLoading}
            brand={o.brand}
            sender={sender}
            dockRef={dock.source("sequence")}
          />
          {writing.error ? (
            <div className="banner bad" role="alert">
              {errorMessage(writing.error)}
            </div>
          ) : null}
        </div>
      </div>
    );

  return (
    <>
      <header className="an-head">
        <h1 className="an-h">
          {fromAnswers ? (
            <>
              Here&apos;s who buys from <span className="grad">{o.brand}</span>
            </>
          ) : (
            <>
              Here&apos;s what we found on <span className="grad">{o.domain}</span>
            </>
          )}
        </h1>
        <p className="an-p">Check the facts. Your buyers, market and sample emails are on the left, and you can fine tune the audiences on the next screen.</p>
      </header>
      {updateState.error ? (
        <div className="banner bad" role="alert" style={{ marginTop: 16 }}>
          {errorMessage(updateState.error)}
        </div>
      ) : null}
      {o.analysisError?.startsWith("answers-only:") ? (
        <div className="banner bad" role="alert" style={{ marginTop: 16 }}>
          <span>The AI analysis didn&apos;t run, so this audience comes only from your answers. {o.analysisError.slice("answers-only:".length).trim()}</span>
        </div>
      ) : null}
      {o.analysis?.warning ? (
        <div className="banner" role="note" style={{ marginTop: 16 }}>
          {o.analysis.warning}
        </div>
      ) : null}
      <FactsSheet facts={o.facts} company={o.brand} onCommit={(key, value) => update({ facts: [{ key, value }] }).catch(() => undefined)} />
      {o.analysis ? <BrandSheet a={o.analysis} /> : null}
      {!fromAnswers && state.aiAvailable ? (
        <p className="fine">
          Not right?{" "}
          <button type="button" className="au-link" onClick={begin}>
            Read the site again
          </button>
        </p>
      ) : null}
    </>
  );
}
