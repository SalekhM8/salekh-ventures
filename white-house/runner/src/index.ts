import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkDriver } from "./agents/sdk-driver.js";
import { createPostHogConnector } from "./control/connectors/posthog.js";
import { createDb, isUuid } from "./control/db.js";
import { createRuntime } from "./runtime.js";
import { apiKeyEnvName } from "./seed.js";
import { createRunnerServer } from "./server.js";

const env = process.env;
const port = Number(env.PORT ?? 8080);
// Local by default. A container sets HOST=0.0.0.0 (the Dockerfile does).
const host = env.HOST ?? "127.0.0.1";

/** PLACEHOLDER rate, dollars to pounds, until Salekh settles the currency rule. Set WH_USD_TO_GBP to replace it. */
const PLACEHOLDER_USD_TO_GBP = 0.79;

/** Traffic sources by floor. Only the Salekh Ventures site has one so far. */
const TRAFFIC_HOSTS: Record<string, string[]> = { "salekh-ventures": ["salekhventures.com", "www.salekhventures.com"] };

function buildRuntime() {
  const needed = ["WH_API_TOKEN", "WH_TENANT_ID", "DATABASE_URL_GATEWAY", "DATABASE_URL_UI", "DATABASE_URL_AGENT"] as const;
  const missing = needed.filter((name) => !env[name]);
  if (missing.length > 0) {
    console.log(`API routes not started: ${missing.join(", ")} not set. Health check only.`);
    return null;
  }
  if (!isUuid(env.WH_TENANT_ID)) {
    console.log("API routes not started: WH_TENANT_ID is not a uuid. Health check only.");
    return null;
  }
  const rate = env.WH_USD_TO_GBP === undefined ? PLACEHOLDER_USD_TO_GBP : Number(env.WH_USD_TO_GBP);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("WH_USD_TO_GBP must be a positive number");
  if (env.WH_USD_TO_GBP === undefined) console.log(`Using the placeholder rate of ${PLACEHOLDER_USD_TO_GBP} pounds to the dollar. Set WH_USD_TO_GBP.`);

  const posthog =
    env.POSTHOG_PERSONAL_API_KEY && env.POSTHOG_PROJECT_ID
      ? createPostHogConnector({
          host: env.POSTHOG_HOST ?? "https://eu.posthog.com",
          projectId: env.POSTHOG_PROJECT_ID,
          apiKey: env.POSTHOG_PERSONAL_API_KEY,
        })
      : null;
  if (!posthog) console.log("PostHog is not configured: the Data room will run without fresh traffic totals.");

  return createRuntime({
    gatewayDb: createDb(env.DATABASE_URL_GATEWAY as string),
    uiDb: createDb(env.DATABASE_URL_UI as string, 4),
    agentDb: createDb(env.DATABASE_URL_AGENT as string, 4),
    tenantId: env.WH_TENANT_ID as string,
    whRoot: env.WH_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    driver: createSdkDriver(),
    // Read at the moment of each run, so a key added later needs no restart of anything but this process's env.
    apiKeyFor: (tenantSlug) => env[apiKeyEnvName(tenantSlug)] || undefined,
    usdToGbp: rate,
    ...(posthog ? { traffic: { connector: posthog, hostsByBusiness: TRAFFIC_HOSTS } } : {}),
  });
}

const runtime = buildRuntime();
const server = runtime ? createRunnerServer({ runtime, token: env.WH_API_TOKEN as string }) : createRunnerServer();

server.listen(port, host, () => {
  console.log(`white-house-runner listening on ${host}:${port}${runtime ? " (API v1 on)" : ""}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
