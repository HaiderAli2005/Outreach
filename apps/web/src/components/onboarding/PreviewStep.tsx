"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";
import { errorMessage, useOnboardingPreviewMutation } from "@/store/api";
import type { Catalogue, MarketView, OnboardingState, Sender } from "@/lib/types";
import { n0 } from "@/lib/format";
import { addressesFor, monthsTxt, planFor, planRows, recommendedVolume } from "./sizing";

function withTokens(text: string): ReactNode[] {
  return text.split(/(\{\{\w+\}\})/g).map((p, i) =>
    /^\{\{\w+\}\}$/.test(p) ? (
      <span className="tok" key={i}>
        {p}
      </span>
    ) : (
      p
    ),
  );
}

function Bars({ title, data }: { title: string; data: [string, number][] }) {
  const mx = Math.max(1, ...data.map((d) => d[1]));
  const tot = data.reduce((a, d) => a + d[1], 0) || 1;
  return (
    <figure className="mk-chart">
      <figcaption>{title}</figcaption>
      {data.length ? (
        data.map(([k, v]) => (
          <div className="bar-row" key={k} title={`${k}: ${v} of ${tot} people in the sample (${Math.round((v / tot) * 100)}%)`}>
            <span className="bar-k">{k}</span>
            <span className="bar-t">
              <i style={{ width: `calc((100% - 64px) * ${(v / mx).toFixed(3)})` }} />
              <b>{Math.round((v / tot) * 100)}%</b>
            </span>
          </div>
        ))
      ) : (
        <p className="fine">Not enough data in the sample.</p>
      )}
    </figure>
  );
}

