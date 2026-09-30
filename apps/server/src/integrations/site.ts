import { lookup, resolveNs, resolveSoa, resolveMx, resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 600_000;

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80")) return false;
    if (x.startsWith("::ffff:")) return isPublicAddress(x.slice(7));
    return true;
  }
  return false;
}

async function hostIsPublic(host: string): Promise<boolean> {
  if (isIP(host)) return isPublicAddress(host);
  const addrs = await lookup(host, { all: true }).catch(() => []);
  return addrs.length > 0 && addrs.every((a) => isPublicAddress(a.address));
}

async function safeFetch(start: string, signal: AbortSignal): Promise<Response | null> {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || !(await hostIsPublic(u.hostname))) return null;
    const res = await fetch(url, { signal, redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (compatible; ApertureBot/1.0)" } });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      continue;
    }
    return res;
  }
  return null;
}

interface Page {
  url: string;
  title: string | null;
  description: string | null;
  text: string;
  body: string;
  lang: string | null;
  logos: string[];
}

function metaContent(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/\b(?:name|property)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (key !== name) continue;
    const content = tag.match(/\bcontent=["']([^"']{1,500})["']/i)?.[1]?.trim();
    if (content) return content;
  }
  return null;
}

function jsonLdText(html: string): string {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 5 || out.join(" ").length > 800 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "string" && ["name", "description", "slogan", "alternateName"].includes(k) && x.length > 2 && !/^https?:/.test(x)) out.push(x.trim());
      else if (typeof x === "object") walk(x, depth + 1);
    }
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1]), 0);
    } catch {
      /* ignore invalid structured data */
    }
  }
  return [...new Set(out)].join(". ").slice(0, 800);
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "...", pound: "£", euro: "€", copy: "(c)" };

function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/(?:[\u2012-\u2015\u25b6-\u25be\u2022\u00b7|/\\>»›→-]\s*){2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function bodyText(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|template|iframe|select|nav|footer)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?noscript[^>]*>/gi, " ");
  const main = cleaned.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (main) {
    const t = htmlToText(main);
    if (t.length > 300) return t;
  }
  return htmlToText(cleaned);
}

const CUSTOMER_HEADING = /(trusted by|our (?:clients|customers)|used by|loved by|companies (?:that|who) (?:use|trust)|brands (?:that|who) (?:use|trust)|join(?:ing)? [\w\s,]{0,30}(?:teams|companies|brands))/i;
const GENERIC_ALT = /^(logo|image|icon|img|photo|picture|client|customer|partner|brand|\d+)$/i;

export function logosFrom(html: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(CUSTOMER_HEADING.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.size < 20) {
    const block = html.slice(m.index, m.index + 5000);
    for (const img of block.matchAll(/<img[^>]*\balt=["']([^"']{2,60})["'][^>]*>/gi)) {
      const alt = img[1].replace(/\b(logo|logotype|icon)\b/gi, "").replace(/\s+/g, " ").trim();
      if (alt.length >= 2 && alt.length <= 40 && !GENERIC_ALT.test(alt)) out.add(decodeEntities(alt)!);
      if (out.size >= 20) break;
    }
  }
  return [...out];
}

