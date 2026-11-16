import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { DriverUsage } from "./driver.js";

/**
 * One model call with a fixed input and a structured answer: no tools, no
 * loop, no web. Used where code has already done the fetching and the model
 * only has to read (classify, extract) or write (draft).
 *
 * The real caller uses the Anthropic TypeScript SDK's structured outputs
 * (`client.messages.parse` with `output_config.format`). Tests use a
 * scripted caller, so no test ever calls the API.
 */

export interface ModelRequest<T> {
  /** For logs and tests: which stage is asking. */
  stage: string;
  /** Pinned by exact id. */
  model: "claude-haiku-5-5" | "claude-sonnet-5-5" | "claude-opus-5-5";
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  effort: "low" | "medium" | "high";
}

export interface ModelReply<T> {
  ok: boolean;
  /** A short fixed code when not ok: refused, truncated, unparsed, api_error. */
  error?: string;
  /**
   * Set when the API refused the request itself (a 4xx other than a rate limit): a schema it will not compile, a
   * bad parameter, a key it does not accept. That is a fault in our own request, never in the business being read,
   * so the API's own error type and the start of its message are kept. The request body is never in here.
   */
  requestError?: { status: number; type: string; message: string };
  data: T | null;
  usage: DriverUsage;
  /** An estimate from list prices. Not a bill. */
  costUsd: number;
}

export interface ModelCaller {
  call<T>(apiKey: string, request: ModelRequest<T>): Promise<ModelReply<T>>;
}

/**
 * List prices in dollars per million tokens (input, output, cache read),
 * as checked on 12 Nov 2026 (DECISIONS.md, section 18 checks) and again in
 * the SDK's bundled reference on 15 Nov 2026. Haiku 5.5 costs five times
 * more once a prompt passes 100,000 tokens, which is why every prompt here
 * is kept far below that. Replace when prices change.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; longPromptFactor?: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.005, longPromptFactor: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
};

export function estimateCostUsd(model: string, usage: DriverUsage): number {
  const price = PRICES[model];
  if (!price) return 0;
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const factor = price.longPromptFactor && promptTokens > 100_000 ? price.longPromptFactor : 1;
  // Cache writes are priced as input here: this code never asks for caching, so there are none.
  const dollars = ((usage.inputTokens + usage.cacheCreationTokens) * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * price.cacheRead) * factor;
  return Math.round((dollars / 1_000_000) * 1e8) / 1e8;
}

const zero = (): DriverUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });

export function createAnthropicCaller(): ModelCaller {
  return {
    async call<T>(apiKey: string, request: ModelRequest<T>): Promise<ModelReply<T>> {
      const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
      try {
        const response = await client.messages.parse({
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
          output_config: { format: zodOutputFormat(request.schema as z.ZodType), effort: request.effort },
        });
        const usage: DriverUsage = {
          inputTokens: response.usage.input_tokens ?? 0,
          outputTokens: response.usage.output_tokens ?? 0,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        };
        const costUsd = estimateCostUsd(request.model, usage);
        // Check why it stopped before trusting what it said.
        if (response.stop_reason === "refusal") return { ok: false, error: "refused", data: null, usage, costUsd };
        if (response.stop_reason === "max_tokens") return { ok: false, error: "truncated", data: null, usage, costUsd };
        const data = (response.parsed_output ?? null) as T | null;
        return data === null ? { ok: false, error: "unparsed", data: null, usage, costUsd } : { ok: true, data, usage, costUsd };
      } catch (err) {
        const status = err instanceof Anthropic.APIError ? err.status : undefined;
        const reply: ModelReply<T> = { ok: false, error: status ? `api_error_${status}` : "api_error", data: null, usage: zero(), costUsd: 0 };
        const requestError = requestErrorOf(err);
        return requestError ? { ...reply, requestError } : reply;
      }
    },
  };
}

/** The API's own account of a request it refused, or null for anything else (a rate limit, an overload, a network fault). */
export function requestErrorOf(err: unknown): { status: number; type: string; message: string } | null {
  const status = Number((err as { status?: unknown } | null)?.status);
  if (!Number.isInteger(status) || status < 400 || status > 499 || status === 429 || status === 408) return null;
  const body = (err as { error?: { error?: { type?: unknown; message?: unknown } } }).error?.error;
  const type = typeof body?.type === "string" ? body.type : "request_error";
  const message = typeof body?.message === "string" ? body.message : String((err as { message?: unknown }).message ?? "");
  return { status, type: type.slice(0, 80), message: message.replace(/\s+/g, " ").trim().slice(0, 300) };
}

/** A caller that answers from a script. Every test uses this. It makes no network call. */
export function createScriptedModel(
  script: (request: ModelRequest<unknown>) => Promise<{ data: unknown; usage?: Partial<DriverUsage>; costUsd?: number } | { error: string; costUsd?: number; requestError?: { status: number; type: string; message: string } }>,
): ModelCaller {
  return {
    async call<T>(_apiKey: string, request: ModelRequest<T>): Promise<ModelReply<T>> {
      const answer = await script(request as ModelRequest<unknown>);
      if ("error" in answer) return { ok: false, error: answer.error, data: null, usage: zero(), costUsd: answer.costUsd ?? 0, ...(answer.requestError ? { requestError: answer.requestError } : {}) };
      // The scripted answer goes through the same schema the real one would be held to.
      const parsed = request.schema.safeParse(answer.data);
      const usage = { ...zero(), ...answer.usage };
      if (!parsed.success) return { ok: false, error: "unparsed", data: null, usage, costUsd: answer.costUsd ?? 0 };
      return { ok: true, data: parsed.data, usage, costUsd: answer.costUsd ?? 0 };
    },
  };
}
