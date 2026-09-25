import type { Catalogue, DomainIdea, Plan, Sender } from "@/lib/types";
import { daysFromNow, n0 } from "@/lib/format";

export const VOLS = [250, 500, 1000, 2500, 5000];

export function planFor(cat: Catalogue, volume: number): Plan {
  const sorted = [...cat.plans].sort((a, b) => a.maxDailyVolume - b.maxDailyVolume);
  return sorted.find((p) => volume <= p.maxDailyVolume) ?? sorted[sorted.length - 1];
}

export const recInboxes = (cat: Catalogue, v: number) => Math.ceil(v / cat.sizing.sendsPerWarmInbox);
export const recDomains = (cat: Catalogue, v: number, perDomain: number) => Math.ceil(recInboxes(cat, v) / Math.max(1, perDomain));

const slug = (s: string) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");

export const initialsOf = (s: Sender) => ((s.first || "").charAt(0) + (s.last || "").charAt(0)).toUpperCase();

export function addressesFor(domain: string, senders: Sender[], count: number, domainIndex: number): { address: string; sender: Sender }[] {
  const list = senders.map((s) => ({ s, f: slug(s.first), l: slug(s.last) })).filter((x) => x.f);
  const people = list.length ? list : [{ s: { first: "hello", last: "" }, f: "hello", l: "" }];
  const n = people.length;
  const out: { address: string; sender: Sender }[] = [];
  for (let j = 0; j < count; j++) {
    const p = domainIndex * 3 + j;
    const { s, f, l } = people[p % n];
    const form = Math.floor(p / n) % 5;
    const local = l ? [f, `${f}.${l[0]}`, `${f}${l[0]}`, `${f[0]}.${l}`, `${f}.${l}`][form] : [f, `hello.${f}`, `${f}.team`, `hi.${f}`, `${f}.mail`][form];
    out.push({ address: `${local}@${domain}`, sender: s });
  }
  return out;
}

export interface Totals {
  picked: { name: string; priceCents: number; inboxes: number }[];
  inboxes: number;
  domainCents: number;
  plan: Plan;
  inboxPriceCents: number | null;
  monthlyCents: number | null;
  dueCents: number | null;
  capacity: number;
}

export function totals(cat: Catalogue, volume: number, picks: string[], per: Record<string, number>, defPer: number, prices: Record<string, number>, fast: boolean): Totals {
  const picked = picks.map((name) => ({ name, priceCents: prices[name] ?? 0, inboxes: per[name] ?? defPer }));
  const inboxes = picked.reduce((a, x) => a + x.inboxes, 0);
  const domainCents = picked.reduce((a, x) => a + x.priceCents, 0);
  const plan = planFor(cat, volume);
  const inboxPriceCents = fast ? cat.sizing.fastStart.inboxPriceCents : cat.sizing.inboxPriceCents;
  const monthlyCents = inboxPriceCents == null ? null : plan.priceMonthlyCents + inboxes * inboxPriceCents;
  return { picked, inboxes, domainCents, plan, inboxPriceCents, monthlyCents, dueCents: monthlyCents == null ? null : monthlyCents + domainCents, capacity: inboxes * cat.sizing.sendsPerWarmInbox };
}

export interface Schedule {
  first: number;
  full: number;
  lo: number;
  hi: number;
}

export function schedule(cat: Catalogue, warmupDays: number, fast: boolean): Schedule {
  const f = cat.sizing.fastStart;
  const c = cat.sizing.campaignStart;
  const first = fast ? f.days : warmupDays;
  return { first, full: first + (fast ? f.rampDays : c.rampDays), lo: fast ? f.lo : c.lo, hi: fast ? f.hi : c.hi };
}

export const dayN = (d: number) => daysFromNow(d - 1);

export function autoPick(ideas: DomainIdea[], need: number): string[] {
  return ideas.filter((x) => x.available !== false).slice(0, need).map((x) => x.name);
}

export function planRows(pool: number | null) {
  return VOLS.map((v) => {
    const ppm = Math.round((v * 22) / 3);
    return { v, ppm, months: pool && ppm ? pool / ppm : null };
  });
}

export function recommendedVolume(pool: number | null): number | null {
  if (!pool) return null;
  let best = VOLS[0];
  for (const r of planRows(pool)) if ((r.months ?? 0) >= 3) best = r.v;
  return best;
}

