import { resolveNs, resolveSoa, resolveMx, resolveTxt } from "node:dns/promises";

const MAX_BYTES = 600_000;

export async function fetchSiteText(domain: string, maxChars = 6000): Promise<{ title: string | null; description: string | null; text: string }> {
  for (const url of [`https://${domain}`, `https://www.${domain}`, `http://${domain}`]) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; ApertureBot/1.0)" } });
      clearTimeout(timer);
      if (!res.ok) continue;
      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("html")) continue;
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
      return { title: decodeEntities(title), description: decodeEntities(description), text };
    } catch {
      continue;
    }
  }
  return { title: null, description: null, text: "" };
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
