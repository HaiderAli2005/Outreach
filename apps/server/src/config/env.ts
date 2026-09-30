import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default("info"),
  WEB_ORIGIN: z.string().default("http://localhost:3100"),
  PUBLIC_API_URL: z.string().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: optional,
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  ENCRYPTION_KEY: z.string().min(1, "ENCRYPTION_KEY is required (base64, 32 bytes)"),
  JOBS_SECRET: z.string().min(8),
  WEBHOOK_SECRET: z.string().min(8),
  APPROVE_LINK_SECRET: z.string().min(8),
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GOOGLE_REDIRECT_URI: optional,
  STRIPE_SECRET_KEY: optional,
  STRIPE_PUBLISHABLE_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  STRIPE_PRICE_LAUNCH: optional,
  STRIPE_PRICE_GROWTH: optional,
  STRIPE_PRICE_SCALE: optional,
  STRIPE_PRICE_INBOX: optional,
  STRIPE_PRICE_INBOX_FAST: optional,
  INBOX_FAST_PRICE_CENTS: z.preprocess((v) => (typeof v === "string" && !v.trim() ? undefined : v), z.coerce.number().int().positive().optional()),
  MAIL_HOST: optional,
  MAIL_PORT: z.preprocess((v) => (typeof v === "string" && !v.trim() ? undefined : v), z.coerce.number().int().positive().default(587)),
  MAIL_USER: optional,
  MAIL_PASS: optional,
  MAIL_FROM: optional,
  OPENAI_API_KEY: optional,
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  /**
   * Models for the first impression (the business analysis and the sample emails), best first, separated by commas.
   * A model the account can't use is skipped; OPENAI_MODEL is the last resort.
   */
  OPENAI_ANALYSIS_MODEL: z.string().default("gpt-6-luna,gpt-4.1"),
  APOLLO_API_KEY: optional,
  SMARTLEAD_API_KEY: optional,
  MILLIONVERIFIER_API_KEY: optional,
  SLACK_WEBHOOK_URL: optional,
  /** Infraforge (mail infrastructure). With a key set, paid setups register domains and create inboxes automatically. */
  INFRAFORGE_API_KEY: optional,
  INFRAFORGE_API_URL: z.string().default("https://api.infraforge.ai/public"),
  /** Registrant details used when buying sending domains. All of these are required before the first purchase. */
  INFRAFORGE_CONTACT_FIRST_NAME: optional,
  INFRAFORGE_CONTACT_LAST_NAME: optional,
  INFRAFORGE_CONTACT_EMAIL: optional,
  INFRAFORGE_CONTACT_PHONE: optional,
  INFRAFORGE_CONTACT_ORG: optional,
  INFRAFORGE_CONTACT_ADDRESS: optional,
  INFRAFORGE_CONTACT_CITY: optional,
  INFRAFORGE_CONTACT_PROVINCE: optional,
  INFRAFORGE_CONTACT_POSTAL_CODE: optional,
  INFRAFORGE_CONTACT_COUNTRY: optional,
  /** Where DMARC aggregate reports go. Empty keeps Infraforge's default. */
  INFRAFORGE_DMARC_EMAIL: optional,
  INFRAFORGE_DMARC_POLICY: z.enum(["none", "quarantine", "reject"]).default("quarantine"),
  /** Daily volume at which an organization gets its own dedicated IP instead of the shared pool. */
  INFRAFORGE_DEDICATED_IP_MIN_VOLUME: z.coerce.number().int().positive().default(2500),
  /** SSL on the forwarding, so https://getyou.com also lands on the customer's site. Costs about $2 a domain a month. */
  INFRAFORGE_SSL_FORWARDING: z.string().optional(),
  /** Never buy a domain above this price (premium names). */
  INFRAFORGE_MAX_DOMAIN_PRICE_CENTS: z.coerce.number().int().positive().default(5000),
  /** Used only if Infraforge does not return the host with the inbox credentials. */
  INFRAFORGE_SMTP_HOST: optional,
  INFRAFORGE_SMTP_PORT: z.coerce.number().int().positive().default(587),
  INFRAFORGE_IMAP_HOST: optional,
  INFRAFORGE_IMAP_PORT: z.coerce.number().int().positive().default(993),
  /** Days after a subscription ends before its inboxes are deleted and domain renewal is switched off. */
  INFRAFORGE_RELEASE_AFTER_DAYS: z.coerce.number().int().min(0).default(7),
  /** Run the infrastructure job inside the API process every minute (handy locally, where no scheduler runs). */
  INFRA_POLL_IN_PROCESS: z.string().optional(),
  AUTO_REPLY_KILL: z.string().optional(),
  ANALYSIS_STREAM: z.string().optional(),
  ACCURATE_COMPANY_COUNT: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === "production") {
    for (const key of ["JOBS_SECRET", "WEBHOOK_SECRET", "APPROVE_LINK_SECRET"] as const) {
      if (env[key].startsWith("change-me")) throw new Error(`${key} still has its placeholder value`);
    }
  }
  return env;
}

export const env = load();

export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

export const webOrigins = env.WEB_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);

export const features = {
  googleOAuth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI),
  stripe: Boolean(env.STRIPE_SECRET_KEY),
  ai: Boolean(env.OPENAI_API_KEY),
  mail: Boolean(env.MAIL_HOST && env.MAIL_USER && env.MAIL_PASS && env.MAIL_FROM),
  /** Live progress stream for the business analysis. Off means the old single request. */
  analysisStream: !/^(0|false|no|off)$/i.test(env.ANALYSIS_STREAM ?? "true"),
  /** One paid organisation-level count per audience, for a true company total. */
  accurateCompanyCount: /^(1|true|yes|on)$/i.test(env.ACCURATE_COMPANY_COUNT ?? "false"),
  /** Domains and inboxes are bought and set up automatically after payment. */
  infraforge: Boolean(env.INFRAFORGE_API_KEY),
  infraSslForwarding: !/^(0|false|no|off)$/i.test(env.INFRAFORGE_SSL_FORWARDING ?? "true"),
  /** In-process infrastructure polling: on by default outside production when Infraforge is configured. */
  infraPollInProcess: /^(1|true|yes|on)$/i.test(env.INFRA_POLL_IN_PROCESS ?? (env.NODE_ENV === "development" ? "true" : "false")),
};
