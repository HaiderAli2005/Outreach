import { isRegistered } from "../../integrations/site.js";
import { TLD_PRICES_CENTS } from "../../config/plans.js";

const FORMS: [string, string][] = [
  ["get", ""], ["try", ""], ["", "hq"], ["use", ""], ["meet", ""], ["", "mail"], ["hello", ""], ["go", ""], ["", "team"],
  ["join", ""], ["with", ""], ["", "app"], ["hey", ""], ["", "labs"], ["the", ""], ["", "hub"], ["team", ""], ["", "now"],
];

export interface DomainIdea {
  name: string;
  prefix: string;
  suffix: string;
  priceCents: number;
  available: boolean | null;
}

type Checker = (domain: string) => Promise<boolean | null>;
let checker: Checker = isRegistered;

export function setDomainChecker(c: Checker | null): void {
  checker = c ?? isRegistered;
}

export function lookalikes(primary: string): Omit<DomainIdea, "available">[] {
  const base = primary.split(".")[0];
  const out: Omit<DomainIdea, "available">[] = [];
  for (const [tld, price] of Object.entries(TLD_PRICES_CENTS)) {
    for (const [pre, suf] of FORMS) {
      const name = `${pre}${base}${suf}${tld}`;
      if (name !== primary) out.push({ name, prefix: pre, suffix: `${suf}${tld}`, priceCents: price });
    }
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export async function domainIdeas(primary: string, offset: number, limit: number): Promise<{ ideas: DomainIdea[]; total: number }> {
  const all = lookalikes(primary);
  const slice = all.slice(offset, offset + limit);
  const ideas = await mapLimit(slice, 8, async (idea) => {
    const registered = await checker(idea.name).catch(() => null);
    return { ...idea, available: registered === null ? null : !registered };
  });
  return { ideas, total: all.length };
}

export async function isDomainTaken(name: string): Promise<boolean> {
  return (await checker(name).catch(() => null)) === true;
}
