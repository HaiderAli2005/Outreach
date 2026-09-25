import type { Contact, OrgSettings } from "@prisma/client";
import { getAi } from "../integrations/ai.js";
import { brandProfileOf } from "./settings.js";

export interface WrittenSequence {
  subject: string;
  body: string;
  followup2: string;
  followup3: string;
  status: "done" | "fallback" | "failed";
}

const BANNED = [
  /\bI hope this (email )?finds you well\b[.,!]?/gi,
  /\bI wanted to reach out\b/gi,
  /\bjust following up\b/gi,
  /\b(seamless|cutting-edge|revolutionary|game-changing|leverage|synergy)\b/gi,
  /\b(100% free|guaranteed|act now|limited time offer)\b/gi,
];

export function lintEmail(text: string, maxWords = 120): string {
  let s = String(text ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[—–]/g, ",")
    .replace(/\s+-\s+/g, ", ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\*\*|__|#+\s/g, "");
  for (const re of BANNED) s = s.replace(re, "");
  s = s
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ ,/g, ",")
    .trim();
  const words = s.split(/\s+/);
  if (words.length > maxWords) s = words.slice(0, maxWords).join(" ").replace(/[,;:]?$/, ".");
  return s;
}

function greeting(contact: Pick<Contact, "firstName">, language: string): string {
  const name = contact.firstName?.trim();
  if (language === "sv") return name ? `Hej ${name},` : "Hej,";
  return name ? `Hi ${name},` : "Hi,";
}

export function fallbackSequence(contact: Pick<Contact, "firstName" | "company">, settings: OrgSettings): Omit<WrittenSequence, "status"> {
  const lang = settings.language;
  const brand = brandProfileOf(settings);
  const offer = settings.valueProp || brand.valueProp || brand.summary || "what we do";
  const company = contact.company || (lang === "sv" ? "er" : "your team");
  if (lang === "sv") {
    return {
      subject: `Fråga till ${contact.company ?? "er"}`.slice(0, 80),
      body: `${greeting(contact, lang)}\n\nJag hör av mig eftersom vi hjälper företag som ${company} med ${offer.charAt(0).toLowerCase()}${offer.slice(1)}.\n\nVore det intressant med ett kort samtal för att se om det passar er?`,
      followup2: `${greeting(contact, lang)}\n\nEn kort uppföljning på mitt förra mejl. Är det här något som kan vara värt en titt för ${company}?`,
      followup3: `${greeting(contact, lang)}\n\nJag vill inte fylla din inkorg, så det här blir mitt sista mejl. Hör gärna av dig om det blir aktuellt längre fram.`,
    };
  }
  return {
    subject: `Question for ${contact.company ?? "you"}`.slice(0, 80),
    body: `${greeting(contact, lang)}\n\nI'm reaching out because we help companies like ${company} with ${offer.charAt(0).toLowerCase()}${offer.slice(1)}.\n\nWould a short call to see if it fits be useful?`,
    followup2: `${greeting(contact, lang)}\n\nA quick follow-up on my last note. Is this worth a short look for ${company}?`,
    followup3: `${greeting(contact, lang)}\n\nI don't want to crowd your inbox, so this is my last note. If the timing is better later on, I'd be glad to hear from you.`,
  };
}

export async function personalizeContact(
  contact: Contact,
  settings: OrgSettings,
  opts: { marketBrief?: string | null; companyDescription?: string | null; language?: string } = {},
): Promise<WrittenSequence> {
  const fb = fallbackSequence(contact, settings);
  const ai = getAi();
  if (!ai) return { ...fb, status: "fallback" };
  const brand = brandProfileOf(settings);
  const language = opts.language || settings.language;
  const facts = [
    contact.fullName && `Name: ${contact.fullName}`,
    contact.firstName && `First name: ${contact.firstName}`,
    contact.title && `Title: ${contact.title}`,
    contact.company && `Company: ${contact.company}`,
    contact.industry && `Industry: ${contact.industry}`,
    contact.website && `Website: ${contact.website}`,
    contact.location && `Location: ${contact.location}`,
    opts.companyDescription && `About the company: ${opts.companyDescription.slice(0, 400)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `Write the FIRST cold email and two short follow-ups for one prospect, on behalf of ${settings.senderCompany || brand.company || "our company"}.

WHAT WE SELL (truth source; never copy its wording, never invent anything beyond it):
${(settings.valueProp || brand.valueProp || brand.summary || "(not provided)").slice(0, 600)}
${opts.marketBrief ? `\nCAMPAIGN ANGLE:\n${opts.marketBrief.slice(0, 600)}\n` : ""}
LANGUAGE: write everything in ${language === "sv" ? "Swedish" : language === "en" ? "English" : language}.

FIRST EMAIL (50 to 90 words):
1. Greeting with their first name if known ("Hi Anna,"), never invent a name.
2. One specific observation about THEIR business drawn only from the facts below.
3. One sentence connecting that to what we sell.
4. A low-pressure question as the call to action. No meeting link, no price.
SUBJECT: 2 to 5 words, lowercase except names, specific to them, no clickbait.
FOLLOWUP 2 (25 to 50 words): a different angle or one pointed question, no repeat of email 1.
FOLLOWUP 3 (20 to 40 words): a short, warm last note that leaves the door open.

RULES: plain text only. No links, bullets, emojis, em-dashes or " - ". No sign-off or name (a signature is appended). Never invent facts, customers, results, statistics or prices. No "I hope this finds you well", "I wanted to reach out", "just following up".

PROSPECT FACTS:
${facts || "(very little known; keep it general and honest)"}

Return STRICT JSON: {"subject":"...","body":"...","followup2":"...","followup3":"..."}`;

  try {
    const out = await ai.generateJSON<{ subject?: string; body?: string; followup2?: string; followup3?: string }>(prompt, { maxTokens: 800, temperature: 0.8 });
    if (!out) return { ...fb, status: "failed" };
    const body = lintEmail(String(out.body ?? ""), 120);
    if (body.length < 30) return { ...fb, status: "fallback" };
    return {
      subject: lintEmail(String(out.subject ?? ""), 10).replace(/[.!]+$/, "").slice(0, 120) || fb.subject,
      body,
      followup2: lintEmail(String(out.followup2 ?? ""), 80) || fb.followup2,
      followup3: lintEmail(String(out.followup3 ?? ""), 70) || fb.followup3,
      status: "done",
    };
  } catch {
    return { ...fb, status: "failed" };
  }
}
