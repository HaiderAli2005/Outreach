export const PROMPT_VERSION = "analysis-prompt-v1";

export const ALLOWED_SENIORITIES = ["owner", "founder", "c_suite", "partner", "vp", "head", "director", "manager", "senior", "entry", "intern"] as const;
export const ALLOWED_COMPANY_SIZES = ["1,10", "11,50", "51,200", "201,500", "501,1000", "1001,5000", "5001,"] as const;

export interface PromptPage {
  url: string;
  text: string;
}

export interface Signals {
  country: string | null;
  language: string | null;
  currency: string | null;
  named_customers: string[];
  testimonial_titles: string[];
}

export interface SearchResult {
  fact: string;
  source: string;
}

export const ANALYSIS_SYSTEM = `You are a B2B go-to-market analyst. You read what a company publishes and decide who they
should cold email. Your answer is consumed by software, not by a person, so it must be valid
JSON and every value must be usable in a lead database search.

You never invent facts. You never write marketing language. You always answer in English,
whatever language the source material is in.`;

export function analysisUserPrompt(p: { domain: string; today: string; pages: PromptPage[]; signals: Signals; searchResults: SearchResult[] }): string {
  const d = p.domain;
  return `Analyse this company.

DOMAIN: ${d}
TODAY: ${p.today}

OWN WEBSITE PAGES (highest authority source):
${JSON.stringify(p.pages)}

EXTRACTED SIGNALS (found by code, treat as facts):
${JSON.stringify(p.signals)}

WEB RESULTS (lower authority, may describe other companies):
${JSON.stringify(p.searchResults)}

ALLOWED SENIORITIES (use these exact strings, nothing else):
${JSON.stringify(ALLOWED_SENIORITIES)}

ALLOWED COMPANY SIZES (use these exact strings, nothing else):
${JSON.stringify(ALLOWED_COMPANY_SIZES)}

---

### RULES

1. Evidence order. When the website and a web result disagree about what the company sells,
   its prices or its customers, the website wins. Web results may only add facts, never
   overwrite them.
2. Every entry in \`proof\` and \`differentiators\` carries the URL it came from. No source means
   you must drop the item.
3. Unknown means null. Never estimate a founding year, a headcount, a price or a country.
4. English only in the output. Record the website's language in \`language\`.
5. Never invent customer names. \`named_customers\` comes only from logos or text on the site.
6. No marketing adjectives. Write what the company does, not how good it is.
7. Return valid JSON and nothing else. No markdown fence, no commentary, no trailing text.

### HOW TO CHOOSE THE AUDIENCE

- Produce 3 to 6 audiences. Each one must be different enough to need its own email.
- Rank them with \`priority\`, 1 being the one you would run first.
- The strongest evidence, in order: job titles found in testimonials and case studies,
  the company's named customers, the industries the site says it serves, then your judgement.
- \`titles\` must be job titles a person would put on LinkedIn ("Head of Operations"), never a
  description ("people who manage logistics"). 3 to 8 per audience, no duplicates across audiences.
- \`keywords\`: see HOW TO WRITE KEYWORDS below.
- \`company_sizes\`, \`seniorities\`: only values from the allowed lists above.
- \`countries\`: full country names ("United Kingdom", not "UK"). 1 to 3 per audience.
- \`exclude_domains\`: always include ${d}, plus any competitor the site names.
- Fill \`revenue_range\`, \`technologies\`, \`signals\` and \`lookalike_domains\` only when the material
  supports them. Leave them empty otherwise. Do not guess.
- \`lookalike_domains\`: up to 5 domains of companies that look like ideal customers, usually the
  company's own named customers.
- Never estimate audience size. The application measures it.

### HOW TO WRITE KEYWORDS

What they are for: the application sends \`keywords\` to the lead database as company
keyword tags. They decide WHICH COMPANIES are searched. \`titles\` then decide which people
inside those companies. A company matches if it has ANY one of the keywords, so every extra
keyword makes the search wider, not narrower.

Why they matter: titles such as "Owner", "Founder" or "Finance Manager" exist in every
industry. Without the right keywords the search returns owners of schools, restaurants and
software houses who will never buy. The keywords are what keep the search on real buyers.

Rules:
- Describe the BUYER's company, never the company you are analysing. Ask: "what kind of
  business is this audience?" not "what does ${d} sell?".
- Use industry words a company would put on its own LinkedIn or directory profile:
  "wholesale", "distribution", "textile manufacturing", "pharmacy", "accounting firm".
- Never use the product category or features of ${d}. If ${d} sells inventory software,
  "inventory management", "inventory", "billing", "erp" and "accounting software" are
  forbidden, because they match ${d}'s competitors, not its customers.
- Never use job functions ("finance", "operations", "sales"). Those belong in \`titles\`.
- Never use generic words: "business", "company", "sme", "small business", "startup",
  "services", "solutions", "technology", "enterprise", "b2b".
- 1 to 3 words each, lowercase, singular where natural. 2 to 5 per audience.
- Each audience needs its own keywords. Two audiences with the same keywords and similar
  titles are one audience; merge them.
- If ${d} serves any industry, pick the industries the site names in case studies,
  testimonials, named customers or industry pages. If the site names none, pick the 2 to 3
  industries where the evidence is strongest and lower \`confidence\`.
- If the business sells to consumers, the keywords describe the businesses that serve those
  consumers (e.g. "dental clinic", "gym"), never the consumers.
- \`keyword_suggestions\`: up to 5 more keywords that also fit this audience, under the same
  rules. The user can add them in one click. Never repeat a word from \`keywords\`.

Good and bad (format only, do not copy):
  Company sells freight forwarding.
  Good: ["ecommerce", "consumer goods", "apparel"]
  Bad:  ["freight", "logistics software", "shipping", "small business", "operations"]

### IF THE MATERIAL IS THIN

Set \`confidence\` honestly. Below 0.4 means you had almost nothing to work with; the application
will ask the user three questions instead of trusting your answer.

### IF THE BUSINESS SELLS TO CONSUMERS

Set \`warning\` to explain it, and still return the closest business audiences, for example the
shops, clinics or agencies that serve those consumers.

---

### OUTPUT SCHEMA

{
  "brand_detail": {
    "company_name": string,
    "one_liner": string,                       // max 20 words, what they sell and to whom
    "offerings": string[],                     // 2 to 6
    "business_model": "B2B" | "B2C" | "both" | null,
    "customer_types": string[],
    "customer_size_hint": string | null,
    "geographies": string[],
    "price_level": string | null,
    "proof": [{ "text": string, "source": string }],
    "differentiators": [{ "text": string, "source": string }],
    "named_customers": string[],
    "buyer_titles_seen": string[],
    "competitors": string[],                   // domains
    "language": string,                        // ISO code of the website
    "brand_voice": string,                     // 2 sentences written as the company would write
    "confidence": number,                      // 0 to 1
    "evidence": [{ "claim": string, "source": string }]
  },

  "warning": string | null,

  "target_audience": [
    {
      "id": "seg_1",
      "priority": number,

      "name": string,                          // 2 to 6 words, how a sales team would say it
      "description": string,                   // one plain sentence describing this buyer
      "why_they_buy": string,                  // one sentence
      "goals": string[],                       // 1 to 3
      "pain_points": string[],                 // 2 to 4, concrete, max 8 words each
      "objections": string[],                  // 1 to 3

      "titles": string[],                      // 3 to 8 real job titles
      "include_similar_titles": boolean,
      "seniorities": string[],                 // allowed list only
      "company_sizes": string[],               // allowed list only
      "countries": string[],                   // full names, 1 to 3
      "keywords": string[],                    // 2 to 5, company-type words, lowercase
      "keyword_suggestions": string[],         // 0 to 5, same rules, not already in keywords

      "revenue_range": { "min": number|null, "max": number|null },
      "technologies": string[],
      "signals": {
        "hiring_for_titles": string[],
        "headcount_growth_pct_min": number|null,
        "recently_funded": boolean
      },
      "lookalike_domains": string[],           // max 5
      "exclude_domains": string[],             // always includes ${d}
      "email_status": ["verified"]
    }
  ]
}

---

### SHORT EXAMPLE (format only, do not copy the content)

{
  "brand_detail": {
    "company_name": "Acme Freight",
    "one_liner": "Freight forwarding and fulfilment for UK online brands",
    "offerings": ["Sea freight", "Customs clearance", "3PL fulfilment"],
    "business_model": "B2B",
    "customer_types": ["E-commerce brands", "Amazon sellers"],
    "customer_size_hint": "11 to 200 employees",
    "geographies": ["United Kingdom"],
    "price_level": "Quote based",
    "proof": [{"text": "Cut Brand X shipping costs by 22%", "source": "/case-studies/brand-x"}],
    "differentiators": [{"text": "Same-week customs clearance", "source": "/services"}],
    "named_customers": ["GlowSkin"],
    "buyer_titles_seen": ["Head of Operations"],
    "competitors": ["shipnest.com"],
    "language": "en",
    "brand_voice": "We move your stock and we tell you exactly where it is. No jargon, no surprises at customs.",
    "confidence": 0.82,
    "evidence": [{"claim": "Serves Amazon sellers", "source": "/industries/amazon"}]
  },
  "warning": null,
  "target_audience": [
    {
      "id": "seg_1", "priority": 1,
      "name": "UK brands importing from Asia",
      "description": "Small UK e-commerce brands importing stock from China",
      "why_they_buy": "Customs delays and freight costs eat their margin",
      "goals": ["Predictable landed cost"],
      "pain_points": ["Stock stuck at port", "Unpredictable shipping cost"],
      "objections": ["We already have a forwarder"],
      "titles": ["Head of Operations", "Supply Chain Manager", "Founder"],
      "include_similar_titles": true,
      "seniorities": ["owner", "founder", "head", "director"],
      "company_sizes": ["11,50", "51,200"],
      "countries": ["United Kingdom"],
      "keywords": ["ecommerce", "consumer goods"],
      "keyword_suggestions": ["apparel", "cosmetics"],
      "revenue_range": {"min": null, "max": null},
      "technologies": ["shopify"],
      "signals": {"hiring_for_titles": [], "headcount_growth_pct_min": null, "recently_funded": false},
      "lookalike_domains": ["glowskin.co.uk"],
      "exclude_domains": ["acmefreight.co.uk"],
      "email_status": ["verified"]
    }
  ]
}

---

### BEFORE YOU ANSWER, CHECK

- Valid JSON, nothing outside it
- Every proof and differentiator has a source
- 3 to 6 audiences, each one would need a different email
- Every title is a real job title, no duplicates across audiences
- Every seniority and company size comes from the allowed lists
- Countries are full names
- ${d} appears in every \`exclude_domains\`
- No keyword names what ${d} sells, a job function, or a generic word
- Every keyword is a kind of company a buyer in that audience works at
- No audience size is estimated anywhere
- Nothing invented: if the material did not say it, it is null or empty`;
}
