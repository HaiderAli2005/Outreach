"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button, Notice, Skeleton } from "@/components/ui/primitives";
import { useDomainIdeasQuery } from "@/store/api";
import type { Catalogue, MarketView, Sender } from "@/lib/types";
import { money, n0 } from "@/lib/format";
import { addressesFor, autoPick, campaignPerDay, dayN, initialsOf, monthsTxt, planFor, recDomains, recInboxes, recommendedVolume, schedule, warmChart, type Totals, VOLS } from "./sizing";
import { PaymentForm, type PayHandle } from "./Payment";
import { Switch2 } from "./AnalysisStep";

export interface Draft {
  volume: number;
  volSet: boolean;
  warmup: number;
  defPer: number;
  provider: "google" | "microsoft" | "mixed";
  fast: boolean;
  senders: Sender[];
  picks: string[];
  per: Record<string, number>;
  prices: Record<string, number>;
  manual: boolean;
  pickedFor: number;
}

interface Common {
  draft: Draft;
  cat: Catalogue;
  t: Totals;
  patch: (p: Partial<Draft>) => void;
  domain: string;
}

const PROVIDER = { google: "Google Workspace", microsoft: "Microsoft 365", mixed: "Google and Microsoft" } as const;

export function SetupLines({ step, draft, cat, t }: { step: number; draft: Draft; cat: Catalogue; t: Totals }) {
  const pre = step < 4;
  const nd = pre ? recDomains(cat, draft.volume, draft.defPer) : t.picked.length;
  const ni = pre ? recInboxes(cat, draft.volume) : t.inboxes;
  const minTld = Math.min(...Object.values(cat.sizing.tldPricesCents));
  const ok = t.capacity >= draft.volume;
  const domainCents = pre ? nd * minTld : t.domainCents;
  const inboxCents = t.inboxPriceCents == null ? null : ni * t.inboxPriceCents;
  const due = inboxCents == null ? null : t.plan.priceMonthlyCents + inboxCents + domainCents;
  return (
    <>
      <div className="lines">
        <div className="line">
          <span>Daily volume</span>
          <b>{n0(draft.volume)}/day</b>
        </div>
        <div className="line">
          <span>{t.plan.name} plan</span>
          <b>{money(t.plan.priceMonthlyCents)}/mo</b>
        </div>
        <div className="line">
          <span>{nd} domains</span>
          <b>
            {pre ? "~" : ""}
            {money(domainCents)}
            <i>/yr</i>
          </b>
        </div>
        <div className="line">
          <span>
            {ni} {draft.fast ? "pre-warmed " : ""}inboxes
          </span>
          <b>
            {inboxCents == null ? "price not set" : money(inboxCents)}
            <i>/mo</i>
          </b>
        </div>
        {!pre ? (
          <div className="line">
            <span>Capacity when warm</span>
            <b style={{ color: ok ? "var(--good)" : "var(--warn)" }}>{n0(t.capacity)}/day</b>
          </div>
        ) : null}
      </div>
      <div className="total">
        <span>Due today</span>
        <b className="num">
          {due != null ? (
            money(due)
          ) : (
            <>
              {money(t.plan.priceMonthlyCents)}
              <small>+ fees</small>
            </>
          )}
        </b>
      </div>
      <p className="fine" style={{ marginTop: 8 }}>
        {inboxCents != null ? `Then ${money(t.plan.priceMonthlyCents + inboxCents)} a month. Domains renew yearly.` : "Pre-warmed inbox pricing isn't set on this server yet."}
      </p>
    </>
  );
}

export function SetupAside({ step, draft, cat, t, domain }: { step: number; draft: Draft; cat: Catalogue; t: Totals; domain: string }) {
  return (
    <>
      <div className="card glass">
        <h5>Your setup</h5>
        <SetupLines step={step} draft={draft} cat={cat} t={t} />
      </div>
      <div className="card glass protect">
        <span className="ic">
          <Icon id="shield" />
        </span>
        <div>
          <b>{domain} stays protected</b>Sending domains forward visitors to it. It never sends cold email.
        </div>
      </div>
    </>
  );
}

