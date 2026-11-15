import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type Options,
  type PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { TOOL_SERVER } from "./departments.js";
import type { AgentDriver, DriverResult, DriverUsage, GuardDecision, RunSpec } from "./driver.js";

/**
 * The real driver: one `query()` per run with the Claude Agent SDK.
 *
 * Option names and behaviour were checked against the official documentation
 * on 12 Nov 2026 (agent-sdk/typescript, custom-tools, hooks, permissions,
 * cost-tracking, hosting, claude-code-features) and against the type
 * definitions shipped with the pinned package (0.3.322). Nothing here has
 * been run against the live API yet.
 */

/**
 * The allow list as a PreToolUse hook. It is registered with no matcher, so
 * it sees every tool call, built-in or in-process. A deny from a hook holds
 * in every permission mode.
 */
export function makePreToolUseHook(guard: (toolName: string, input: unknown) => Promise<GuardDecision>): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;
    const decision = await guard(pre.tool_name, pre.tool_input);
    if (decision.allow) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    };
  };
}

/** The options for `query()`. Separate from the call so they can be checked without a network. */
export function buildSdkOptions(spec: RunSpec, toolServer: unknown, abortController?: AbortController): Options {
  return {
    cwd: spec.cwd,
    model: spec.model,
    maxTurns: spec.maxTurns,
    // "project" is what loads the CLAUDE.md files in cwd and its parents. User and
    // local settings are not loaded. The run's folder has no .claude/ directory,
    // so no project settings file or filesystem hook exists to load.
    settingSources: ["project"],
    systemPrompt: { type: "preset", preset: "claude_code", append: spec.systemAppend },
    // Availability: only these built-ins exist for the model. Usually none.
    tools: [...spec.builtinTools],
    // Permission: these are approved. dontAsk denies anything that would need asking.
    allowedTools: [...spec.allowedTools],
    permissionMode: "dontAsk",
    mcpServers: { [TOOL_SERVER]: toolServer } as Options["mcpServers"],
    // Only the server above. No .mcp.json, no user or plugin servers, no claude.ai connectors.
    strictMcpConfig: true,
    hooks: {
      // onFailure "block": if the hook itself fails, the tool call does not go ahead.
      PreToolUse: [{ hooks: [makePreToolUseHook(spec.guard)], onFailure: "block" }],
    },
    // Replaces the process environment: the agent gets these and nothing else.
    env: spec.env,
    // Nothing on the container's disk is state. Each run starts from the repo and the database.
    persistSession: false,
    ...(abortController ? { abortController } : {}),
  };
}

const zero = (): DriverUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });

export function createSdkDriver(): AgentDriver {
  return {
    async run(spec: RunSpec): Promise<DriverResult> {
      const server = createSdkMcpServer({
        name: TOOL_SERVER,
        version: "1.0.0",
        // Always in the prompt: a short fixed list has no need of tool search.
        alwaysLoad: true,
        tools: spec.tools.map((t) =>
          tool(t.name, t.description, t.shape, async (args) => {
            const result = await t.handler(args);
            return { content: [{ type: "text" as const, text: result.text }], isError: result.isError === true };
          }),
        ),
      });
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), spec.timeoutMs);
      let result: DriverResult | null = null;
      let thrown: unknown = null;
      try {
        for await (const message of query({ prompt: spec.prompt, options: buildSdkOptions(spec, server, abort) })) {
          if (message.type !== "result") continue;
          // modelUsage covers every model call in the run, per model. `usage` is the main loop only.
          const usage = zero();
          for (const m of Object.values(message.modelUsage ?? {})) {
            usage.inputTokens += m.inputTokens;
            usage.outputTokens += m.outputTokens;
            usage.cacheReadTokens += m.cacheReadInputTokens;
            usage.cacheCreationTokens += m.cacheCreationInputTokens;
          }
          result = {
            ok: message.subtype === "success" && message.is_error !== true,
            ...(message.subtype === "success" ? {} : { error: message.subtype }),
            resultText: message.subtype === "success" ? message.result : "",
            usage,
            costUsd: message.total_cost_usd ?? 0,
            numTurns: message.num_turns ?? 0,
          };
          // The CLI can report a failure (a rejected key, say) as a "success" result flagged is_error.
          if (message.subtype === "success" && message.is_error === true) result.error = `error_result: ${message.result.slice(0, 200)}`;
        }
      } catch (err) {
        // A single query() throws after yielding an error result. The result, with its cost, is kept.
        thrown = err;
      } finally {
        clearTimeout(timer);
      }
      if (result) return result;
      const reason = abort.signal.aborted ? "timed_out" : thrown instanceof Error ? thrown.message : "no_result";
      return { ok: false, error: reason, resultText: "", usage: zero(), costUsd: 0, numTurns: 0 };
    },
  };
}
