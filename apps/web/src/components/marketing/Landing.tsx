"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, Mark } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/primitives";
import { DomainSearch } from "./DomainSearch";
import { usePlansQuery } from "@/store/api";
import { money, n0 } from "@/lib/format";
import type { Catalogue } from "@/lib/types";

const EXAMPLE_FEED = [
  { n: "Maya Reid", r: "Loomwork", m: "This is timely. Are you free Thursday at 3?", t: "Meeting booked", c: "g", av: "#8A6A45" },
  { n: "Daniel Kerr", r: "Brightlabs", m: "Send over pricing and a short case study?", t: "Interested", c: "b", av: "#6B5B4A" },
  { n: "Priya Shah", r: "Parcelry", m: "Loop in Tom, he owns this on our side.", t: "Referral", c: "v", av: "#A07F55" },
  { n: "Chris Bell", r: "Harbor & Co", m: "Not this quarter. Try me again in January.", t: "Later", c: "y", av: "#5E5850" },
  { n: "Sofia Lund", r: "Fernway", m: "Yes, let's talk. Here's my calendar link.", t: "Meeting booked", c: "g", av: "#6E7F63" },
];

const focusSearch = () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
  setTimeout(() => window.dispatchEvent(new Event("ap:focus-search")), 500);
};

function Nav() {
  return (
    <header className="nav">
      <div className="nav-in glass">
        <a className="logo" href="#top" aria-label="Aperture home">
          <Mark />
          Aperture
        </a>
        <nav className="nav-links" aria-label="Main">
          <a href="#how">How it works</a>
          <a href="#deliverability">Deliverability</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="nav-cta">
          <Link className="btn btn-text btn-sm" href="/signin">
            Sign in
          </Link>
          <button className="btn btn-glass btn-sm" type="button" onClick={focusSearch}>
            Start setup
          </button>
        </div>
      </div>
    </header>
  );
}