function needTxt(cat: Catalogue, v: number, perDomain: number, pool: number | null): ReactNode {
  const ppm = Math.round((v * 22) / 3);
  return (
    <>
      For <b>{n0(v)} emails a day</b> you need{" "}
      <b>
        {recInboxes(cat, v)} inboxes across {recDomains(cat, v, perDomain)} domains
      </b>
      . That reaches about {n0(ppm)} new people a month
      {pool ? (
        <>
          , so your market lasts <b>{monthsTxt(pool / ppm).toLowerCase()}</b>
        </>
      ) : null}
      .
    </>
  );
}

export function VolumeStep({ draft, cat, patch, market, summary }: Common & { market: MarketView | undefined; summary: ReactNode }) {
  const v = draft.volume;
  const plan = planFor(cat, v);
  const { volumeMin: min, volumeMax: max } = cat.sizing;
  const plans = [...cat.plans].sort((a, b) => a.maxDailyVolume - b.maxDailyVolume);
  const pool = market?.verified ?? market?.people ?? null;
  const rec = recommendedVolume(pool);
  const set = (x: number) => patch({ volume: x, volSet: true });
  return (
    <>
      <h2 className="ob-h">How many emails a day?</h2>
      <p className="ob-p">Pick the volume you want at full speed. We size your domains and inboxes to match, keeping every inbox under {cat.sizing.sendsPerWarmInbox} campaign emails a day.</p>
      <div className="ob-body">
        <div className="vol glass">
          <label htmlFor="obRange" className="sr">
            Emails per day
          </label>
          <div className="vol-num">
            <output className="num">{n0(v)}</output>
            <span>emails a day</span>
          </div>
          <input id="obRange" className="range" type="range" min={min} max={max} step={50} value={v} onChange={(e) => set(+e.target.value)} style={{ ["--p" as string]: `${((v - min) / (max - min)) * 100}%` }} />
          <div className="ticks">
            <span>100</span>
            <span>1,000</span>
            <span>2,500</span>
            <span>5,000</span>
          </div>
          <div className="presets">
            {VOLS.map((x) => (
              <button key={x} className="pill-btn" type="button" aria-pressed={x === v} onClick={() => set(x)}>
                {n0(x)}/day{x === rec ? " · recommended" : ""}
              </button>
            ))}
          </div>
        </div>
        <div className="plans">
          {plans.map((p) => (
            <button key={p.id} type="button" className="plan" aria-pressed={p.id === plan.id} onClick={() => set(planFor(cat, v).id === p.id ? v : p.maxDailyVolume)}>
              <span className="ck">
                <Icon id="check" />
              </span>
              <div className="pn">{p.name}</div>
              <div className="pv">Up to {n0(p.maxDailyVolume)} a day</div>
              <div className="pp">
                {money(p.priceMonthlyCents)}
                <small> /mo</small>
              </div>
              <ul>
                {p.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
        <div className="need glass">
          <span className="ic">
            <Icon id="inbox" />
          </span>
          <div>{needTxt(cat, v, draft.defPer, pool)}</div>
        </div>
        <div className="inline-sum">{summary}</div>
      </div>
    </>
  );
}

export function DomainsStep({ draft, cat, t, patch, domain, summary }: Common & { summary: ReactNode }) {
  const [showN, setShowN] = useState(12);
  const need = recDomains(cat, draft.volume, draft.defPer);
  const limit = Math.min(36, Math.max(showN, Math.ceil((need + 2) / 4) * 4));
  const { data, isLoading, isError, refetch } = useDomainIdeasQuery({ offset: 0, limit });
  const ideas = useMemo(() => data?.ideas ?? [], [data]);
  const base = domain.split(".")[0];
  const priceMap = useMemo(() => Object.fromEntries(ideas.map((x) => [x.name, x.priceCents])), [ideas]);

  useEffect(() => {
    if (!ideas.length) return;
    if (!draft.picks.length || (!draft.manual && draft.pickedFor !== draft.volume)) {
      patch({ picks: autoPick(ideas, need), pickedFor: draft.volume, manual: false, prices: { ...draft.prices, ...priceMap } });
    }
  }, [ideas, need, draft.picks.length, draft.manual, draft.pickedFor, draft.volume, draft.prices, priceMap, patch]);

  const firstFree = ideas.find((x) => x.available !== false);
  const cap = t.capacity;
  const ok = cap >= draft.volume;
  const minTld = Math.min(...Object.values(cat.sizing.tldPricesCents));

  return (
    <>
      <h2 className="ob-h">Choose your sending domains</h2>
      <p className="ob-p">
        Buy more than one so sending is spread out. Each one forwards visitors to <b>{domain}</b>, which never sends cold email itself. Domains are from {money(minTld)} a year each.
      </p>
      <div className="ob-body">
        <div className="dtool glass">
          <div className="cap">
            <div className="cap-top">
              <span>
                {draft.picks.length} of {need} recommended selected
              </span>
              <b style={{ color: ok ? "var(--good)" : "var(--warn)" }}>
                {n0(cap)} / {n0(draft.volume)} a day
              </b>
            </div>
            <div className="track">
              <i style={{ width: `${Math.min(100, (cap / draft.volume) * 100)}%` }} />
            </div>
          </div>
          <Button size="sm" disabled={!ideas.length} onClick={() => patch({ picks: autoPick(ideas, need), manual: false, pickedFor: draft.volume, prices: { ...draft.prices, ...priceMap } })}>
            Pick recommended ({need})
          </Button>
        </div>
        {isError ? (
          <div className="banner bad">
            <span>Domain ideas didn&apos;t load.</span>
            <Button size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        ) : isLoading ? (
          <div className="dgrid">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} h={86} r={12} />
            ))}
          </div>
        ) : (
          <div className="dgrid">
            {ideas.map((x) => {
              const on = draft.picks.includes(x.name);
              return (
                <button
                  key={x.name}
                  type="button"
                  className="dtile"
                  title={x.name}
                  aria-pressed={on}
                  disabled={x.available === false}
                  onClick={() => patch({ manual: true, picks: on ? draft.picks.filter((p) => p !== x.name) : [...draft.picks, x.name], prices: { ...draft.prices, [x.name]: x.priceCents } })}
                >
                  {x === firstFree ? <span className="rec">Best match</span> : null}
                  <span className="dn">
                    {x.prefix}
                    <em>{base}</em>
                    {x.suffix}
                  </span>
                  <span className="box">
                    <Icon id="check" />
                  </span>
                  <span className="ds">
                    <i />
                    {x.available === false ? "Taken" : x.available ? "Available" : "Not verified"}
                  </span>
                  <span className="dp">{money(x.priceCents)}/yr</span>
                </button>
              );
            })}
          </div>
        )}
        {data && limit < Math.min(36, data.total) ? (
          <Button size="sm" className="more" onClick={() => setShowN(limit + 12)}>
            Show more ideas
          </Button>
        ) : null}
        <div className="inline-sum">{summary}</div>
      </div>
    </>
  );
}