export function PreviewStep({
  state,
  cat,
  market,
  marketLoading,
  volume,
  onVolume,
  senders,
  firstDomain,
  onBack,
  setNextDisabled,
}: {
  state: OnboardingState;
  cat: Catalogue;
  market: MarketView | undefined;
  marketLoading: boolean;
  volume: number;
  onVolume: (v: number) => void;
  senders: Sender[];
  firstDomain: string;
  onBack: () => void;
  setNextDisabled: (b: boolean) => void;
}) {
  const o = state.onboarding!;
  const [generate, { isLoading, error }] = useOnboardingPreviewMutation();
  const tried = useRef(false);
  const [tab, setTab] = useState(0);
  const onGroups = o.groups.filter((g) => g.on);

  useEffect(() => {
    if (tried.current || o.preview?.length || !state.aiAvailable || !o.summary || !onGroups.length) return;
    tried.current = true;
    generate().catch(() => undefined);
  }, [generate, o.preview, o.summary, state.aiAvailable, onGroups.length]);

  useEffect(() => {
    setNextDisabled(!onGroups.length);
    return () => setNextDisabled(false);
  }, [onGroups.length, setNextDisabled]);

  if (!onGroups.length)
    return (
      <>
        <header className="an-head pv-head">
          <h1 className="an-h">Turn on a buyer group first</h1>
          <p className="an-p">Your preview is built from the buyer groups you keep on. Go back and switch at least one on.</p>
        </header>
        <div style={{ marginTop: 24 }}>
          <Button variant="primary" onClick={onBack}>
            Back to buyer groups
          </Button>
        </div>
      </>
    );

  const people = market?.people ?? null;
  const pool = market?.verified ?? market?.people ?? null;
  const rows = planRows(pool);
  const rec = recommendedVolume(pool);
  const sender = senders[0] ?? { first: "Alex", last: "" };
  const fromAddr = addressesFor(firstDomain, senders, 1, 0)[0]?.address ?? `hello@${firstDomain}`;
  const emails = o.preview ?? [];
  const m = emails[tab];

  return (
    <>
      <header className="an-head pv-head">
        <span className="nosend">
          <Icon id="shield" />
          Free preview · nothing is sent until you launch
        </span>
        <h1 className="an-h">
          {people != null ? (
            <>
              {n0(people)} people match <span className="grad">{o.brand}</span>&apos;s buyers
            </>
          ) : (
            <>
              Your preview for <span className="grad">{o.brand}</span>
            </>
          )}
        </h1>
        <p className="an-p">Here&apos;s your market, a sample of who you&apos;d reach, your first emails and a sending pace that fits.</p>
      </header>

      <section className="pv-card mk">
        <div className="pv-h">
          <div>
            <h2>Your market</h2>
            <p>
              People who match the {onGroups.length} buyer group{onGroups.length > 1 ? "s" : ""} you kept on.
              {market?.available && market.sample.size ? ` Breakdowns are from a sample of ${market.sample.size} matching people.` : ""}
            </p>
          </div>
        </div>
        {marketLoading && !market ? (
          <div className="mk-nums">
            <div>
              <span className="mk-l">People matching your buyers</span>
              <div className="an-sk w1" style={{ marginTop: 10 }} />
            </div>
            <div>
              <span className="mk-l">With a verified work email</span>
              <div className="an-sk w1" style={{ marginTop: 10 }} />
            </div>
          </div>
        ) : market?.available ? (
          <>
            <div className="mk-nums">
              <div>
                <span className="mk-l">People matching your buyers</span>
                <b className="mk-n">{people != null ? n0(people) : "n/a"}</b>
              </div>
              <div>
                <span className="mk-l">With a verified work email</span>
                <b className="mk-n">{market.verified != null ? n0(market.verified) : "n/a"}</b>
                {people && market.verified != null ? <span className="mk-s">{Math.round((market.verified / people) * 100)}% of matches</span> : null}
              </div>
            </div>
            <div className="mk-charts">
              <Bars title="By country" data={market.sample.byCountry} />
              <Bars title="By company size" data={market.sample.bySize} />
              <Bars title="By seniority" data={market.sample.bySeniority} />
            </div>
          </>
        ) : (
          <div className="notice glass info" role="note">
            <span className="ic">
              <Icon id="search" />
            </span>
            <div>
              <h3>{market?.reason === "lookup-failed" ? "The lead search didn't answer" : "Lead search isn't connected yet"}</h3>
              <p>
                {market?.reason === "lookup-failed"
                  ? "We couldn't size your market just now. You can continue and check again later."
                  : "Market size, the sample prospects and the recommended pace come from your lead database. Connect Apollo in Settings after setup, or ask your administrator to add a platform key."}
              </p>
            </div>
          </div>
        )}
      </section>

      {market?.available && market.prospects.length ? (
        <section className="pv-card">
          <div className="pv-h">
            <div>
              <h2>Sample prospects</h2>
              <p>
                {market.prospects.length} of {people != null ? n0(people) : "the"} people who match. Last names are shortened.
              </p>
            </div>
            <span className="pv-lock">
              <Icon id="lock" />
              Full contact details unlock when your campaign starts.
            </span>
          </div>
          <div className="pt-wrap">
            <table className="pt">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Job title</th>
                  <th>Company</th>
                  <th>Country</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {market.prospects.map((r, i) => (
                  <tr key={i}>
                    <td data-l="Name">
                      <span className="pt-av">{r.firstName.charAt(0)}</span>
                      <b>
                        {r.firstName} {r.lastInitial}***
                      </b>
                    </td>
                    <td data-l="Title">{r.title}</td>
                    <td data-l="Company">{r.company}</td>
                    <td data-l="Country">{r.country}</td>
                    <td data-l="Email">
                      {r.hasEmail ? (
                        <span className="pt-ok">
                          <Icon id="check" />
                          Email available
                        </span>
                      ) : (
                        <span className="fine">Checked at send time</span>
                      )}
                      <span className="pt-lk" title="Unlocks when your campaign starts" aria-label="Locked until your campaign starts">
                        <Icon id="lock" />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="pv-card">
        <div className="pv-h">
          <div>
            <h2>Your first emails</h2>
            <p>A 3 email sequence written from your analysis. You can edit every word before launch.</p>
          </div>
        </div>
        {isLoading ? (
          <div className="an-sheet an-load" style={{ margin: 0 }}>
            <div className="agent-h">
              <span className="orb" />
              <div>
                <b>Writing your sequence</b>
                <small>About 10 seconds</small>
              </div>
            </div>
          </div>
        ) : m ? (
          <div className="mail">
            <div className="mail-tabs" role="tablist">
              {emails.map((x, i) => (
                <button key={i} type="button" role="tab" aria-pressed={i === tab} onClick={() => setTab(i)}>
                  {x.tab}
                  <span>{x.day}</span>
                </button>
              ))}
            </div>
            <div className="mail-head">
              <div>
                <span>From</span>
                <span>
                  {sender.first} at {o.brand} &lt;{fromAddr}&gt;
                </span>
              </div>
              <div>
                <span>To</span>
                <span>
                  <span className="tok">{"{{first_name}}"}</span> at <span className="tok">{"{{company}}"}</span>
                </span>
              </div>
              <div>
                <span>Subject</span>
                <span className="subj">{withTokens(m.subject)}</span>
              </div>
            </div>
            <div className="mail-body">
              {withTokens(m.body)}
              {"\n\n"}
              {sender.first}
              {"\n"}
              {o.brand}
            </div>
          </div>
        ) : error ? (
          <div className="banner bad" role="alert">
            <span>{errorMessage(error)}</span>
            <Button size="sm" icon="rotate" onClick={() => generate()}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="fine">Sequence writing isn&apos;t set up on this server. You can write your emails after launch.</p>
        )}
      </section>

      <section className="pv-card">
        <div className="pv-h">
          <div>
            <h2>Recommended plan</h2>
            <p>
              {pool
                ? `How fast you'd work through your ${n0(pool)} ${market?.verified != null ? "verified " : ""}contacts. Each person gets 3 emails, over 22 sending days a month.`
                : "Pick a sending pace. Each person gets 3 emails, over 22 sending days a month."}
            </p>
          </div>
        </div>
        <div className="rp" role="radiogroup" aria-label="Daily volume">
          <div className="rp-row rp-head" aria-hidden="true">
            <span />
            <span>Emails a day</span>
            <span>New people a month</span>
            <span>Your market lasts</span>
            <span />
          </div>
          {rows.map((r) => (
            <button key={r.v} type="button" className="rp-row" role="radio" aria-checked={r.v === volume} onClick={() => onVolume(r.v)}>
              <span className="rp-dot" />
              <span className="rp-v">
                <b>{n0(r.v)}</b>
                <small>{planFor(cat, r.v).name} plan</small>
              </span>
              <span className="rp-p">{n0(r.ppm)}</span>
              <span className="rp-m">
                {r.months != null ? (
                  <>
                    <span className="rp-bar">
                      <i style={{ width: `${Math.min(1, r.months / 12) * 100}%` }} />
                    </span>
                    {monthsTxt(r.months)}
                  </>
                ) : (
                  <span className="fine">Needs market size</span>
                )}
              </span>
              <span className="rp-tag">{r.v === rec ? "Recommended" : ""}</span>
            </button>
          ))}
        </div>
        <p className="rp-note">We recommend the fastest pace that still leaves at least 3 months of new people, so there&apos;s time to improve your emails as replies come in.</p>
      </section>
    </>
  );
}
