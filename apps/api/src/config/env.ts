import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default("info"),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
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
  OPENAI_API_KEY: optional,
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  APOLLO_API_KEY: optional,
  SMARTLEAD_API_KEY: optional,
  MILLIONVERIFIER_API_KEY: optional,
  SLACK_WEBHOOK_URL: optional,
  AUTO_REPLY_KILL: z.string().optional(),
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
};