async function readPage(url: string, maxChars: number, timeoutMs: number): Promise<Page | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await safeFetch(url, controller.signal);
    if (!res || !res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const html = (await res.text()).slice(0, MAX_BYTES);
    const title = decodeEntities(html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.trim() ?? null);
    const metaDescription = decodeEntities(metaContent(html, "description") ?? metaContent(html, "og:description") ?? metaContent(html, "twitter:description"));
    const description = metaDescription && metaDescription.split(/\s+/).length >= 4 ? metaDescription : null;
    const structured = jsonLdText(html);
    const body = bodyText(html);
    const text = [description, structured, body].filter(Boolean).join(" . ").slice(0, maxChars);
    const lang = html.match(/<html[^>]*\blang=["']?([a-zA-Z]{2})/i)?.[1]?.toLowerCase() ?? null;
    return { url: res.url || url, title, description, text, body, lang, logos: logosFrom(html) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSiteText(domain: string, maxChars = 6000): Promise<{ title: string | null; description: string | null; text: string }> {
  for (const url of [`https://${domain}`, `https://www.${domain}`, `http://${domain}`]) {
    const page = await readPage(url, maxChars, 10_000);
    if (page) return { title: page.title, description: page.description, text: page.text };
  }
  return { title: null, description: null, text: "" };
}

const SUBPAGES = ["/about", "/services", "/products", "/solutions", "/pricing", "/industries", "/customers", "/case-studies", "/testimonials", "/contact"];

export interface SitePage {
  path: string;
  title: string | null;
  text: string;
  logos?: string[];
}

export interface SiteHome {
  title: string | null;
  description: string | null;
  lang?: string | null;
}

const USEFUL_PATH = /about|compan|pricing|price|plans|product|platform|feature|solution|service|industr|customer|client|case|stor(y|ies)|use-?case|who-we|what-we|testimonial|partner/i;
const SKIP_PATH = /terms|privacy|cookie|legal|polic|gdpr|login|log-in|signin|sign-in|signup|sign-up|register|careers?|jobs|press|blog\/|news\//i;

async function sitemapPaths(base: string, host: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await safeFetch(`${base}/sitemap.xml`, controller.signal);
    if (!res || !res.ok) return [];
    const xml = (await res.text()).slice(0, 300_000);
    const paths = new Set<string>();
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      try {
        const u = new URL(m[1]);
        if (u.hostname.replace(/^www\./, "") !== host || u.pathname === "/" || /\.(xml|pdf|jpg|png)$/i.test(u.pathname)) continue;
        if (USEFUL_PATH.test(u.pathname) && !SKIP_PATH.test(u.pathname) && u.pathname.split("/").filter(Boolean).length <= 2) paths.add(u.pathname.replace(/\/$/, ""));
      } catch {
        /* skip bad urls */
      }
    }
    return [...paths].sort((a, b) => a.length - b.length).slice(0, 10);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Progress callbacks. They only report; they never change what is fetched. */
export interface SiteHooks {
  /** A page request finished (kept or not). */
  onRead?: (path: string) => void;
  /** A page was kept for the analysis. */
  onPage?: (page: SitePage) => void;
}

async function readSitePages(domain: string, hooks: SiteHooks = {}, perPage = 4000, maxPages = 10): Promise<{ home: SiteHome | null; pages: SitePage[] }> {
  let base: string | null = null;
  let home: Page | null = null;
  for (const origin of [`https://${domain}`, `https://www.${domain}`, `http://${domain}`]) {
    home = await readPage(origin, perPage, 10_000);
    if (home) {
      base = new URL(home.url).origin;
      break;
    }
  }
  if (!home || !base) return { home: null, pages: [] };
  const host = new URL(base).hostname.replace(/^www\./, "");
  const seen = new Set<string>();
  const fingerprint = (body: string) => body.slice(0, 500);
  const pages: SitePage[] = [];
  hooks.onRead?.("/");
  if (home.text) {
    pages.push({ path: "/", title: home.title, text: home.text, logos: home.logos });
    hooks.onPage?.(pages[0]);
    seen.add(fingerprint(home.body));
  }
  const fromSitemap = await sitemapPaths(base, host);
  const candidates = [...new Set([...SUBPAGES, ...fromSitemap])];
  const extra = await Promise.all(
    candidates.map((path) =>
      readPage(`${base}${path}`, perPage, 6_000).then((r) => {
        hooks.onRead?.(path);
        if (!r || r.body.length < 200) return null;
        const landed = new URL(r.url).pathname.replace(/\/$/, "") || "/";
        if (landed === "/") return null;
        return { path: landed, title: r.title, text: r.text, body: r.body, logos: r.logos };
      }),
    ),
  );
  for (const p of extra) {
    if (!p || pages.length >= maxPages || pages.some((x) => x.path === p.path)) continue;
    const key = fingerprint(p.body);
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push({ path: p.path, title: p.title, text: p.text, logos: p.logos });
    hooks.onPage?.(pages[pages.length - 1]);
  }
  return { home: { title: home.title, description: home.description, lang: home.lang }, pages };
}

function decodeEntities(s: string | null): string | null {
  if (!s) return s;
  return s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
}

export interface MailSetup {
  hasMx: boolean;
  hasSpf: boolean;
}

export async function mailSetup(domain: string): Promise<MailSetup> {
  const [mx, txt] = await Promise.all([resolveMx(domain).catch(() => []), resolveTxt(domain).catch(() => [])]);
  return { hasMx: mx.length > 0, hasSpf: txt.some((r) => r.join("").toLowerCase().startsWith("v=spf1")) };
}

export async function isRegistered(domain: string): Promise<boolean | null> {
  try {
    const ns = await resolveNs(domain);
    return ns.length > 0;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND") return false;
    if (code === "ENODATA") {
      try {
        await resolveSoa(domain);
        return true;
      } catch {
        return false;
      }
    }
    return null;
  }
}

type SiteReader = (domain: string, hooks?: SiteHooks) => ReturnType<typeof readSitePages>;
let siteReader: SiteReader = (d, h) => readSitePages(d, h);

export function fetchSitePages(domain: string, hooks?: SiteHooks) {
  return siteReader(domain, hooks);
}

export function setSiteReader(r: SiteReader | null): void {
  siteReader = r ?? ((d, h) => readSitePages(d, h));
}
