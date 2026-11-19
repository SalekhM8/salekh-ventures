import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkDriver } from "./agents/sdk-driver.js";
import { createAnthropicCaller } from "./agents/model-caller.js";
import { agentReachFromEnv } from "./control/connectors/agent-reach.js";
import { companiesHouseFromKey } from "./control/connectors/companies-house.js";
import { mailboxFromEnv, ownerMailboxFromEnv } from "./control/connectors/mailbox.js";
import { placesFromKey } from "./control/connectors/places.js";
import { createDirectReader } from "./control/connectors/direct-read.js";
import { createPostHogConnector } from "./control/connectors/posthog.js";
import { ADMIN_ONLY_ENV, BOOTSTRAP_FAILED, bootstrapFromEnv, connectionUrls } from "./bootstrap.js";
import { createDb, isUuid } from "./control/db.js";
import { installProcessGuard } from "./guard.js";
import { createRuntime } from "./runtime.js";
import { createScheduler } from "./scheduler.js";
import { createWatcher } from "./watcher.js";
import { breakerToday } from "./outreach/enquiries.js";
import { apiKeyEnvName } from "./seed.js";
import { createRunnerServer } from "./server.js";

const env = process.env;

// Nothing that goes wrong with one web page, one mailbox call or one run may stop the whole server.
installProcessGuard(process);

// The database setup, when this process is asked to do it itself (WH_BOOTSTRAP=1). The image does it in a
// separate process first (start.js), which is the safer way: this one then never has the owner's URL at all.
if (env.WH_BOOTSTRAP === "1") {
  try {
    await bootstrapFromEnv(env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : BOOTSTRAP_FAILED);
    process.exit(1);
  }
}
// The server's three logins: given outright, or built from the host, the database name and each login's password.
const urls = connectionUrls(env);
// From here on this process holds no way in as the database's owner, and no login password outside the pools it
// opens below. Nothing it starts (an agent run least of all) can be handed what is no longer here.
for (const name of [...ADMIN_ONLY_ENV, "WH_DB_PASSWORD_AGENT", "WH_DB_PASSWORD_GATEWAY", "WH_DB_PASSWORD_UI", "DATABASE_URL_GATEWAY", "DATABASE_URL_UI", "DATABASE_URL_AGENT"]) delete env[name];

const role = env.WH_ROLE === "standby" ? "standby" : "primary";
if (env.WH_ROLE !== undefined && env.WH_ROLE !== "primary" && env.WH_ROLE !== "standby") {
  console.error("WH_ROLE must be primary or standby.");
  process.exit(1);
}
const port = Number(env.PORT ?? 8080);
// Local by default. A container sets HOST=0.0.0.0 (the Dockerfile does).
const host = env.HOST ?? "127.0.0.1";

/** PLACEHOLDER rate, dollars to pounds, until Salekh settles the currency rule. Set WH_USD_TO_GBP to replace it. */
const PLACEHOLDER_USD_TO_GBP = 0.79;

/** Traffic sources by floor. Only the Salekh Ventures site has one so far. */
const TRAFFIC_HOSTS: Record<string, string[]> = { "salekh-ventures": ["salekhventures.com", "www.salekhventures.com"] };

