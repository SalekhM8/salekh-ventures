import type { z } from "zod";

/**
 * The seam between the harness and the model. The harness builds a RunSpec;
 * a driver carries it out. The real driver uses the Claude Agent SDK. Tests
 * and offline evals use a scripted driver, so no test ever calls the API.
 */

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface AgentTool {
  /** Short name, for example "read_metrics". The model sees mcp__wh__read_metrics. */
  name: string;
  description: string;
  /** A zod raw shape. Anything else in the input is dropped before the handler runs. */
  shape: z.ZodRawShape;
  /** Already wrapped by the harness: validates its input and never throws. */
  handler: (args: unknown) => Promise<ToolResult>;
}

export interface GuardDecision {
  allow: boolean;
  reason: string;
}

export interface RunSpec {
  /** The run's own copy of the white-house tree. Nothing sits above it. */
  whRoot: string;
  /** The department folder inside that copy. */
  cwd: string;
  model: string;
  maxTurns: number;
  /** The department's role and its approved memory notes. */
  systemAppend: string;
  /** The brief. */
  prompt: string;
  tools: AgentTool[];
  /** Built-in SDK tools available to this run. Usually none. */
  builtinTools: string[];
  /** Full tool names that may be called: mcp__wh__* first, then built-ins. */
  allowedTools: string[];
  /** The whole environment of the agent process. Nothing else is passed. */
  env: Record<string, string>;
  /**
   * The allow list as code. Called for every tool call before it runs. It
   * logs the call and says whether it may go ahead.
   */
  guard: (toolName: string, input: unknown) => Promise<GuardDecision>;
  /** Guard, then run an in-process tool. What a scripted driver uses to act as the model. */
  call: (toolName: string, input: unknown) => Promise<ToolResult>;
  /** Abort after this long whatever the turn count. */
  timeoutMs: number;
}

export interface DriverUsage {
  /** Fresh input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens read from the prompt cache. */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache. */
  cacheCreationTokens: number;
}

export interface DriverResult {
  ok: boolean;
  /** A short code when not ok, for example error_max_turns. */
  error?: string;
  resultText: string;
  usage: DriverUsage;
  /** As the SDK reported it. An estimate, not a bill. */
  costUsd: number;
  numTurns: number;
}

export interface AgentDriver {
  run(spec: RunSpec): Promise<DriverResult>;
}
