import OpenAI from "openai";
import { env } from "../config/env.js";
import { notConfigured } from "../lib/errors.js";

export interface AiOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiClient {
  generateJSON<T = Record<string, unknown>>(prompt: string, opts?: AiOptions): Promise<T | null>;
  generateText(prompt: string, opts?: AiOptions): Promise<string>;
}

const REASONING = /^(?:gpt-5|o[1-9])/i;

class OpenAiClient implements AiClient {
  private readonly client: OpenAI;
  constructor(apiKey: string, private readonly model: string) {
    this.client = new OpenAI({ apiKey });
  }

  private params(prompt: string, opts: AiOptions, json: boolean) {
    const messages: { role: "system" | "user"; content: string }[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: prompt });
    const reasoning = REASONING.test(this.model);
    return {
      model: this.model,
      messages,
      ...(reasoning ? { max_completion_tokens: opts.maxTokens ?? 900 } : { max_tokens: opts.maxTokens ?? 900, temperature: opts.temperature ?? 0.4 }),
      ...(json ? { response_format: { type: "json_object" as const } } : {}),
    };
  }

  async generateJSON<T>(prompt: string, opts: AiOptions = {}): Promise<T | null> {
    const res = await this.client.chat.completions.create(this.params(prompt, opts, true));
    const text = String(res.choices?.[0]?.message?.content ?? "").trim();
    if (!text) throw new Error(`empty AI completion (${res.choices?.[0]?.finish_reason ?? "unknown"})`);
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async generateText(prompt: string, opts: AiOptions = {}): Promise<string> {
    const res = await this.client.chat.completions.create(this.params(prompt, opts, false));
    return String(res.choices?.[0]?.message?.content ?? "").trim();
  }
}

let override: AiClient | null | undefined;
let cached: AiClient | null | undefined;

export function getAi(): AiClient | null {
  if (override !== undefined) return override;
  if (cached === undefined) cached = env.OPENAI_API_KEY ? new OpenAiClient(env.OPENAI_API_KEY, env.OPENAI_MODEL) : null;
  return cached;
}

export function requireAi(): AiClient {
  const ai = getAi();
  if (!ai) throw notConfigured("AI (OPENAI_API_KEY)");
  return ai;
}

export function setAiClient(client: AiClient | null | undefined): void {
  override = client;
}
