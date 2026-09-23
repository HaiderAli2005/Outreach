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
}

async function readPage(url: string, maxChars: number, timeoutMs: number): Promise<Page | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await safeFetch(url, controller.signal);
    if (!res || !res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const html = (await res.text()).slice(0, MAX_BYTES);
    const title = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.trim() ?? null;
    const description =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,400})["']/i)?.[1] ??
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,400})["']/i)?.[1] ??
      null;
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars);
    return { url: res.url || url, title: decodeEntities(title), description: decodeEntities(description), text };
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

const SUBPAGES = ["/about", "/services", "/products", "/solutions", "/pricing", "/industries", "/customers", "/case-studies", "/contact"];

export interface SitePage {
  path: string;
  title: string | null;
  text: string;
}

async function readSitePages(domain: string, perPage = 2500, maxPages = 6): Promise<{ home: { title: string | null; description: string | null } | null; pages: SitePage[] }> {
  let base: string | null = null;
  let home: Page | null = null;
  for (const origin of [`https://${domain}`, `https://www.${domain}`, `http://${domain}`]) {
    home = await readPage(origin, perPage, 10_000);
    if (home) {
      base = origin;
      break;
    }
  }
  if (!home || !base) return { home: null, pages: [] };
  const pages: SitePage[] = home.text ? [{ path: "/", title: home.title, text: home.text }] : [];
  const extra = await Promise.all(SUBPAGES.map((p) => readPage(`${base}${p}`, perPage, 6_000).then((r) => (r && r.text.length > 200 ? { path: p, title: r.title, text: r.text } : null))));
  for (const p of extra) if (p && pages.length < maxPages && !pages.some((x) => x.text === p.text)) pages.push(p);
  return { home: { title: home.title, description: home.description }, pages };
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

type SiteReader = (domain: string) => ReturnType<typeof readSitePages>;
let siteReader: SiteReader = (d) => readSitePages(d);

export function fetchSitePages(domain: string) {
  return siteReader(domain);
}

export function setSiteReader(r: SiteReader | null): void {
  siteReader = r ?? ((d) => readSitePages(d));
}
