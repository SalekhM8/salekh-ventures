import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fullToolName, type DepartmentDef } from "./departments.js";
import type { GuardDecision, RunSpec, ToolResult } from "./driver.js";
import { isBlockedAddress } from "../outreach/normalise.js";
import { buildTools, type ToolBackend } from "./tools.js";

/**
 * Everything about one agent session that does not depend on where its data
 * lives: the working copy, the environment, the allow list. The runtime
 * uses it with database-backed tools; the eval runner uses it with fixtures.
 */

export interface ToolCallLog {
  /** The short name for a tool on the allow list, or null for anything else. */
  tool: string | null;
  /** The name as the model gave it. Outside text when it is not on the list. */
  rawName: string;
  allowed: boolean;
  /** True when the tool was allowed but the address it was pointed at is not. */
  blockedAddress?: boolean;
  input: unknown;
}

export interface SessionInput {
  /** The real white-house folder: CLAUDE.md, agents/, businesses/. */
  whRoot: string;
  businessSlug: string;
  def: DepartmentDef;
  backend: ToolBackend;
  apiKey: string;
  brief: string;
  memoryNotes: string[];
  /** Extra in-process tools and no built-ins: how an eval stands in for the web. */
  toolsOverride?: { tools: string[]; builtinTools: string[] };
  onToolCall: (call: ToolCallLog) => Promise<void>;
  timeoutMs?: number;
}

export interface Session {
  spec: RunSpec;
  cleanup: () => Promise<void>;
}

const DENIED = "That tool is not available to this department.";

export async function prepareSession(input: SessionInput): Promise<Session> {
  const { def, businessSlug } = input;
  const source = {
    root: path.join(input.whRoot, "CLAUDE.md"),
    role: path.join(input.whRoot, "agents", `${def.type}.md`),
    business: path.join(input.whRoot, "businesses", businessSlug),
  };
  const role = await readFile(source.role, "utf8");

  // A fresh copy of only what this run may see: the root rules, its own business and
  // its own department. Nothing sits above the copy, so no stray CLAUDE.md (such as
  // the website's, when the runner is started from inside that repo) can load.
  const base = await mkdtemp(path.join(tmpdir(), "wh-run-"));
  const root = path.join(base, "white-house");
  const businessDir = path.join(root, "businesses", businessSlug);
  const cwd = path.join(businessDir, "departments", def.type);
  const home = path.join(base, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await cp(source.root, path.join(root, "CLAUDE.md"));
  await cp(path.join(source.business, "CLAUDE.md"), path.join(businessDir, "CLAUDE.md"));
  await cp(path.join(source.business, "knowledge"), path.join(businessDir, "knowledge"), { recursive: true }).catch(() => undefined);
  await cp(path.join(source.business, "departments", def.type), cwd, { recursive: true });

  const toolNames = input.toolsOverride?.tools ?? [...def.tools];
  const builtinTools = input.toolsOverride?.builtinTools ?? [...def.builtinTools];
  const tools = buildTools(toolNames, input.backend);
  const byFullName = new Map(tools.map((t) => [fullToolName(t.name), t]));
  const allowedTools = [...byFullName.keys(), ...builtinTools];
  const allowed = new Set(allowedTools);

  const guard = async (toolName: string, toolInput: unknown): Promise<GuardDecision> => {
    const ok = typeof toolName === "string" && allowed.has(toolName);
    // Hard rule, for every department: some addresses are never fetched, whoever asks.
    const address = (toolInput as { url?: unknown } | null)?.url;
    if (ok && isBlockedAddress(address)) {
      await input.onToolCall({ tool: null, rawName: String(toolName), allowed: false, blockedAddress: true, input: toolInput });
      return { allow: false, reason: "That address is off limits. LinkedIn profile pages are never read." };
    }
    await input.onToolCall({
      tool: ok ? (byFullName.get(toolName)?.name ?? toolName) : null,
      rawName: String(toolName),
      allowed: ok,
      input: toolInput,
    });
    return ok ? { allow: true, reason: "" } : { allow: false, reason: DENIED };
  };

  const call = async (toolName: string, toolInput: unknown): Promise<ToolResult> => {
    const decision = await guard(toolName, toolInput);
    if (!decision.allow) return { text: decision.reason, isError: true };
    const found = byFullName.get(toolName);
    // A built-in tool belongs to the SDK. A scripted driver has nothing to run for it.
    return found ? found.handler(toolInput) : { text: "" };
  };

  const notes = input.memoryNotes.length
    ? `\n\n## Notes from the owner on earlier work\n\n${input.memoryNotes.map((n) => `- ${n}`).join("\n")}`
    : "";

  const spec: RunSpec = {
    whRoot: root,
    cwd,
    model: def.model,
    maxTurns: def.maxTurns,
    systemAppend: `${role.trim()}${notes}`,
    prompt: input.brief,
    tools,
    builtinTools,
    allowedTools,
    // The agent's whole environment. The model key is the only credential in it.
    env: {
      ANTHROPIC_API_KEY: input.apiKey,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CLAUDE_AGENT_SDK_CLIENT_APP: "white-house-runner/0.1",
      HOME: home,
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    },
    guard,
    call,
    timeoutMs: input.timeoutMs ?? 15 * 60 * 1000,
  };
  return { spec, cleanup: () => rm(base, { recursive: true, force: true }) };
}