function Timeline({ cat, t, draft }: { cat: Catalogue; t: Totals; draft: Draft }) {
  const k = schedule(cat, draft.warmup, draft.fast);
  const a = draft.fast
    ? ["Pre-warmed inboxes connected", `They've already built a sending reputation, so there's no ${draft.warmup} day wait.`]
    : ["Warmup starts", "Inboxes send and reply to warmup emails only. No campaign emails yet."];
  return (
    <ol className="tl3">
      <li className="on">
        <span className="tl-d">Day 1 · Today</span>
        <b>{a[0]}</b>
        <p>{a[1]}</p>
      </li>
      <li>
        <span className="tl-d">
          Day {k.first} · {dayN(k.first)}
        </span>
        <b>First campaign emails</b>
        <p>
          {k.lo} to {k.hi} per inbox a day, {n0(t.inboxes * k.lo)} to {n0(t.inboxes * k.hi)} in total.
        </p>
      </li>
      <li>
        <span className="tl-d">
          Day {k.full} · {dayN(k.full)}
        </span>
        <b>Full volume</b>
        <p>
          Up to {cat.sizing.sendsPerWarmInbox} per inbox a day, {n0(t.capacity)} in total.
        </p>
      </li>
    </ol>
  );
}

function Chart({ cat, t, draft }: { cat: Catalogue; t: Totals; draft: Draft }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [tip, setTip] = useState<{ x: number; text: ReactNode } | null>(null);
  const k = schedule(cat, draft.warmup, draft.fast);
  const per = cat.sizing.sendsPerWarmInbox;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const c = useMemo(() => warmChart(t.inboxes, per, draft.volume, k, draft.fast, w), [t.inboxes, per, draft.volume, k, draft.fast, w]);
  return (
    <div
      className="chart"
      ref={ref}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const sx = w / r.width;
        const x = (e.clientX - r.left) * sx;
        const d = Math.max(1, Math.min(c.days, Math.round(1 + ((x - c.pl) / (w - c.pl - c.pr)) * (c.days - 1))));
        setTip({
          x: Math.min(r.width - 190, Math.max(4, e.clientX - r.left + 12)),
          text: (
            <>
              <b>
                Day {d} · {dayN(d)}
              </b>
              {d < k.first ? (draft.fast ? "Connecting inboxes" : "Warmup only, no campaign emails") : `${n0(campaignPerDay(t.inboxes, per, k, d))} campaign emails`}
            </>
          ),
        });
      }}
      onMouseLeave={() => setTip(null)}
    >
      <div dangerouslySetInnerHTML={{ __html: c.svg }} />
      {tip ? (
        <div className="c-tip" style={{ left: tip.x, top: 6 }}>
          {tip.text}
        </div>
      ) : null}
    </div>
  );
}

