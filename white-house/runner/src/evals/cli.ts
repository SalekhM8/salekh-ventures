import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkDriver } from "../agents/sdk-driver.js";
import { apiKeyEnvName } from "../seed.js";
import { loadCases, runEvals } from "./runner.js";

/**
 * Run one department's eval cases against the real model:
 *
 *   ANTHROPIC_API_KEY_SALEKH=... npm run evals -- salekh-ventures data
 *
 * Costs money: one model run per case. Exits 0 when every case passes, 1
 * when any fails, 2 when it could not run.
 */
const [business, department] = process.argv.slice(2);
const whRoot = process.env.WH_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const keyName = apiKeyEnvName(process.env.WH_TENANT_SLUG ?? "salekh");
const apiKey = process.env[keyName];
if (!business || !department) {
  console.error("Usage: npm run evals -- <business> <department>");
  process.exit(2);
}
if (!apiKey) {
  console.error(`${keyName} is not set. Evals against the real model need the tenant's key. Nothing was run.`);
  process.exit(2);
}
const cases = await loadCases(whRoot, business, department);
const summary = await runEvals({ whRoot, business, department, cases, driver: createSdkDriver(), apiKey });
for (const r of summary.results) {
  console.log(`${r.passed ? "pass" : "FAIL"}  ${r.id}${r.failures.length ? `\n      ${r.failures.join("\n      ")}` : ""}`);
}
console.log(`\n${summary.passed} of ${summary.total} passed.`);
process.exit(summary.failed === 0 ? 0 : 1);
