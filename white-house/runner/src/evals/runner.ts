import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DEPARTMENTS } from "../agents/departments.js";
import type { AgentDriver } from "../agents/driver.js";
import { prepareSession, type ToolCallLog } from "../agents/session.js";
import type { MetricRow, ToolBackend } from "../agents/tools.js";

/**
 * The eval runner (BRIEF.md section 10, "Tests"), minimal form: code checks
 * only. Each case in evals/<business>/<department>/*.json gives a brief, the
 * fixtures the agent's tools return, and what the finished work must
 * include, must never include, and which tools it must or must not reach
 * for. The agent runs exactly as in a real run, except that its tools read
 * the case's fixtures and write nowhere, and Research reads the case's
 * fixture pages in place of the live web (so a planted page can be tested).
 *
 * With a real key it runs the real model. Tests run it with a scripted driver.
 */

export interface EvalCase {
  id: string;
  title: string;
  /** Empty: the department's own default brief. */
  brief: string;
  /** The right answer, in words, for a person reading a failure. */
  expected: string;
  attack: boolean;
  fixtures: { metrics: MetricRow[]; targets: { key: string; value: unknown }[]; web: Record<string, string> };
  /** Each is a case-insensitive phrase, or a regular expression written "/.../flags". */
  must_include: string[];
  must_never: string[];
  must_call: string[];
  must_not_call: string[];
  /** Fails if any fetch was attempted for an address containing one of these, allowed or not. */
  must_not_fetch: string[];
}

export interface EvalResult {
  id: string;
  passed: boolean;
  failures: string[];
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  results: EvalResult[];
}

export async function loadCases(whRoot: string, business: string, department: string): Promise<EvalCase[]> {
  const dir = path.join(whRoot, "evals", business, department);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const cases: EvalCase[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(path.join(dir, file), "utf8")) as Partial<EvalCase>;
    if (!raw.id || !raw.title || !raw.expected) throw new Error(`${path.join(dir, file)}: a case needs id, title and expected`);
    cases.push({
      id: raw.id,
      title: raw.title,
      brief: raw.brief ?? "",
      expected: raw.expected,
      attack: raw.attack === true,
      fixtures: { metrics: raw.fixtures?.metrics ?? [], targets: raw.fixtures?.targets ?? [], web: raw.fixtures?.web ?? {} },
      must_include: raw.must_include ?? [],
      must_never: raw.must_never ?? [],
      must_call: raw.must_call ?? [],
      must_not_call: raw.must_not_call ?? [],
      must_not_fetch: raw.must_not_fetch ?? [],
    });
  }
  return cases;
}

function matcher(check: string): (text: string) => boolean {
  const asRegex = /^\/(.+)\/([a-z]*)$/s.exec(check);
  if (asRegex) {
    const regex = new RegExp(asRegex[1] as string, asRegex[2] || "i");
    return (text) => regex.test(text);
  }
  const phrase = check.toLowerCase();
  return (text) => text.toLowerCase().includes(phrase);
}

export interface RunEvalsInput {
  whRoot: string;
  business: string;
  department: string;
  cases: EvalCase[];
  driver: AgentDriver;
  apiKey: string;
}

export async function runEvals(input: RunEvalsInput): Promise<EvalSummary> {
  const def = DEPARTMENTS[input.department];
  if (!def) throw new Error(`department ${input.department} has no agent`);
  const results: EvalResult[] = [];

  for (const c of input.cases) {
    const outputs: string[] = [];
    const calls: ToolCallLog[] = [];
    const backend: ToolBackend = {
      readTargets: async () => ({ targets: c.fixtures.targets }),
      readMetrics: async ({ metric }) => c.fixtures.metrics.filter((m) => !metric || m.metric === metric),
      writeOutput: async ({ title, body }) => {
        outputs.push(`${title}\n\n${body}`);
        return { outputId: `eval-${outputs.length}` };
      },
      handOff: async () => ({ ok: true }),
      proposeAction: async () => ({ outcome: "recommended" }),
      webSearch: async () => Object.entries(c.fixtures.web).map(([url, page]) => ({ url, title: page.split("\n")[0]?.slice(0, 120) ?? url })),
      webFetch: async ({ url }) => c.fixtures.web[url] ?? null,
    };
    const failures: string[] = [];
    let cleanup: (() => Promise<void>) | null = null;
    try {
      const session = await prepareSession({
        whRoot: input.whRoot,
        businessSlug: input.business,
        def,
        backend,
        apiKey: input.apiKey,
        brief: c.brief || def.defaultBrief || "",
        memoryNotes: [],
        // No live web in an eval: the case's pages are served by in-process tools instead.
        ...(def.builtinTools.length > 0 ? { toolsOverride: { tools: [...def.tools, "web_search", "web_fetch"], builtinTools: [] } } : {}),
        onToolCall: async (call) => void calls.push(call),
      });
      cleanup = session.cleanup;
      const result = await input.driver.run(session.spec);
      if (!result.ok) failures.push(`run failed: ${result.error ?? "unknown"}`);
    } catch (err) {
      failures.push(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await cleanup?.().catch(() => undefined);
    }

    if (failures.length === 0) {
      const text = outputs.join("\n\n");
      if (outputs.length === 0) failures.push("no output was written");
      for (const check of c.must_include) if (outputs.length > 0 && !matcher(check)(text)) failures.push(`must include: ${check}`);
      for (const check of c.must_never) if (matcher(check)(text)) failures.push(`must never: ${check}`);
      const used = new Set(calls.filter((call) => call.allowed).map((call) => call.tool));
      for (const tool of c.must_call) if (!used.has(tool)) failures.push(`must call: ${tool}`);
      // Reaching for a forbidden tool fails the case even though the allow list stopped it.
      for (const tool of c.must_not_call) {
        if (calls.some((call) => call.tool === tool || call.rawName === tool || call.rawName.endsWith(`__${tool}`))) failures.push(`must not call: ${tool}`);
      }
      for (const part of c.must_not_fetch) {
        const fetched = calls.some((call) => {
          const url = (call.input as { url?: unknown } | null)?.url;
          return typeof url === "string" && url.includes(part);
        });
        if (fetched) failures.push(`must not fetch: ${part}`);
      }
    }
    results.push({ id: c.id, passed: failures.length === 0, failures });
  }

  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}
