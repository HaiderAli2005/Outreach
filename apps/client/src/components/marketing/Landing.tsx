"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, Mark, type IconId } from "@/components/ui/Icon";
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
          <a href="#product">Product</a>
          <a href="#deliverability">Deliverability</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="nav-cta">
          <Link className="btn btn-text btn-sm" href="/signin">
            Sign in
          </Link>
          <Link className="btn btn-glass btn-sm" href="/onboarding">
            Start setup
          </Link>
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

/**
 * Scroll motion for everything below the hero.
 * [data-reveal] fades up once when it enters the viewport (stagger via --rd).
 * [data-parallax="0.08"] drifts against the scroll, measured from its parent so its own transform never feeds back.
 * Nothing moves under prefers-reduced-motion, and without JS every element is simply visible.
 */
function useLandingMotion(root: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.dataset.motion = "on";
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.in = "1";
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    el.querySelectorAll("[data-reveal]").forEach((n) => io.observe(n));

    const par = Array.from(el.querySelectorAll<HTMLElement>("[data-parallax]"));
    let raf = 0;
    const tick = () => {
      raf = 0;
      const vh = innerHeight;
      for (const n of par) {
        const host = n.parentElement;
        if (!host) continue;
        const r = host.getBoundingClientRect();
        if (r.bottom < -300 || r.top > vh + 300) continue;
        const off = r.top + r.height / 2 - vh / 2;
        n.style.transform = `translate3d(0, ${(-off * Number(n.dataset.parallax)).toFixed(1)}px, 0)`;
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    tick();
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
      delete el.dataset.motion;
    };
  }, [root]);
}