function buildRuntime() {
  const missing = [
    ...["WH_API_TOKEN", "WH_TENANT_ID"].filter((name) => !env[name]),
    ...(["gateway", "ui", "agent"] as const).filter((r) => !urls[r]).map((r) => `DATABASE_URL_${r.toUpperCase()} (or DATABASE_HOST, DATABASE_NAME and WH_DB_PASSWORD_${r.toUpperCase()})`),
  ];
  if (missing.length > 0) {
    console.log(`API routes not started: ${missing.join(", ")} not set. Health check only.`);
    return null;
  }
  // Off this machine, the token is all that stands between the internet and the API: a short one is refused.
  if (host !== "127.0.0.1" && host !== "localhost" && (env.WH_API_TOKEN as string).length < 32) {
    console.error("WH_API_TOKEN is shorter than 32 characters. It is not accepted on an address other machines can reach.");
    process.exit(1);
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

  const reach = agentReachFromEnv(env.AGENT_REACH_BIN);
  if (!reach) console.log("The search tool is not installed here (AGENT_REACH_BIN is not set, or nothing is at that path): job adverts are not searched. Outreach runs on Google Places and direct reading.");
  if (role === "standby") console.log("WH_ROLE=standby: this runner starts no runs, sends nothing and does not look in the mailbox.");
  const mailbox = mailboxFromEnv(env);
  if (!mailbox) console.log(env.MAIL_TRANSPORT === "gmail_api"
    ? "TEST_MAILBOX_ADDRESS, GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET and GMAIL_OAUTH_REFRESH_TOKEN are not all set: no test enquiry will be drafted, sent or read."
    : "TEST_MAILBOX_ADDRESS and TEST_MAILBOX_APP_PASSWORD are not both set: no test enquiry will be drafted, sent or read.");
  else console.log(`mail transport: ${mailbox.transport ?? "smtp_imap"}`);
  const owner = ownerMailboxFromEnv(env);
  console.log(owner.mailbox
    ? "owner mailbox: connected over the Gmail API (follow-up emails can be sent from it)"
    : `owner mailbox: not connected (${owner.why}). Follow-up emails are drafted and approved, then copied and sent by hand.`);
  if (!env.GOOGLE_PLACES_API_KEY) console.log("GOOGLE_PLACES_API_KEY is not set: businesses are found by web search, as before.");
  if (!env.COMPANIES_HOUSE_API_KEY) console.log("COMPANIES_HOUSE_API_KEY is not set: companies will be recorded as not checked.");

  const gatewayDb = createDb(urls.gateway as string);
  const runtime = createRuntime({
    gatewayDb,
    uiDb: createDb(urls.ui as string, 4),
    agentDb: createDb(urls.agent as string, 4),
    role,
    tenantId: env.WH_TENANT_ID as string,
    whRoot: env.WH_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    driver: createSdkDriver(),
    model: createAnthropicCaller(),
    reach,
    companiesHouse: companiesHouseFromKey(env.COMPANIES_HOUSE_API_KEY),
    places: placesFromKey(env.GOOGLE_PLACES_API_KEY),
    // Pages are read directly, and through the search tool only as a fallback. DIRECT_READ=off goes back to the search tool alone.
    directReader: env.DIRECT_READ === "off" ? null : createDirectReader(),
    // The test mailbox: read here, by the runner, and given to nothing but the gateway's mail connector.
    mailbox,
    // The owner's mailbox: read here, and given to nothing but the follow-up connector.
    ownerMailbox: owner.mailbox,
    // Read at the moment of each run, so a key added later needs no restart of anything but this process's env.
    apiKeyFor: (tenantSlug) => env[apiKeyEnvName(tenantSlug)] || undefined,
    usdToGbp: rate,
    ...(posthog ? { traffic: { connector: posthog, hostsByBusiness: TRAFFIC_HOSTS } } : {}),
  });
  // Rooms with a daily time in their schedule are started by the runner itself, once a day.
  const scheduler = createScheduler({ db: gatewayDb, tenantId: env.WH_TENANT_ID as string, startRun: (roomId) => runtime.startRun(roomId, {}) as Promise<{ status: number; reason?: string; runId?: string }> });
  // The Engineering watcher: once an hour, a plain line on whether Outreach is all right, for the Chief of Staff. It only reports.
  const watcher = createWatcher({
    db: gatewayDb, tenantId: env.WH_TENANT_ID as string,
    mailboxes: { test: mailbox !== null, owner: owner.mailbox !== null },
    stopToday: (now) => breakerToday(gatewayDb, env.WH_TENANT_ID as string, now),
  });
  return { runtime, scheduler, watcher };
}

const built = buildRuntime();
const runtime = built?.runtime ?? null;
const server = runtime ? createRunnerServer({ runtime, token: env.WH_API_TOKEN as string, trustProxy: env.WH_TRUST_PROXY === "1" }) : createRunnerServer();

server.listen(port, host, () => {
  console.log(`white-house-runner listening on ${host}:${port}${runtime ? " (API v1 on)" : ""}`);
  // One mailbox, one owner: a standby runs no schedule, sends nothing and does not look in the mailbox.
  if (role === "standby") return;
  // Can mail leave this server, and can the mailbox be read from it? One line each, with the error code and nothing else.
  // Then, if asked, enquiries that never reached the mail server are put back in the queue. Both before anything is sent.
  built?.scheduler.start(60_000);
  built?.watcher.start(60 * 60_000);
  if (runtime) {
    void (async () => {
      // A run left "running" by a process that is gone would leave its room stuck for good. Each is closed as failed, and a
      // pipeline run that was cut off is started again, once, a little after start.
      const cut = await runtime.closeInterrupted().catch(() => ({ closed: 0, restart: [] as string[] }));
      if (cut.closed > 0) console.log(`runs left running by an earlier process, closed as interrupted_by_restart: ${cut.closed}`);
      for (const room of cut.restart) {
        setTimeout(() => void runtime.startRun(room, {}).then((r) => console.log(`run cut off by the restart, started again: ${room.replace(/[^a-z0-9:-]/gi, "")} (${r.status})`), () => undefined), 30_000);
      }
      // The owner's switch: lift a stop on sending for one day, once.
      if (env.WH_CLEAR_STOP) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(env.WH_CLEAR_STOP)) console.error("WH_CLEAR_STOP must be a date written YYYY-MM-DD. Nothing was lifted.");
        else console.log(`stop on sending for ${env.WH_CLEAR_STOP}: ${(await runtime.clearStop(env.WH_CLEAR_STOP).catch(() => false)) ? "lifted by the owner's switch" : "nothing to lift (not today, not stopped, or already lifted once)"}`);
      }
      if (env.WH_REDRAFT_CARDS_SINCE) {
        const n = await runtime.redraftCards(env.WH_REDRAFT_CARDS_SINCE).catch((err) => { console.error(`profiles to write again: ${(err as { code?: string })?.code ?? ""} ${String((err as Error)?.message ?? err).slice(0, 200)}`); return -1; });
        console.log(n < 0 ? "profiles to write again: failed" : `profiles written since ${env.WH_REDRAFT_CARDS_SINCE} to be written again on the next run: ${n}`);
      }
      const mail = await runtime.checkMail().catch(() => null);
      if (mail) {
        console.log(`mail out: ${mail.out.reachable ? "reachable" : `unreachable (${mail.out.code ?? "unknown"})`}`);
        console.log(`mail in: ${mail.in.reachable ? "reachable" : `unreachable (${mail.in.code ?? "unknown"})`}`);
        if (!mail.out.reachable) console.log("No enquiry will be attempted until mail can leave this server. If outbound SMTP is blocked here, set MAIL_TRANSPORT=gmail_api (see DEPLOY.md).");
      }
      const since = env.WH_REQUEUE_UNSENT_SINCE;
      if (since) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) console.error("WH_REQUEUE_UNSENT_SINCE must be a date written YYYY-MM-DD. Nothing was put back.");
        else console.log(`enquiries that never reached the mail server since ${since}, put back in the queue: ${await runtime.requeueUnsent(new Date(`${since}T00:00:00Z`)).catch(() => 0)}`);
      }
      // Every ten minutes: look for replies to the enquiries this system sent, and send whatever is due.
      const look = () => void runtime.collectReplies().catch((err) => console.error(`reply check failed: ${err instanceof Error ? err.name : "error"}`));
      setInterval(look, 10 * 60_000).unref();
      look();
    })();
  }
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