function Console({ domain }: { domain: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [feedI, setFeedI] = useState(0);
  const [sent, setSent] = useState(312);
  const base = domain.split(".")[0];
  const tld = domain.slice(base.length);
  const doms = [`get${base}.com`, `try${base}${tld}`, `${base}hq.com`, `use${base}.co`];
  const health = [99, 98, 97, 95];

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const a = setInterval(() => setFeedI((i) => (i + EXAMPLE_FEED.length - 1) % EXAMPLE_FEED.length), 3600);
    const b = setInterval(() => setSent((s) => (s >= 480 ? 280 : Math.min(480, s + 1 + Math.floor(Math.random() * 3)))), 1400);
    const con = ref.current;
    let ticking = false;
    const upd = () => {
      ticking = false;
      if (!con) return;
      const r = con.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (innerHeight - r.top) / (innerHeight * 0.75)));
      con.style.transform = `rotateX(${(1 - p) * 16}deg) scale(${0.94 + 0.06 * p})`;
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(upd);
      }
    };
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", upd);
    upd();
    return () => {
      clearInterval(a);
      clearInterval(b);
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", upd);
    };
  }, []);

  return (
    <div className="stage">
      <div className="console glass" ref={ref} aria-label="Example dashboard for a warmed sending setup">
        <div className="c-top">
          <div className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div className="c-title">
            Example setup · <b>{domain}</b>
          </div>
          <span className="live">
            <span className="pulse" />
            Warm · Live
          </span>
        </div>
        <div className="c-grid">
          <div className="pane">
            <h4>
              Sending domains <span className="mono">4 domains · 12 inboxes</span>
            </h4>
            <div>
              {doms.map((x, i) => {
                const at = x.indexOf(base);
                return (
                  <div className="dom-row" key={x}>
                    <span className="d">
                      {x.slice(0, at)}
                      <em>{base}</em>
                      {x.slice(at + base.length)}
                    </span>
                    <span className="h">{health[i]}%</span>
                    <span className="tags">
                      <span className="tag">SPF</span>
                      <span className="tag">DKIM</span>
                      <span className="tag">DMARC</span>
                    </span>
                    <span className="bar">
                      <i style={{ width: `${health[i]}%` }} />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="pane">
            <h4>
              Inbox placement <span className="mono">last 7 days</span>
            </h4>
            <div className="big num">
              96.8<small>%</small>
            </div>
            <div className="sub">Landed in primary inbox, not spam</div>
            <div className="sent">
              <div className="sent-top">
                <span>Sent today</span>
                <b className="num">{sent} / 480</b>
              </div>
              <div className="track">
                <i style={{ width: `${(sent / 480) * 100}%` }} />
              </div>
            </div>
            <div className="ramp">
              <svg viewBox="0 0 260 70" aria-hidden="true">
                <defs>
                  <linearGradient id="rampFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#D4AE72" stopOpacity=".16" />
                    <stop offset="1" stopColor="#D4AE72" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0 64 C40 62 70 54 110 40 S180 12 210 8 L260 8 L260 70 L0 70Z" fill="url(#rampFill)" />
                <path className="draw" d="M0 64 C40 62 70 54 110 40 S180 12 210 8 L260 8" fill="none" stroke="#D4AE72" strokeWidth="2.2" strokeLinecap="round" />
                <circle cx="210" cy="8" r="3.5" fill="#15100C" stroke="#D4AE72" strokeWidth="1.6" />
              </svg>
              <div className="lbl">
                <span>Day 1 · 5/inbox</span>
                <span>Day 21 · 40/inbox</span>
              </div>
            </div>
          </div>
          <div className="pane">
            <h4>
              Replies <span className="mono">today</span>
            </h4>
            <div className="feed">
              {[0, 1, 2].map((k) => {
                const f = EXAMPLE_FEED[(feedI + k) % EXAMPLE_FEED.length];
                return (
                  <div className="reply" key={`${feedI}-${k}`}>
                    <span className="av" style={{ background: f.av }}>
                      {f.n
                        .split(" ")
                        .map((x) => x[0])
                        .join("")}
                    </span>
                    <div>
                      <div className="who">
                        <b>{f.n}</b>
                        <span>{f.r}</span>
                      </div>
                      <p>{f.m}</p>
                      <span className={`chip-s ${f.c}`}>{f.t}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function sizing(cat: Catalogue, v: number) {
  const plans = [...cat.plans].sort((a, b) => a.maxDailyVolume - b.maxDailyVolume);
  const plan = plans.find((p) => v <= p.maxDailyVolume) ?? plans[plans.length - 1];
  const inboxes = Math.ceil(v / cat.sizing.sendsPerWarmInbox);
  const domains = Math.ceil(inboxes / 3);
  const minTld = Math.min(...Object.values(cat.sizing.tldPricesCents));
  return { plan, inboxes, domains, minTld };
}

function Pricing() {
  const { data: cat, isLoading, isError, refetch } = usePlansQuery();
  const [v, setV] = useState(1000);
  const s = useMemo(() => (cat ? sizing(cat, v) : null), [cat, v]);
  const min = cat?.sizing.volumeMin ?? 100;
  const max = cat?.sizing.volumeMax ?? 5000;
  return (
    <section className="sec" id="pricing">
      <div className="wrap">
        <div className="sec-head">
          <div>
            <div className="eyebrow">Pricing</div>
            <h2 className="h2">
              Priced by what you send <span className="dim">each day.</span>
            </h2>
          </div>
          <p className="sec-lede">Move the slider. We work out the inboxes and domains you need so every inbox stays under 40 sends a day.</p>
        </div>
        <div className="price-card glass">
          <div className="pc-l">
            <label htmlFor="lpRange" style={{ fontSize: 14, color: "var(--ink-2)" }}>
              How many emails a day?
            </label>
            <div className="vol-num">
              <output className="num">{n0(v)}</output>
              <span>emails a day</span>
            </div>
            <input
              id="lpRange"
              className="range"
              type="range"
              min={min}
              max={max}
              step={50}
              value={v}
              onChange={(e) => setV(+e.target.value)}
              style={{ ["--p" as string]: `${((v - min) / (max - min)) * 100}%` }}
            />
            <div className="ticks">
              <span>100</span>
              <span>1,000</span>
              <span>2,500</span>
              <span>5,000</span>
            </div>
            <div className="presets">
              {[250, 500, 1000, 2500, 5000].map((x) => (
                <button key={x} className="pill-btn" type="button" aria-pressed={x === v} onClick={() => setV(x)}>
                  {n0(x)}/day
                </button>
              ))}
            </div>
          </div>
          <div className="pc-r">
            {s && cat ? (
              <>
                <div className="lines">
                  <div className="line">
                    <span>
                      {s.plan.name} plan<small>Up to {n0(s.plan.maxDailyVolume)} emails a day</small>
                    </span>
                    <b>{money(s.plan.priceMonthlyCents)}/mo</b>
                  </div>
                  <div className="line">
                    <span>
                      {s.inboxes} inboxes<small>{money(cat.sizing.inboxPriceCents)} each, {cat.sizing.sendsPerWarmInbox} sends a day max</small>
                    </span>
                    <b>{money(s.inboxes * cat.sizing.inboxPriceCents)}/mo</b>
                  </div>
                  <div className="line">
                    <span>
                      {s.domains} sending domains<small>From {money(s.minTld)} a year each</small>
                    </span>
                    <b>{money(s.domains * s.minTld)}/yr</b>
                  </div>
                </div>
                <div className="total">
                  <span>Per month</span>
                  <b className="num">
                    {money(s.plan.priceMonthlyCents + s.inboxes * cat.sizing.inboxPriceCents)}
                    <small> /mo</small>
                  </b>
                </div>
              </>
            ) : isError ? (
              <div className="errbox" style={{ padding: 20 }}>
                <b>Prices didn&apos;t load</b>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => refetch()}>
                  Try again
                </button>
              </div>
            ) : isLoading ? (
              <div style={{ display: "grid", gap: 14 }}>
                <Skeleton h={44} />
                <Skeleton h={44} />
                <Skeleton h={44} />
                <Skeleton h={56} />
              </div>
            ) : null}
            <button className="btn btn-primary" style={{ width: "100%", marginTop: 22 }} type="button" onClick={focusSearch}>
              Start with this setup
              <Icon id="arr" className="arr" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Landing() {
  const [domain, setDomain] = useState("northwind.io");
  const base = domain.split(".")[0];
  const orb = [`get${base}.com`, `try${base}${domain.slice(base.length)}`, `${base}hq.com`, `use${base}.com`, `meet${base}.co`];

  return (
    <div id="landing">
      <Nav />
      <main id="top">
        <section className="hero">
          <div className="hero-sky" aria-hidden="true" />
          <div className="hero-in wrap">
            <p className="hero-kicker">Cold email infrastructure, set up by an agent</p>
            <h1 className="display">
              <span className="ln">
                <span>Type your domain.</span>
              </span>
              <span className="ln l2">
                <span>We build the outbound.</span>
              </span>
            </h1>
            <p className="lede">Aperture reads your site, finds your buyers, then plans, warms and launches your sending domains. Your main domain never sends a cold email.</p>
            <div className="lq-stage">
              <DomainSearch id="heroDomain" hero onDomain={setDomain} />
            </div>
            <Console domain={domain} />
          </div>
        </section>

        <section className="sec" id="how">
          <div className="wrap">
            <div className="sec-head">
              <div>
                <div className="eyebrow">How it works</div>
                <h2 className="h2">
                  From domain to first reply <span className="dim">in one sitting.</span>
                </h2>
              </div>
              <p className="sec-lede">Six steps, in this order. You see your audience and a written sequence for free, and you only pay once you are happy with the plan.</p>
            </div>
            <div className="flow">
              {[
                ["Enter your domain", "We read your site to learn what you sell and who it is for."],
                ["Meet your audience", "Industries, job titles and regions most likely to buy."],
                ["See a free preview", "Your market, sample prospects and first sequence. Nothing is sent."],
                ["Pick a daily volume", "From 100 to 5,000 emails a day, priced by what you send."],
                ["Domains and inboxes", "Lookalike sending domains, with inboxes planned on each."],
                ["Warm up and launch", "Inboxes warm up for 14 days, then your campaign starts and ramps to full volume."],
              ].map(([h, p], i) => (
                <div className="fstep" key={h}>
                  <span className="n">{i + 1}</span>
                  <h3>{h}</h3>
                  <p>{p}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="sec" id="deliverability">
          <div className="wrap deliv">
            <div>
              <div className="eyebrow">Deliverability</div>
              <h2 className="h2">Your main domain never sends a cold email.</h2>
              <div className="points">
                <div className="point">
                  <span className="ic">
                    <Icon id="shield" />
                  </span>
                  <div>
                    <h3>Lookalike sending domains</h3>
                    <p>
                      Domains like <span className="mono">get{base}.io</span> forward visitors to your real site, so your own reputation stays clean.
                    </p>
                  </div>
                </div>
                <div className="point">
                  <span className="ic">
                    <Icon id="key" />
                  </span>
                  <div>
                    <h3>SPF, DKIM and DMARC on every sending domain</h3>
                    <p>Authentication records are part of the setup, so each domain is ready to send when its inboxes are.</p>
                  </div>
                </div>
                <div className="point">
                  <span className="ic">
                    <Icon id="flame" />
                  </span>
                  <div>
                    <h3>Warmup that adjusts itself</h3>
                    <p>Each new inbox warms up for 14 days before it sends a campaign email, then starts at 10 to 15 a day and climbs to 40. If bounces or spam signals move, the ramp slows down.</p>
                  </div>
                </div>
                <div className="point">
                  <span className="ic">
                    <Icon id="rotate" />
                  </span>
                  <div>
                    <h3>Rotation across every inbox</h3>
                    <p>Sends spread evenly so no single inbox carries the load.</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="orbit-card glass">
              <div className="orbit" aria-hidden="true">
                <div className="ring" style={{ ["--i" as string]: "0%" }} />
                <div className="ring" style={{ ["--i" as string]: "19%" }} />
                {[
                  ["0%", "60s", "0s", ""],
                  ["0%", "60s", "-20s", ""],
                  ["0%", "60s", "-40s", ""],
                  ["19%", "44s", "-7s", "rev"],
                  ["19%", "44s", "-29s", "rev"],
                ].map(([i, t, d, rev], k) => (
                  <div key={k} className={`spin ${rev}`} style={{ ["--i" as string]: i, ["--t" as string]: t, ["--d" as string]: d }}>
                    <div className="sat">
                      <span>{orb[k]}</span>
                    </div>
                  </div>
                ))}
                <div className="core">
                  <div>
                    <b>{domain}</b>
                    <small>
                      <Icon id="shield" />
                      protected
                    </small>
                  </div>
                </div>
              </div>
              <div className="dns">
                <table>
                  <tbody>
                    <tr>
                      <td>TXT</td>
                      <td>@</td>
                      <td>v=spf1 include:… ~all</td>
                      <td className="ok">SPF</td>
                    </tr>
                    <tr>
                      <td>TXT</td>
                      <td>s1._domainkey</td>
                      <td>v=DKIM1; k=rsa; p=MIIBIjANBgkqh…</td>
                      <td className="ok">DKIM</td>
                    </tr>
                    <tr>
                      <td>TXT</td>
                      <td>_dmarc</td>
                      <td>v=DMARC1; p=quarantine; rua=mailto:…</td>
                      <td className="ok">DMARC</td>
                    </tr>
                    <tr>
                      <td>MX</td>
                      <td>@</td>
                      <td>mail exchanger for replies</td>
                      <td className="ok">MX</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        <Pricing />

        <section className="sec" id="faq">
          <div className="wrap faq">
            <div>
              <div className="eyebrow">FAQ</div>
              <h2 className="h2">Good questions.</h2>
            </div>
            <div>
              {[
                ["Why not send from my own domain?", "Cold email carries reputation risk. If a campaign trips a spam filter, you want that to happen on a spare domain, not the one your customers and invoices depend on."],
                ["How long does warmup take?", "New inboxes warm up for 14 days before the first campaign email, and you can choose 21 or 28. Your campaign then starts at 10 to 15 emails per inbox a day and reaches full volume over the next two weeks."],
                ["Who owns the sending domains?", "Your organization. The domains you choose are listed in your account with their status, and they forward visitors to your main site."],
                ["What is in the free preview?", "An analysis of your business, the size of your market, sample prospects, a three step email sequence written for it and a recommended plan. No email is sent and no card is needed."],
                ["Can I bring my own lead list?", "Yes. Upload a CSV on the launch screen, use the audience we find, or mix both. We check every address before it gets an email."],
              ].map(([q, a], i) => (
                <details className="qa" key={q} open={i === 0}>
                  <summary>
                    {q}
                    <i>
                      <Icon id="plus" />
                    </i>
                  </summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <div className="wrap">
          <div className="cta glass">
            <div className="glow" aria-hidden="true" />
            <div className="eyebrow">Ready when you are</div>
            <h2 className="h2" style={{ marginTop: 14 }}>
              Your first campaign is one domain away.
            </h2>
            <DomainSearch id="ctaDomain" cta onDomain={setDomain} />
          </div>
        </div>
      </main>

      <footer className="site-foot">
        <div className="wrap foot">
          <a className="logo" href="#top">
            <Mark />
            Aperture
          </a>
          <nav aria-label="Footer">
            <a href="#how">How it works</a>
            <a href="#deliverability">Deliverability</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
            <Link href="/signin">Sign in</Link>
          </nav>
          <span>© {new Date().getFullYear()} Aperture</span>
        </div>
      </footer>
    </div>
  );
}
