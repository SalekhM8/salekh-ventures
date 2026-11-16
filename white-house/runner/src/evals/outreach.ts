import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelCaller } from "../agents/model-caller.js";
import { extractFromPages, type Page } from "../outreach/extract.js";
import { domainKey, namePostcodeHash, namesNearlyMatch } from "../outreach/normalise.js";
import { DEFAULT_OUTREACH_SETTINGS } from "../outreach/settings.js";
import { analyseBusiness, classifyLeads, draftCard, type Lead } from "../outreach/stages.js";
import { matcher, type EvalCase, type EvalResult, type EvalSummary } from "./runner.js";

/**
 * Evals for the Outreach room. It is not an agent session but three single
 * model calls, so each case tests one call: the case supplies what code
 * would hand the model (search results, a business's pages, or the checked
 * facts), the same code that runs in the pipeline checks the answer, and the
 * case's checks are applied to what would have been stored.
 */
export async function runOutreachEvals(input: { whRoot: string; business: string; cases: EvalCase[]; model: ModelCaller; apiKey: string }): Promise<EvalSummary> {
  const read = (...parts: string[]) => readFile(path.join(input.whRoot, ...parts), "utf8").then((t) => t.trim());
  const common = `${await read("CLAUDE.md")}\n\n${await read("businesses", input.business, "CLAUDE.md")}\n\n${await read("businesses", input.business, "departments", "outreach", "CLAUDE.md")}`;
  const settings = DEFAULT_OUTREACH_SETTINGS;
  const results: EvalResult[] = [];

  for (const c of input.cases) {
    const failures: string[] = [];
    let stored: unknown = null;
    try {
      const system = `${common}\n\n${await read("agents", `outreach-${c.stage}.md`)}`;
      const given = c.outreach ?? {};
      if (c.stage === "find") {
        const leads = (given.leads ?? []) as Lead[];
        const { reply, matches, hiddenEmployers } = await classifyLeads(input.model, input.apiKey, system, settings, leads);
        if (!reply.ok) throw new Error(reply.error ?? "the model call failed");
        // The same recognition the master list applies, against the businesses the case says are already known.
        const known = (given.known ?? []) as { name: string; website?: string; postcode?: string }[];
        const recorded: unknown[] = [];
        const refused: unknown[] = [];
        for (const m of matches) {
          const website = m.ownSite ? m.lead.url : null;
          const same = known.some((k) =>
            (website && domainKey(k.website) === domainKey(website)) ||
            (k.postcode && namePostcodeHash(k.name, k.postcode) === namePostcodeHash(m.businessName, k.postcode)) ||
            namesNearlyMatch(k.name, m.businessName));
          if (same) refused.push({ name: m.businessName, why: "already_known" });
          else recorded.push({ name: m.businessName, area: m.area, website, signal: m.signal, evidence: m.evidence, source_url: m.lead.url });
        }
        stored = { recorded, refused, hidden_employers: hiddenEmployers };
      } else if (c.stage === "analyse") {
        const pages = (given.pages ?? []) as Page[];
        const { reply, analysed } = await analyseBusiness(input.model, input.apiKey, system, settings, { name: String(given.name ?? ""), area: given.area ?? null }, pages, extractFromPages(pages));
        if (!reply.ok || !analysed) throw new Error(reply.error ?? "the model call failed");
        stored = { is_match: analysed.isMatch, analysis: analysed.analysis, signals: analysed.signals, not_kept: analysed.dropped };
      } else if (c.stage === "draft") {
        const { draft, problems } = await draftCard(input.model, input.apiKey, system, String(given.facts ?? ""));
        stored = { draft, not_accepted: problems };
      } else {
        throw new Error("an outreach case needs a stage: find, analyse or draft");
      }
    } catch (err) {
      failures.push(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (failures.length === 0) {
      const text = JSON.stringify(stored);
      for (const check of c.must_include) if (!matcher(check)(text)) failures.push(`must include: ${check}`);
      for (const check of c.must_never) if (matcher(check)(text)) failures.push(`must never: ${check}`);
    }
    results.push({ id: c.id, passed: failures.length === 0, failures });
  }
  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}