export const monthsTxt = (m: number) => (m >= 24 ? "24+ months" : m < 1 ? "Under a month" : `${m < 10 ? m.toFixed(1) : Math.round(m)} months`);

export function campaignPerDay(inboxes: number, perInbox: number, k: Schedule, d: number): number {
  const mid = (k.lo + k.hi) / 2;
  if (d < k.first) return 0;
  if (d >= k.full) return inboxes * perInbox;
  return Math.round(inboxes * (mid + ((perInbox - mid) * (d - k.first)) / (k.full - k.first)));
}

export function warmChart(inboxes: number, perInbox: number, target: number, k: Schedule, fast: boolean, width: number): { svg: string; days: number; pl: number; pr: number } {
  const D = k.full + 7;
  const w = Math.max(300, Math.round(width || 640));
  const h = w < 520 ? 220 : 250;
  const pl = 44;
  const pr = 12;
  const pt = 30;
  const pb = 30;
  const ymaxRaw = Math.max(inboxes * perInbox, target) * 1.12 || 100;
  const nice = (x: number) => {
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    const f = x / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  };
  const step = nice(ymaxRaw / 4);
  const ymax = Math.ceil(ymaxRaw / step) * step;
  const X = (d: number) => pl + ((d - 1) / (D - 1)) * (w - pl - pr);
  const Y = (v: number) => pt + (1 - v / ymax) * (h - pt - pb);
  const mid = (k.lo + k.hi) / 2;
  const camp = (d: number) => (d < k.first ? 0 : d >= k.full ? inboxes * perInbox : inboxes * (mid + ((perInbox - mid) * (d - k.first)) / (k.full - k.first)));
  let line = "";
  for (let d = k.first; d <= D; d += 0.5) line += (d === k.first ? "M" : "L") + X(d).toFixed(1) + " " + Y(camp(d)).toFixed(1);
  const area = `${line}L${X(D)} ${Y(0)}L${X(k.first)} ${Y(0)}Z`;
  let grid = "";
  for (let v = 0; v <= ymax; v += step) grid += `<line x1="${pl}" x2="${w - pr}" y1="${Y(v)}" y2="${Y(v)}" class="g"/><text x="${pl - 10}" y="${Y(v) + 4}" text-anchor="end">${n0(v)}</text>`;
  const fx = X(k.first);
  const fy = Y(camp(k.first));
  const ux = X(k.full);
  const uy = Y(inboxes * perInbox);
  const tl = Y(target);
  const bw = X(k.first) - X(1);
  const xt: [number, string][] = [
    [1, "Day 1"],
    [k.first, `Day ${k.first}`],
    [k.full, `Day ${k.full}`],
    ...(w < 520 ? [] : ([[D, dayN(D)]] as [number, string][])),
  ];
  const svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="No campaign emails until day ${k.first}, then ${inboxes * k.lo} to ${inboxes * k.hi} a day, rising to ${inboxes * perInbox} a day by day ${k.full}">
<rect x="${X(1)}" y="${pt}" width="${bw}" height="${h - pt - pb}" class="band"/>
${bw > 60 ? `<text x="${X(1) + bw / 2}" y="${pt + 16}" text-anchor="middle" class="t-band">${fast ? "Connecting" : "Warmup only"}</text>` : ""}
${grid}<path d="${area}" class="area"/><path d="${line}" class="ln"/>
<line x1="${pl}" x2="${w - pr}" y1="${tl}" y2="${tl}" class="tgt"/>
<text x="${w - pr}" y="${target <= inboxes * perInbox ? tl + 16 : tl - 7}" text-anchor="end" class="t-mute">Target ${n0(target)} a day</text>
<circle cx="${fx}" cy="${fy}" r="4.5" class="mk"/><text x="${fx + 10}" y="${fy + 18}" class="t-strong">First emails</text>
<circle cx="${ux}" cy="${uy}" r="4.5" class="mk"/>${uy - tl < 22 && uy > tl ? `<text x="${ux + 10}" y="${uy + 18}" class="t-strong">Full volume</text>` : `<text x="${ux - 10}" y="${uy - 12}" text-anchor="end" class="t-strong">Full volume</text>`}
${xt.map(([d, l], i) => `<text x="${X(d)}" y="${h - 8}" text-anchor="${i === 0 ? "start" : d === D ? "end" : "middle"}">${l}</text>`).join("")}
</svg>`;
  return { svg, days: D, pl, pr };
}
