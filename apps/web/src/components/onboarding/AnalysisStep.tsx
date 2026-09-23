"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";
import { errorCode, errorMessage, useOnboardingAnalyzeMutation, useOnboardingAnswersMutation, useOnboardingUpdateMutation } from "@/store/api";
import type { BuyerGroup, Fact, MarketView, OnboardingState } from "@/lib/types";
import { n0 } from "@/lib/format";

const COUNTRIES = ["United Kingdom", "United States", "Ireland", "Germany", "Netherlands", "France", "UAE", "Canada", "Australia"];

export function Switch2({ on, onChange, label, disabled }: { on: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" className="sw" role="switch" aria-checked={on} aria-label={label} onClick={onChange} disabled={disabled}>
      <i />
    </button>
  );
}

function AnalysisLoading({ domain }: { domain: string }) {
  const lines = [`Reading ${domain}`, "Understanding what you sell", "Mapping the people who buy it", "Sizing your market"];
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => Math.min(lines.length - 1, x + 1)), 2200);
    return () => clearInterval(t);
  }, [lines.length]);
  return (
    <>
      <header className="an-head">
        <h1 className="an-h">
          Reading <span className="grad">{domain}</span>
        </h1>
        <p className="an-p">We&apos;re going through your site to work out what you sell and who is most likely to buy it.</p>
      </header>
      <div className="an-sheet an-load">
        <div className="agent-h">
          <span className="orb" />
          <div>
            <b>Analysing your business</b>
            <small>Usually takes 15 to 30 seconds</small>
          </div>
        </div>
        <div>
          {lines.map((l, k) => (
            <div key={l} className={`scan-row ${k < i ? "done" : k === i ? "run" : ""}`}>
              <span className="st">{k < i ? <Icon id="check" /> : null}</span>
              <span>{l}</span>
              <small />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Fallback({ domain, reason, onRetry, canRetry }: { domain: string; reason: "unreadable" | "no-ai" | "failed"; onRetry: () => void; canRetry: boolean }) {
  const [sell, setSell] = useState("");
  const [who, setWho] = useState("");
  const [geo, setGeo] = useState<string[]>(["United Kingdom"]);
  const [err, setErr] = useState("");
  const [submit, { isLoading }] = useOnboardingAnswersMutation();
  const flag = reason === "unreadable" ? "Couldn't read the site" : reason === "no-ai" ? "Automatic reading isn't set up" : "The analysis didn't finish";
  return (
    <>
      <header className="an-head">
        <span className="fb-flag">
          <Icon id="alert" />
          {flag}
        </span>
        <h1 className="an-h">
          {reason === "unreadable" ? (
            <>
              We couldn&apos;t read <span className="grad">{domain}</span>
            </>
          ) : (
            <>
              Tell us about <span className="grad">{domain}</span>
            </>
          )}
        </h1>
        <p className="an-p">
          {reason === "unreadable"
            ? "The site may block automated visits, or it may still be under construction. Answer three quick questions and we'll build your audience from them."
            : reason === "no-ai"
              ? "This server can't read websites automatically yet. Answer three quick questions and we'll build your audience from them."
              : "Something went wrong while reading your site. Try again, or answer three quick questions instead."}
        </p>
      </header>
      <form
        className="an-sheet fb"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (!sell.trim()) return setErr("Tell us what you sell.");
          if (!who.trim()) return setErr("Tell us who buys it.");
          if (!geo.length) return setErr("Pick at least one country.");
          setErr("");
          try {
            await submit({ sell: sell.trim(), who: who.trim(), regions: geo }).unwrap();
          } catch (e2) {
            setErr(errorMessage(e2));
          }
        }}
      >
        <section className="an-sec">
          <div className="an-lab">
            <h3>1. What do you sell?</h3>
            <p>One sentence is enough.</p>
          </div>
          <div className="an-ctl">
            <label className="sr" htmlFor="fbSell">
              What do you sell?
            </label>
            <textarea className="an-ta" id="fbSell" rows={2} maxLength={400} placeholder="e.g. Next-day pallet delivery across the UK" value={sell} onChange={(e) => (setSell(e.target.value), setErr(""))} />
          </div>
        </section>
        <section className="an-sec">
          <div className="an-lab">
            <h3>2. Who buys it?</h3>
            <p>Their job title and the kind of company they work at.</p>
          </div>
          <div className="an-ctl">
            <label className="sr" htmlFor="fbWho">
              Who buys it?
            </label>
            <input className="an-in" id="fbWho" maxLength={400} placeholder="e.g. Operations managers at online retailers" value={who} onChange={(e) => (setWho(e.target.value), setErr(""))} />
          </div>
        </section>
        <section className="an-sec">
          <div className="an-lab">
            <h3>3. Which countries?</h3>
            <p>Pick every country you sell into.</p>
          </div>
          <div className="an-ctl">
            <div className="an-opts" role="group" aria-label="Countries">
              {COUNTRIES.map((c) => (
                <button key={c} type="button" className="an-opt" aria-pressed={geo.includes(c)} onClick={() => setGeo((g) => (g.includes(c) ? g.filter((x) => x !== c) : [...g, c]))}>
                  {c}
                </button>
              ))}
            </div>
          </div>
        </section>
        <div className="fb-foot">
          <p className="au-err" role="alert">
            {err}
          </p>
          {canRetry ? (
            <button type="button" className="btn btn-text btn-sm" onClick={onRetry}>
              Try reading the site again
            </button>
          ) : null}
          <Button variant="primary" type="submit" arrow loading={isLoading}>
            Build my audience
          </Button>
        </div>
      </form>
    </>
  );
}

function FactsSheet({ facts, company, onCommit }: { facts: Fact[]; company: string; onCommit: (key: Fact["key"], value: string) => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(facts.map((f) => [f.key, f.value])));
  const fit = (t: HTMLTextAreaElement | null) => {
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  };
  return (
    <section className="an-sheet facts">
      <div className="facts-h">
        <h2>About {vals.company || company}</h2>
        <span>Edit anything we got wrong</span>
      </div>
      {facts.map((f) => {
        const common = {
          className: "fact-in",
          id: `fact-${f.key}`,
          value: vals[f.key] ?? "",
          maxLength: 400,
          onBlur: () => (vals[f.key] ?? "").trim() !== f.value && onCommit(f.key, vals[f.key] ?? ""),
        };
        return (
          <div className="fact" key={f.key}>
            <label className="fact-l" htmlFor={`fact-${f.key}`}>
              {f.label}
            </label>
            {f.key === "company" ? (
              <input {...common} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
            ) : (
              <textarea {...common} rows={1} ref={fit} onChange={(e) => (setVals((v) => ({ ...v, [f.key]: e.target.value })), fit(e.currentTarget))} />
            )}
            <span className="src" title="Where this came from">
              <Icon id="link" />
              {f.source.startsWith("/") ? (
                <>
                  found on <code>{f.source}</code>
                </>
              ) : f.source.startsWith("from") ? (
                f.source
              ) : (
                `found in ${f.source}`
              )}
            </span>
          </div>
        );
      })}
    </section>
  );
}

function GroupCard({ g, count, onToggle, busy }: { g: BuyerGroup; count: number | null | undefined; onToggle: () => void; busy: boolean }) {
  return (
    <article className={`bg${g.on ? "" : " off"}`}>
      <div className="bg-top">
        <div>
          <h3>{g.name}</h3>
          <span className="bg-n">{count != null ? <><b>{n0(count)}</b> matching people</> : "Count appears when lead search is connected"}</span>
        </div>
        <Switch2 on={g.on} onChange={onToggle} label={`Include ${g.name}`} disabled={busy} />
      </div>
      {g.why ? <p className="bg-why">{g.why}</p> : null}
      {g.pains.length ? (
        <>
          <div className="bg-k">Pain points</div>
          <ul className="bg-pains">
            {g.pains.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      ) : null}
      <dl className="bg-meta">
        <div>
          <dt>Titles</dt>
          <dd>
            {g.titles.map((t) => (
              <span className="bg-t" key={t}>
                {t}
              </span>
            ))}
          </dd>
        </div>
        {g.sizes.length ? (
          <div>
            <dt>Company size</dt>
            <dd>{g.sizes.map((s) => `${s} employees`).join(", ")}</dd>
          </div>
        ) : null}
        <div>
          <dt>Region</dt>
          <dd>{g.regions.join(", ")}</dd>
        </div>
      </dl>
    </article>
  );
}

export function AnalysisAside({ state, market }: { state: OnboardingState; market: MarketView | undefined }) {
  const o = state.onboarding!;
  if (!o.analyzedAt)
    return (
      <div className="an-sum an-wait">
        <h5>Your audience</h5>
        <div className="an-sk w1" />
        <div className="an-sk w2" />
        <div className="an-sk w3" />
        <div className="an-sk w4" />
        <p className="an-note">{o.siteReadable === false || !state.aiAvailable ? "Answer the three questions to build it." : "Ready in a few seconds."}</p>
      </div>
    );
  const count = (id: string) => market?.groups.find((x) => x.id === id)?.count ?? null;
  return (
    <div className="an-sum">
      <h5>Your audience</h5>
      <div className="an-big">{market?.people != null ? n0(market.people) : market ? "n/a" : "…"}</div>
      <p className="an-bs">{market?.available ? "people match the buyer groups you kept on" : market ? "Connect lead search in Settings to count matching people" : "Counting matching people"}</p>
      <ul className="an-list">
        {o.groups.map((g) => (
          <li key={g.id} className={g.on ? "" : "off"}>
            <span>{g.name}</span>
            <b>{g.on ? (count(g.id) != null ? n0(count(g.id)!) : "n/a") : "Off"}</b>
          </li>
        ))}
      </ul>
      {market?.people && market.verified != null ? (
        <div className="an-q">
          <div className="an-qt">
            <span>With a verified email</span>
            <b>{n0(market.verified)}</b>
          </div>
          <div className="an-track">
            <i style={{ width: `${(market.verified / market.people) * 100}%` }} />
          </div>
        </div>
      ) : null}
      <p className="an-note">Updates as you switch groups on or off. Nothing is sent until you launch.</p>
    </div>
  );
}

export function AnalysisStep({ state, market, setNextDisabled }: { state: OnboardingState; market: MarketView | undefined; setNextDisabled: (b: boolean) => void }) {
  const o = state.onboarding!;
  const [analyze, { isLoading, error }] = useOnboardingAnalyzeMutation();
  const [update, updateState] = useOnboardingUpdateMutation();
  const tried = useRef(false);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    if (tried.current || o.analyzedAt || !state.aiAvailable || o.siteReadable === false) return;
    tried.current = true;
    analyze().catch(() => undefined);
  }, [analyze, o.analyzedAt, o.siteReadable, state.aiAvailable]);

  const onCount = o.groups.filter((g) => g.on).length;
  useEffect(() => {
    setNextDisabled(isLoading || !o.analyzedAt || onCount === 0);
    return () => setNextDisabled(false);
  }, [isLoading, o.analyzedAt, onCount, setNextDisabled]);

  if (isLoading) return <AnalysisLoading domain={o.domain} />;
  if (!o.analyzedAt) {
    const aiDown = error && errorCode(error) === "NOT_CONFIGURED";
    if (manual || o.siteReadable === false || !state.aiAvailable || aiDown || error)
      return (
        <Fallback
          domain={o.domain}
          reason={o.siteReadable === false ? "unreadable" : !state.aiAvailable || aiDown ? "no-ai" : "failed"}
          canRetry={state.aiAvailable && !aiDown}
          onRetry={() => (setManual(false), analyze().catch(() => undefined))}
        />
      );
    return <AnalysisLoading domain={o.domain} />;
  }

  const fromAnswers = o.facts.some((f) => f.source === "from your answers");
  const count = (id: string) => market?.groups.find((x) => x.id === id)?.count;
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
        <p className="an-p">Check the facts, then keep the buyer groups you want to reach. {fromAnswers ? "Built from your answers." : "Every fact shows the page it came from."}</p>
      </header>
      {updateState.error ? (
        <div className="banner bad" role="alert" style={{ marginTop: 16 }}>
          {errorMessage(updateState.error)}
        </div>
      ) : null}
      <FactsSheet facts={o.facts} company={o.brand} onCommit={(key, value) => update({ facts: [{ key, value }] }).catch(() => undefined)} />
      <div className="bg-head">
        <h2>Buyer groups</h2>
        <p>Turn off any group you don&apos;t sell to. Your market and preview update to match.</p>
      </div>
      <div className="bg-grid">
        {o.groups.map((g) => (
          <GroupCard key={g.id} g={g} count={count(g.id)} busy={updateState.isLoading} onToggle={() => update({ groups: [{ id: g.id, on: !g.on }] }).catch(() => undefined)} />
        ))}
      </div>
      <div className="an-inline">
        <span>People matching your buyers</span>
        <b>{market?.people != null ? n0(market.people) : "n/a"}</b>
      </div>
      {!fromAnswers && state.aiAvailable ? (
        <p className="fine" style={{ marginTop: -8 }}>
          Not right?{" "}
          <button type="button" className="au-link" onClick={() => analyze().catch(() => undefined)}>
            Read the site again
          </button>
        </p>
      ) : null}
    </>
  );
}