export function InboxesStep({ draft, cat, t, patch, summary }: Common & { summary: ReactNode }) {
  const k = schedule(cat, draft.warmup, draft.fast);
  const perInbox = cat.sizing.sendsPerWarmInbox;
  const maxPer = cat.sizing.maxInboxesPerDomain;
  const ok = t.capacity >= draft.volume;
  const short = Math.max(0, Math.ceil((draft.volume - t.capacity) / perInbox));
  const counts = t.picked.map((x) => x.inboxes);
  const allSame = counts.length && counts.every((c) => c === counts[0]) ? counts[0] : 0;
  const fast = cat.sizing.fastStart;
  const rows = t.picked.map((x, di) => ({ x, list: addressesFor(x.name, draft.senders, x.inboxes, di) }));
  const senderCount = (s: Draft["senders"][number]) => rows.reduce((c, r) => c + r.list.filter((a) => a.sender === s).length, 0);
  const setSender = (i: number, p: Partial<Sender>) => patch({ senders: draft.senders.map((s, j) => (j === i ? { ...s, ...p } : s)) });

  return (
    <>
      <h2 className="ob-h">Set up your inboxes</h2>
      <p className="ob-p">
        Up to {maxPer} inboxes per domain. Three is the sweet spot for reputation, and each inbox sends at most {perInbox} campaign emails a day once warm.
      </p>
      <div className="ob-body">
        <section className="plan-card glass">
          <div className="pc-h">
            <h3>Your sending timeline</h3>
            <p>{draft.fast ? "Fast start skips the warmup wait." : "Campaigns start after warmup, not on day 1."}</p>
          </div>
          <Timeline cat={cat} t={t} draft={draft} />
        </section>
        <section className={`fs glass${draft.fast ? " on" : ""}`}>
          <div className="fs-txt">
            <h3>
              Fast start <span className="fs-tag">Optional</span>
            </h3>
            <p>
              {fast.available && fast.inboxPriceCents
                ? `Use pre-warmed inboxes and start your campaign in about ${fast.days} days instead of ${draft.warmup}. Pre-warmed inboxes cost more each month: ${money(fast.inboxPriceCents)} per inbox instead of ${money(cat.sizing.inboxPriceCents)}.`
                : `Pre-warmed inboxes would let your campaign start in about ${fast.days} days. They aren't offered on this server yet.`}
            </p>
          </div>
          <Switch2 on={draft.fast} onChange={() => patch({ fast: !draft.fast })} label="Fast start with pre-warmed inboxes" disabled={!fast.available} />
        </section>
        <section className="snd glass">
          <div className="pc-h">
            <h3>Sender names</h3>
            <p>Add up to 3 people. Inboxes are shared between them, so no single name sends everything.</p>
          </div>
          <div className="snd-rows">
            {draft.senders.map((s, i) => (
              <div className="snd-row" key={i}>
                <span className="snd-av">{initialsOf(s) || "?"}</span>
                <label className="sr" htmlFor={`sf${i}`}>
                  First name
                </label>
                <input className="input" id={`sf${i}`} value={s.first} maxLength={60} placeholder="First name" autoComplete="off" onChange={(e) => setSender(i, { first: e.target.value })} />
                <label className="sr" htmlFor={`sl${i}`}>
                  Last name
                </label>
                <input className="input" id={`sl${i}`} value={s.last} maxLength={60} placeholder="Last name" autoComplete="off" onChange={(e) => setSender(i, { last: e.target.value })} />
                <span className="snd-n">{senderCount(s)} inboxes</span>
                {draft.senders.length > 1 ? (
                  <button type="button" className="snd-x" aria-label={`Remove ${s.first || "sender"}`} onClick={() => patch({ senders: draft.senders.filter((_, j) => j !== i) })}>
                    <Icon id="x" />
                  </button>
                ) : (
                  <span className="snd-x" aria-hidden="true" />
                )}
              </div>
            ))}
          </div>
          {draft.senders.length < 3 ? (
            <button type="button" className="btn btn-ghost btn-sm snd-add" onClick={() => patch({ senders: [...draft.senders, { first: "", last: "" }] })}>
              <Icon id="plus" />
              Add sender
            </button>
          ) : null}
        </section>
        <div className="ibx glass">
          <div className="ibx-head">
            <b>
              {t.inboxes} {draft.fast ? "pre-warmed " : ""}inboxes on {t.picked.length} domains
            </b>
            <div className="setall">
              <span>Set all to</span>
              <div className="seg" role="group" aria-label="Inboxes per domain">
                {Array.from({ length: maxPer }, (_, i) => i + 1).map((n) => (
                  <button key={n} type="button" aria-pressed={allSame === n} style={{ width: 34 }} onClick={() => patch({ defPer: n, per: Object.fromEntries(draft.picks.map((p) => [p, n])) })}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            {rows.map(({ x, list }) => (
              <div className="ibx-row" key={x.name}>
                <span className="dn">{x.name}</span>
                <span className="stepper">
                  <button type="button" disabled={x.inboxes <= 1} aria-label={`Fewer inboxes on ${x.name}`} onClick={() => patch({ per: { ...draft.per, [x.name]: x.inboxes - 1 } })}>
                    <Icon id="minus" />
                  </button>
                  <output>{x.inboxes}</output>
                  <button type="button" disabled={x.inboxes >= maxPer} aria-label={`More inboxes on ${x.name}`} onClick={() => patch({ per: { ...draft.per, [x.name]: x.inboxes + 1 } })}>
                    <Icon id="plus" />
                  </button>
                </span>
                <span className="addrs">
                  {list.map((a) => (
                    <span className="addr" key={a.address} title={`${a.sender.first} ${a.sender.last}`.trim()}>
                      <i>{initialsOf(a.sender)}</i>
                      {a.address}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="warm glass">
          <div className="warm-top">
            <div>
              <h3>Sending plan</h3>
              <p>Campaign emails per day across all {t.inboxes} inboxes.</p>
            </div>
            {!draft.fast ? (
              <div className="wl">
                <span>Warmup before first email</span>
                <div className="seg" role="group" aria-label="Warmup length">
                  {cat.sizing.warmupOptions.map((d) => (
                    <button key={d} type="button" aria-pressed={draft.warmup === d} style={{ padding: "0 12px" }} onClick={() => patch({ warmup: d })}>
                      {d} days
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <Chart cat={cat} t={t} draft={draft} />
          <div className="keys">
            <div className="key">
              <small>First campaign emails</small>
              <b>
                {dayN(k.first)} · Day {k.first}
              </b>
            </div>
            <div className="key">
              <small>Emails that day</small>
              <b>
                {n0(t.inboxes * k.lo)} to {n0(t.inboxes * k.hi)}
              </b>
            </div>
            <div className="key">
              <small>Full volume from</small>
              <b>
                {dayN(k.full)} · {n0(t.capacity)} a day
              </b>
            </div>
          </div>
          <div style={{ marginTop: 16 }} className={`ok-line ${ok ? "g" : "w"}`}>
            <Icon id={ok ? "check" : "alert"} />
            <span>{ok ? `Covers your ${n0(draft.volume)} a day target once warm.` : `${n0(t.capacity)} a day is below your ${n0(draft.volume)} target. Add ${short} more inbox${short > 1 ? "es" : ""} or another domain.`}</span>
          </div>
        </div>
        <div className="inline-sum">{summary}</div>
      </div>
    </>
  );
}

export function PaymentStep({
  draft,
  cat,
  t,
  orgId,
  awaiting,
  register,
  onPaid,
  onBusy,
  email,
  summary,
}: Common & { orgId: string; awaiting: boolean; register: (h: PayHandle | null) => void; onPaid: () => void; onBusy: (b: boolean) => void; email: string; summary: ReactNode }) {
  const k = schedule(cat, draft.warmup, draft.fast);
  const signature = `${draft.volume}-${draft.picks.join(",")}-${t.inboxes}-${draft.fast}`;
  return (
    <>
      <h2 className="ob-h">Review and pay</h2>
      <p className="ob-p">
        One payment sets everything up: <b>{t.picked.length} domains</b>,{" "}
        <b>
          {t.inboxes} {draft.fast ? "pre-warmed " : ""}inboxes
        </b>{" "}
        and your <b>{t.plan.name}</b> plan.
      </p>
      <div className="ob-body">
        {awaiting ? (
          <Notice tone="info" icon="card" title="Payment submitted">
            We&apos;re waiting for Stripe to confirm it. This usually takes a few seconds and the page moves on by itself.
          </Notice>
        ) : null}
        <div className="pay">
          <PaymentForm orgId={orgId} signature={signature} register={register} onPaid={onPaid} onBusy={onBusy} />
          <div className="panel glass">
            <h3>What happens after you pay</h3>
            <p style={{ marginTop: 6 }}>You don&apos;t need to keep this page open. Setup status stays in your account, and billing receipts go to {email}.</p>
            <ol className="timeline">
              <li>
                <i />
                <span>
                  <b>{t.picked.length} domains</b> queued for registration
                </span>
                <small>after payment</small>
              </li>
              <li>
                <i />
                <span>
                  <b>SPF, DKIM and DMARC</b> set up with each domain
                </span>
                <small>after registration</small>
              </li>
              <li>
                <i />
                <span>
                  <b>
                    {t.inboxes} {draft.fast ? "pre-warmed " : ""}inboxes
                  </b>{" "}
                  queued for creation
                </span>
                <small>after payment</small>
              </li>
              <li>
                <i />
                <span>
                  <b>{draft.fast ? "Inboxes connected" : "Warmup starts"}</b>
                  {draft.fast ? "" : ", no campaign emails yet"}
                </span>
                <small>Day 1</small>
              </li>
              <li>
                <i />
                <span>
                  <b>First campaign emails</b>, {k.lo} to {k.hi} per inbox a day
                </span>
                <small>
                  Day {k.first} · {dayN(k.first)}
                </small>
              </li>
              <li>
                <i />
                <span>
                  <b>Full volume</b>, {n0(t.capacity)} a day
                </span>
                <small>
                  Day {k.full} · {dayN(k.full)}
                </small>
              </li>
            </ol>
          </div>
        </div>
        <div className="inline-sum">{summary}</div>
      </div>
    </>
  );
}