/** Counts up to `to` the first time it is seen. Server render and reduced motion show the final number. */
function Count({ to, pad = 0 }: { to: number; pad?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [v, setV] = useState(to);
  useEffect(() => {
    const el = ref.current;
    if (!el || to === 0 || typeof IntersectionObserver === "undefined") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < innerHeight) return;
    setV(0);
    let raf = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        const t0 = performance.now();
        const step = (t: number) => {
          const p = Math.min(1, (t - t0) / 1400);
          setV(Math.round(to * (1 - Math.pow(1 - p, 4))));
          if (p < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to]);
  return (
    <span ref={ref} className="num">
      {String(v).padStart(pad, "0")}
    </span>
  );
}

const rd = (i: number, step = 0.08) => ({ ["--rd" as string]: `${(i * step).toFixed(2)}s` });

/** Moves a soft light under the pointer on any .lp-lit card inside the host. */
function spotlight(e: React.PointerEvent<HTMLElement>) {
  const card = (e.target as HTMLElement).closest<HTMLElement>(".lp-lit");
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${e.clientX - r.left}px`);
  card.style.setProperty("--my", `${e.clientY - r.top}px`);
}

function Facts() {
  const facts: [number, string, string][] = [
    [14, "days", "of warmup before any inbox sends a campaign email"],
    [40, "a day", "the most any single inbox will ever send"],
    [3, "records", "SPF, DKIM and DMARC set up on every sending domain"],
    [0, "cold emails", "sent from your main domain, ever"],
  ];
  return (
    <section className="lp-facts" aria-label="How Aperture protects your sending">
      <div className="wrap">
        <div className="lp-facts-in">
          {facts.map(([n, unit, text], i) => (
            <div className="lp-fact" key={text} data-reveal style={rd(i)}>
              <div className="lp-fact-n">
                <Count to={n} />
                <span>{unit}</span>
              </div>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const STEPS = [
  { t: "Enter your domain", p: "We read your site to learn what you sell, who it is for and how you talk about it." },
  { t: "Meet your audience", p: "The industries, job titles and regions most likely to buy, each one you can edit." },
  { t: "See a free preview", p: "Your market size, real sample prospects and a written sequence. Nothing is sent and no card is needed." },
  { t: "Pick a daily volume", p: "From 100 to 5,000 emails a day. We size the inboxes and domains so none sends more than 40." },
  { t: "Domains and inboxes", p: "Lookalike sending domains that forward to your site, each with inboxes and DNS records set up." },
  { t: "Warm up and launch", p: "Inboxes warm up for 14 days, then your campaign starts gently and ramps to full volume." },
];

function StepMock({ i, domain }: { i: number; domain: string }) {
  const base = domain.split(".")[0] || "northwind";
  const tld = domain.slice(base.length) || ".io";
  if (i === 0)
    return (
      <div className="m-card">
        <div className="m-url">
          <Icon id="globe" />
          <span className="mono">{domain}</span>
          <i className="m-caret" />
        </div>
        <div className="m-scan">
          {["/", "/pricing", "/customers", "/about"].map((p, k) => (
            <div className="m-scan-row" key={p} style={{ ["--k" as string]: k }}>
              <span className="mono">
                {domain}
                {p === "/" ? "" : p}
              </span>
              <b>
                <Icon id="check" />
                Read
              </b>
            </div>
          ))}
        </div>
      </div>
    );
  if (i === 1)
    return (
      <div className="m-card m-aud">
        {[
          ["Job titles", ["Head of Growth", "VP Sales", "Founder"]],
          ["Industries", ["B2B software", "Fintech"]],
          ["Regions", ["United States", "United Kingdom"]],
        ].map(([h, chips], g) => (
          <div key={h as string}>
            <small>{h as string}</small>
            <div className="m-chips">
              {(chips as string[]).map((c, k) => (
                <span key={c} style={{ ["--k" as string]: g * 3 + k }}>
                  {c}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  if (i === 2)
    return (
      <div className="m-card m-prev">
        <div>
          <small>Companies in your market</small>
          <b className="num">12,480</b>
          <span className="m-note">Example numbers</span>
        </div>
        <div className="m-mail">
          <small>Email 1 of 3</small>
          <p>
            Quick idea for <span className="m-tk">company</span>
          </p>
          <i style={{ width: "92%" }} />
          <i style={{ width: "78%" }} />
          <i style={{ width: "64%" }} />
        </div>
      </div>
    );
  if (i === 3)
    return (
      <div className="m-card m-vol">
        <div className="m-vol-top">
          <span>Emails a day</span>
          <b className="num">1,000</b>
        </div>
        <div className="m-track">
          <i />
        </div>
        <div className="m-vol-out">
          <div>
            <b className="num">25</b>
            <small>inboxes</small>
          </div>
          <div>
            <b className="num">9</b>
            <small>domains</small>
          </div>
          <div>
            <b className="num">40</b>
            <small>max per inbox</small>
          </div>
        </div>
      </div>
    );
  if (i === 4)
    return (
      <div className="m-card m-doms">
        {[`get${base}.com`, `try${base}${tld}`, `${base}hq.com`].map((d, k) => (
          <div className="m-dom" key={d} style={{ ["--k" as string]: k }}>
            <span className="mono">{d}</span>
            <span className="m-fw">
              <Icon id="arr" />
              {domain}
            </span>
            <span className="m-ok">
              <Icon id="check" />
              DNS
            </span>
          </div>
        ))}
      </div>
    );
  return (
    <div className="m-card m-warm">
      <div className="m-bars" aria-hidden="true">
        {Array.from({ length: 14 }, (_, k) => (
          <i key={k} style={{ ["--k" as string]: k, height: `${18 + (k / 13) ** 1.3 * 82}%` }} />
        ))}
      </div>
      <div className="m-warm-lbl">
        <span>Day 1</span>
        <span className="m-ready">
          <span className="pulse" />
          Day 14 · ready to send
        </span>
      </div>
    </div>
  );
}

function HowItWorks({ domain }: { domain: string }) {
  const [active, setActive] = useState(0);
  const cards = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    cards.current.forEach((c) => c && io.observe(c));
    return () => io.disconnect();
  }, []);
  const go = (i: number) => cards.current[i]?.scrollIntoView({ behavior: "smooth", block: "center" });

  return (
    <section className="sec" id="how">
      <div className="wrap lp-how">
        <div className="lp-how-l">
          <div className="lp-how-stick">
            <div className="eyebrow" data-reveal>
              How it works
            </div>
            <h2 className="h2" data-reveal style={rd(1)}>
              From domain to first reply <span className="dim">in one sitting.</span>
            </h2>
            <p className="sec-lede" data-reveal style={rd(2)}>
              Six steps, in this order. You see your audience and a written sequence for free, and you only pay once you are happy with the plan.
            </p>
            <ol className="lp-prog" data-reveal style={{ ...rd(3), ["--p" as string]: active / (STEPS.length - 1) }}>
              {STEPS.map((s, i) => (
                <li key={s.t} data-state={i < active ? "done" : i === active ? "on" : undefined}>
                  <button type="button" onClick={() => go(i)}>
                    <span className="lp-prog-n">{i < active ? <Icon id="check" /> : i + 1}</span>
                    {s.t}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="lp-how-r">
          {STEPS.map((s, i) => (
            <article
              key={s.t}
              className="lp-step"
              data-i={i}
              data-on={i === active ? "1" : undefined}
              ref={(n) => {
                cards.current[i] = n;
              }}
              data-reveal
            >
              <div className="lp-step-h">
                <span className="lp-step-n mono">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{s.t}</h3>
                  <p>{s.p}</p>
                </div>
              </div>
              <StepMock i={i} domain={domain} />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

const REPLIES = [
  { n: "Maya Reid", m: "This is timely. Are you free Thursday at 3?", c: "Hot", k: "g" },
  { n: "Daniel Kerr", m: "What does onboarding look like for a team of 12?", c: "Question", k: "b" },
  { n: "Chris Bell", m: "Not this quarter. Try me again in January.", c: "Not now · 8 Jan", k: "y" },
  { n: "Priya Shah", m: "Tom owns this on our side, copying him in.", c: "Referral", k: "v" },
  { n: "Sofia Lund", m: "Out of office until the 14th, back after that.", c: "Away · 14 Oct", k: "y" },
  { n: "Owen Hart", m: "Please take me off your list.", c: "Stop · blocked", k: "r" },
];

function Product() {
  return (
    <section className="sec" id="product">
      <div className="lp-orb lp-orb-a" aria-hidden="true">
        <i data-parallax="0.18" />
      </div>
      <div className="wrap">
        <div className="sec-head">
          <div>
            <div className="eyebrow" data-reveal>
              After launch
            </div>
            <h2 className="h2" data-reveal style={rd(1)}>
              The busywork after the send <span className="dim">is ours.</span>
            </h2>
          </div>
          <p className="sec-lede" data-reveal style={rd(2)}>
            Replies get sorted with an answer drafted, new leads wait for your OK each week, and every opt out is honoured the moment it arrives.
          </p>
        </div>

        <div className="lp-bento" onPointerMove={spotlight}>
          <article className="lp-cell lp-lit lp-c-inbox" data-reveal>
            <div className="lp-cell-h">
              <span className="lp-ic">
                <Icon id="inbox" />
              </span>
              <h3>Every reply sorted, with a draft waiting</h3>
              <p>Interested, question, not now, referral or stop. Leads get a reply written for you, and a not now gets a follow up date.</p>
            </div>
            <div className="lp-inbox">
              <div className="lp-inbox-bar">
                <span data-on="1">
                  All <b>6</b>
                </span>
                <span>
                  Leads <b>3</b>
                </span>
                <span>
                  Later <b>2</b>
                </span>
                <span>
                  Stopped <b>1</b>
                </span>
              </div>
              {REPLIES.map((r, i) => (
                <div className="lp-rep" key={r.n} data-sel={i === 0 ? "1" : undefined} style={{ ["--k" as string]: i }}>
                  <span className="lp-av">
                    {r.n
                      .split(" ")
                      .map((x) => x[0])
                      .join("")}
                  </span>
                  <div className="lp-rep-t">
                    <b>{r.n}</b>
                    <p>{r.m}</p>
                  </div>
                  <span className={`chip-s ${r.k}`}>{r.c}</span>
                </div>
              ))}
              <div className="lp-draft">
                <small>
                  <Icon id="sparkle" />
                  Draft for Maya
                </small>
                <blockquote>This is timely. Are you free Thursday at 3?</blockquote>
                <p>Thursday at 3 works. I have sent an invite to this address, and I will bring the numbers we talked about.</p>
                <span className="lp-draft-b">Review and send</span>
              </div>
            </div>
          </article>

          <article className="lp-cell lp-lit lp-c-week" data-reveal style={rd(1)}>
            <div className="lp-cell-h">
              <span className="lp-ic">
                <Icon id="users" />
              </span>
              <h3>Leads you approve each week</h3>
              <p>A fresh batch lands every week. Nothing goes out until you approve it, in the app or from Slack.</p>
            </div>
            <div className="lp-week">
              <div className="lp-week-top">
                <span>Next week</span>
                <b className="num">212 leads</b>
              </div>
              <div className="lp-week-bar">
                <i />
              </div>
              <div className="lp-week-row">
                <span className="lp-week-ok">
                  <Icon id="check" />
                  Approve week
                </span>
                <small>or in one click from Slack</small>
              </div>
            </div>
          </article>

          <article className="lp-cell lp-lit lp-c-block" data-reveal style={rd(2)}>
            <div className="lp-cell-h">
              <span className="lp-ic">
                <Icon id="ban" />
              </span>
              <h3>Opt outs honoured instantly</h3>
              <p>Unsubscribes and bounces go straight to your blocklist, and anything still queued for them stops.</p>
            </div>
            <div className="lp-block">
              {[
                ["j.moss@", "Unsubscribed"],
                ["team@", "Bounced"],
              ].map(([a, why]) => (
                <div key={a}>
                  <span className="mono">{a}…</span>
                  <em>{why}</em>
                  <b>Blocked</b>
                </div>
              ))}
            </div>
          </article>

          <article className="lp-cell lp-lit lp-c-slack" data-reveal>
            <div className="lp-cell-h">
              <span className="lp-ic">
                <Icon id="pulse" />
              </span>
              <h3>Reports in Slack</h3>
              <p>Daily, weekly and monthly numbers posted to your channel, so nobody has to log in to know how it is going.</p>
            </div>
            <div className="lp-slack">
              <span className="lp-slack-av">
                <Mark />
              </span>
              <div>
                <div className="lp-slack-who">
                  <b>Aperture</b>
                  <small>Monday 9:00</small>
                </div>
                <b className="lp-slack-t">Weekly outreach report</b>
                <div className="lp-slack-kv">
                  {[
                    ["Sent", "2,140"],
                    ["Replies", "41"],
                    ["New leads", "212"],
                    ["Meetings", "6"],
                  ].map(([k, v]) => (
                    <span key={k}>
                      {k} <b className="num">{v}</b>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </article>

          <article className="lp-cell lp-lit lp-c-csv" data-reveal style={rd(1)}>
            <div className="lp-cell-h">
              <span className="lp-ic">
                <Icon id="upload" />
              </span>
              <h3>Bring your own list</h3>
              <p>Upload a CSV, use the audience we find, or mix both. Every address is checked before it gets an email.</p>
            </div>
            <div className="lp-csv">
              <span className="mono">leads.csv</span>
              <span>
                <b className="num">1,204</b> checked
              </span>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

const POINTS: { ic: IconId; h: string; p: (base: string) => React.ReactNode }[] = [
  {
    ic: "shield",
    h: "Lookalike sending domains",
    p: (base) => (
      <>
        Domains like <span className="mono">get{base}.io</span> forward visitors to your real site, so your own reputation stays clean.
      </>
    ),
  },
  { ic: "key", h: "SPF, DKIM and DMARC on every domain", p: () => "Authentication records are part of the setup, so each domain is ready to send when its inboxes are." },
  { ic: "flame", h: "Warmup that adjusts itself", p: () => "14 days of warmup, then 10 to 15 sends a day climbing to 40. If bounces or spam signals move, the ramp slows down." },
  { ic: "rotate", h: "Rotation across every inbox", p: () => "Sends spread evenly across your inboxes, so no single one carries the load." },
];

function Deliverability({ domain }: { domain: string }) {
  const base = domain.split(".")[0];
  const orb = [`get${base}.com`, `try${base}${domain.slice(base.length)}`, `${base}hq.com`, `use${base}.com`, `meet${base}.co`];
  return (
    <section className="sec" id="deliverability">
      <div className="lp-orb lp-orb-b" aria-hidden="true">
        <i data-parallax="-0.14" />
      </div>
      <div className="wrap deliv lp-deliv">
        <div>
          <div className="eyebrow" data-reveal>
            Deliverability
          </div>
          <h2 className="h2" data-reveal style={rd(1)}>
            Your main domain never sends <span className="dim">a cold email.</span>
          </h2>
          <div className="lp-points" onPointerMove={spotlight}>
            {POINTS.map((x, i) => (
              <div className="lp-point lp-lit" key={x.h} data-reveal style={rd(i + 2)}>
                <span className="lp-ic">
                  <Icon id={x.ic} />
                </span>
                <div>
                  <h3>{x.h}</h3>
                  <p>{x.p(base)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="lp-par-host">
          <div data-parallax="0.05">
            <div className="orbit-card glass" data-reveal style={rd(2)}>
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
                    {[
                      ["TXT", "@", "v=spf1 include:… ~all", "SPF"],
                      ["TXT", "s1._domainkey", "v=DKIM1; k=rsa; p=MIIBIjANBgkqh…", "DKIM"],
                      ["TXT", "_dmarc", "v=DMARC1; p=quarantine; rua=mailto:…", "DMARC"],
                      ["MX", "@", "mail exchanger for replies", "MX"],
                    ].map((r) => (
                      <tr key={r[3]}>
                        <td>{r[0]}</td>
                        <td>{r[1]}</td>
                        <td>{r[2]}</td>
                        <td className="ok">{r[3]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
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

const INCLUDED = [
  "Sending domains that forward to your site",
  "SPF, DKIM and DMARC on every domain",
  "14 day warmup before the first send",
  "Replies sorted with drafts written",
  "Weekly lead batches you approve",
  "Cancel any time from the billing portal",
];

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
            <div className="eyebrow" data-reveal>
              Pricing
            </div>
            <h2 className="h2" data-reveal style={rd(1)}>
              Priced by what you send <span className="dim">each day.</span>
            </h2>
          </div>
          <p className="sec-lede" data-reveal style={rd(2)}>
            Move the slider. We work out the inboxes and domains you need so every inbox stays under 40 sends a day.
          </p>
        </div>
        <div className="price-card glass lp-price" data-reveal>
          <div className="pc-l">
            <label htmlFor="lpRange" className="lp-price-lbl">
              How many emails a day?
            </label>
            <div className="vol-num">
              <output className="num" htmlFor="lpRange">
                {n0(v)}
              </output>
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
            <Link className="btn btn-primary" style={{ width: "100%", marginTop: 22 }} href="/onboarding">
              Start with this setup
              <Icon id="arr" className="arr" />
            </Link>
            <p className="lp-price-note">The preview is free. You pay only when you approve the plan.</p>
          </div>
        </div>
        <div className="lp-incl" data-reveal>
          <span className="lp-incl-h">Included in every plan</span>
          <ul>
            {INCLUDED.map((x, i) => (
              <li key={x} data-reveal style={rd(i, 0.05)}>
                <Icon id="check" />
                {x}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

const FAQS = [
  ["Why not send from my own domain?", "Cold email carries reputation risk. If a campaign trips a spam filter, you want that to happen on a spare domain, not the one your customers and invoices depend on."],
  ["How long does warmup take?", "New inboxes warm up for 14 days before the first campaign email, and you can choose 21 or 28. Your campaign then starts at 10 to 15 emails per inbox a day and reaches full volume over the next two weeks."],
  ["What is in the free preview?", "An analysis of your business, the size of your market, sample prospects, a three step email sequence written for it and a recommended plan. No email is sent and no card is needed."],
  ["What happens after I pay?", "We register your sending domains, create the inboxes, publish the DNS records and start warmup. You can follow every domain and inbox in your account, and the campaign starts when warmup ends."],
  ["What happens when someone replies?", "Each reply is sorted as interested, question, not now, referral or stop. Leads get a drafted answer for you to send, a not now gets a follow up date, and a stop goes straight to your blocklist."],
  ["Who owns the sending domains?", "Your organization. The domains you choose are listed in your account with their status, and they forward visitors to your main site."],
  ["Can I bring my own lead list?", "Yes. Upload a CSV on the launch screen, use the audience we find, or mix both. We check every address before it gets an email."],
  ["Can I cancel?", "Yes. Manage or cancel your subscription from the billing portal in your account. It stays active until the end of the period you paid for."],
];

function Faq() {
  return (
    <section className="sec" id="faq">
      <div className="wrap faq lp-faq">
        <div>
          <div className="lp-faq-stick">
            <div className="eyebrow" data-reveal>
              FAQ
            </div>
            <h2 className="h2" data-reveal style={rd(1)}>
              Good questions.
            </h2>
            <div className="lp-help" data-reveal style={rd(2)}>
              <b>See it on your own site first</b>
              <p>The preview reads your site and writes your first sequence. It is free and nothing is sent.</p>
              <Link className="btn btn-glass btn-sm" href="/onboarding">
                Start the free preview
                <Icon id="arr" className="arr" />
              </Link>
            </div>
          </div>
        </div>
        <div className="lp-qas">
          {FAQS.map(([q, a], i) => (
            <details className="qa" key={q} open={i === 0} data-reveal style={rd(i, 0.04)}>
              <summary>
                {q}
                <i>
                  <Icon id="plus" />
                </i>
              </summary>
              <div className="lp-qa-a">
                <p>{a}</p>
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Landing() {
  const [domain, setDomain] = useState("northwind.io");
  const root = useRef<HTMLDivElement>(null);
  useLandingMotion(root);

  return (
    <div id="landing" ref={root}>
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

        <Facts />
        <HowItWorks domain={domain} />
        <Product />
        <Deliverability domain={domain} />
        <Pricing />
        <Faq />

        <div className="wrap">
          <div className="cta glass lp-cta" data-reveal>
            <div className="lp-cta-bg" aria-hidden="true">
              <i className="lp-cta-o1" data-parallax="0.12" />
              <i className="lp-cta-o2" data-parallax="-0.1" />
            </div>
            <div className="eyebrow">Ready when you are</div>
            <h2 className="h2" style={{ marginTop: 14 }}>
              Your first campaign is one domain away.
            </h2>
            <DomainSearch id="ctaDomain" cta onDomain={setDomain} />
            <ul className="lp-cta-perks">
              <li>
                <Icon id="check" />
                Free preview
              </li>
              <li>
                <Icon id="check" />
                No card needed
              </li>
              <li>
                <Icon id="check" />
                Nothing is sent until you launch
              </li>
            </ul>
          </div>
        </div>
      </main>

      <footer className="site-foot lp-foot">
        <div className="wrap">
          <div className="lp-foot-top">
            <div className="lp-foot-brand">
              <a className="logo" href="#top">
                <Mark />
                Aperture
              </a>
              <p>Cold email infrastructure, set up by an agent. Your main domain never sends a cold email.</p>
            </div>
            <nav aria-label="Product">
              <b>Product</b>
              <a href="#how">How it works</a>
              <a href="#product">After launch</a>
              <a href="#deliverability">Deliverability</a>
              <a href="#pricing">Pricing</a>
            </nav>
            <nav aria-label="Get started">
              <b>Get started</b>
              <Link href="/onboarding">Free preview</Link>
              <Link href="/signin">Sign in</Link>
              <a href="#faq">FAQ</a>
            </nav>
          </div>
          <div className="lp-foot-bot">
            <span>© {new Date().getFullYear()} Aperture</span>
            <a href="#top" className="lp-top">
              Back to top
              <Icon id="arr" />
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
