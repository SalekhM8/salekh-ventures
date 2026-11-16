# White House runner

The service from BRIEF.md section 7. It holds:

- the control layer (phase 1): migrations runner, events, run records and budgets, versioned config, the gateway and approvals;
- the HTTP API the house UI reads (`API.md`);
- the agent run harness (Claude Agent SDK, one `query()` per run) and the first two departments, Data and Research;
- a read only PostHog connector and the plain code pull of traffic totals;
- a minimal eval runner.

No real action connector, no scheduler, no deploy.

## Run the tests

They need a real Postgres. A throwaway one in Docker:

```sh
docker run -d --name wh-pg-dev -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17
```

Then, from `white-house/runner/`:

```sh
npm ci
DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres npm test
```

`npm test` compiles, drops and recreates a database called `wh_test`, applies every migration, creates one login role per White House role (`wh_test_agent`, `wh_test_gateway`, `wh_test_ui`, test-only password) and runs every `test/*.test.js`. No test calls the model API or PostHog: the model is a scripted driver and HTTP is stubbed.

`DATABASE_URL` must be a superuser on a server you can throw away: the setup drops `wh_test`.

## Run it locally

All from `white-house/runner/`, against the same throwaway Postgres. `PG` is the superuser, used only to migrate and seed.

```sh
PG=postgres://postgres:postgres@localhost:55432

# 1. A development database, its schema, and a login for each role (local passwords only).
docker exec wh-pg-dev psql -U postgres -c "create database wh_dev"
npm run build
DATABASE_URL=$PG/wh_dev npm run migrate
docker exec wh-pg-dev psql -U postgres -d wh_dev \
  -c "create role wh_dev_agent login password 'dev-only' in role wh_agent" \
  -c "create role wh_dev_gateway login password 'dev-only' in role wh_gateway" \
  -c "create role wh_dev_ui login password 'dev-only' in role wh_ui" \
  -c "grant connect on database wh_dev to wh_dev_agent, wh_dev_gateway, wh_dev_ui"

# 2. Seed tenant one. The owner's name and email come from the environment, never from the repo.
DATABASE_URL=$PG/wh_dev WH_OWNER_NAME="..." WH_OWNER_EMAIL="..." npm run seed
#    It prints WH_TENANT_ID=... and the name of the variable the model key is read from.

# 3. Start the runner (127.0.0.1:8080).
export WH_API_TOKEN=<any long random string, shared with the site's server>
export WH_TENANT_ID=<printed by the seed>
export DATABASE_URL_GATEWAY=postgres://wh_dev_gateway:dev-only@localhost:55432/wh_dev
export DATABASE_URL_UI=postgres://wh_dev_ui:dev-only@localhost:55432/wh_dev
export DATABASE_URL_AGENT=postgres://wh_dev_agent:dev-only@localhost:55432/wh_dev
export ANTHROPIC_API_KEY_SALEKH=<the tenant's key>          # without it, /run answers 409 no_api_key
export POSTHOG_PERSONAL_API_KEY=<read key> POSTHOG_PROJECT_ID=<id>   # optional: Data pulls traffic totals
npm start

# 4. Look at the house, and start a run.
curl -s -H "Authorization: Bearer $WH_API_TOKEN" localhost:8080/v1/house
curl -s -X POST -H "Authorization: Bearer $WH_API_TOKEN" localhost:8080/v1/rooms/salekh-ventures:data/run
curl -s -X POST -H "Authorization: Bearer $WH_API_TOKEN" -H 'content-type: application/json' \
  -d '{"brief":"What do small UK businesses publish about choosing a web studio?"}' \
  localhost:8080/v1/rooms/salekh-ventures:research/run
```

### Environment

| Variable | What |
| --- | --- |
| `WH_API_TOKEN` | Bearer token for `/v1/*`. Unset: the API routes are not started, health check only |
| `WH_TENANT_ID` | The tenant this runner serves (one runner per tenant) |
| `DATABASE_URL_GATEWAY`, `_UI`, `_AGENT` | One login per database role. Never a superuser |
| `ANTHROPIC_API_KEY_<TENANT SLUG>` | The tenant's model key, for example `ANTHROPIC_API_KEY_SALEKH`. The only credential an agent process is given |
| `WH_USD_TO_GBP` | Dollars to pounds for the budget. Default 0.79, a PLACEHOLDER until Salekh settles the rule |
| `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_HOST` | Read key with Query Read, project id, host (default `https://eu.posthog.com`). Read by the runner only |
| `HOST`, `PORT` | Default `127.0.0.1` and `8080`. The Dockerfile sets `HOST=0.0.0.0` |
| `WH_ROOT` | The `white-house/` folder. Default: two levels above `dist/` |

### The Outreach room (prospecting)

`POST /v1/rooms/salekh-ventures:outreach/run` runs one batch: find, analyse, score, shortlist. Nothing is sent to anyone. The result is one output, "Shortlist, <date>".

Code does the searching and reading (through Agent Reach), the deduplication, the suppression check, Companies House, the filters, the score and the comparison with local competitors. A model is called at three fixed points only, one call at a time with no tools: `claude-haiku-5-5` to pick the real businesses out of the search results, `claude-haiku-5-5` to read one business's pages, and `claude-sonnet-5-5` to draft the card for each one that passed.

| Variable | What |
| --- | --- |
| `AGENT_REACH_BIN` | Path to the Agent Reach binary, for example `~/.local/bin/agent-reach` written out in full. Unset: the find stage stops with "the search tool is not configured" |
| `COMPANIES_HOUSE_API_KEY` | Companies House public data API key. Unset: every company is "not checked" and the run still goes ahead |

Settings are config (`kind = 'setting'`, `key = 'outreach'`), changed by an owner through the UI's role: the kind of business, the territory, the list of places worked through a few each run, the front desk roles searched for in job adverts, how many businesses to look at (50), the filter rules and the score weights. The defaults and the meaning of each are in `src/outreach/settings.ts`; the score formula is at the top of `src/outreach/score.ts`.

```sh
# Counts per stage for a range of days (default: the last seven).
npm run prospect-stats -- 2026-11-16 2026-11-23
```

Until the settings screen exists, an owner works the room from the command line. These connect with the UI's role only (`DATABASE_URL_UI`, `WH_TENANT_ID`, from the environment or `runner/.env`):

```sh
# Never to be contacted. Permanent: nothing can change or delete it.
npm run suppress -- example-clinic.co.uk "asked not to be contacted"
npm run suppress -- 01234567 "complaint"

# Print the settings in force, or change them (each change is a new version of config).
npm run outreach-settings
npm run outreach-settings -- --areas-per-run 8 --batch-size 50
npm run outreach-settings -- --exclude-group "Name of a group" --include-group "Name to take off the list"
npm run outreach-settings -- --daily-at 08:00        # or: --daily-at off
```

### Living within the search tool's limits

Agent Reach rate limits itself and may ask for a login. The pipeline reads its error codes and gives way:

- `RATE_LIMITED`: that channel is not called again for the rest of the run, and one event records it with the wait the tool gave.
- `NEED_LOGIN`: that source is left out of the run. Nobody's account is used, so this is "unavailable", not a fault.
- Calls are spaced (`min_seconds_between_fetches`, 1.5) and capped per run (`max_fetches_per_run`, 300). A place's advert searches stop when two in a row bring nothing new.
- A run begins with businesses found earlier and never analysed, and only then looks for new ones, up to the batch size.
- A run cut short still ends in a shortlist from whatever was analysed, and its notes say it was cut short and how many businesses are waiting. It fails (`search_rate_limited`) only when there was nothing at all to work with.
- A scheduled run that failed only on the rate limit is tried once more the same day, after the wait the tool gave (an hour if it gave none), then the scheduler gives up for the day.

### The daily schedule

A room whose schedule config carries `daily_at` (HH:MM, the tenant's time zone, Europe/London by default) is started by the runner itself once that time has passed, at most once a day. The runner looks every minute. Before starting, it writes a `scheduled` event for that room and day, which is what stops a restarted runner doing the day twice. If the run cannot start (kill switch, budget) a second event says why and the day is not tried again. Needs migration 0008.

### Other commands

```sh
# One room's daily budget, until the settings screen exists.
DATABASE_URL_UI=... WH_TENANT_ID=... npm run budget -- salekh-ventures:research 1.50

# A department's eval cases against the real model. One model run per case: it costs money.
ANTHROPIC_API_KEY_SALEKH=... npm run evals -- salekh-ventures data
```

## Test enquiries by email

The Outreach room can send one short test enquiry to a business, by email, from a test mailbox, after Salekh has approved that exact message. Nothing else is ever sent.

```sh
# runner/.env (never printed, read only by the runner process)
TEST_MAILBOX_ADDRESS=...            # a Gmail address used for nothing else
TEST_MAILBOX_APP_PASSWORD=...       # an app password for it

npm run outreach-settings -- --enquiries-per-day 30 --allow-enquiries yes   # the day's allowance, and rung 1 to rung 2
npm run outreach-settings                                                   # shows the allowance, the rung and the rules in force
npm run prospect-stats -- 2026-11-16 2026-11-23                             # proposed, approved, rejected, sent, replied, scored
```

Without both mailbox variables no enquiry is drafted, sent or read, and the shortlist says so. Every ten minutes while the runner is up, and at the start of each run, the mailbox is searched for replies to the enquiries this system sent and for nothing else. The setting `test_enquiries: false` switches the whole thing off. The assumptions behind the estimated leak are in the `leak_assumptions` setting and are placeholders to edit.

## Google Places

`GOOGLE_PLACES_API_KEY` in `runner/.env` makes Places the main way to find businesses. Without it they are found by web search. Every call is a Text Search billed in the Enterprise tier (the field mask is in `src/control/connectors/places.ts`); `max_places_calls_per_run` (default 20) limits calls, and each run's output says how many were made.

## Reading pages

A business's own pages are read directly by the runner (`src/control/connectors/direct-read.ts`): public addresses only, robots.txt obeyed, bot checks left alone. Agent Reach `web read` is the fallback for pages that give almost no text. `DIRECT_READ=off` goes back to Agent Reach alone.

## Test enquiries that send themselves

`npm run outreach-settings -- --enquiry-rung 3` (the owner's switch; `2` goes back to "each needs your yes"). At rung 3 a test enquiry is queued, given one of three slots (working hours, a weekday evening, the weekend) so each kind of business is tested evenly across them, checked again in the moment before it goes, and sent in its slot between 07:00 and 21:30, 90 seconds apart, inside the daily cap. An enquiry sent while a business was shut is scored on whether anything useful came back before it next opened. Sending stops for the day after more than three failed sends or bounces, any reply that reads as a complaint, or a refused mailbox login. Bank holidays are not known to the system: add them to `non_working_dates`. See `DEPLOY.md` for the server.

## Kinds of business

The Outreach room looks for several kinds of business (`business_types` in its settings): clinics, solicitors, financial advisers and mortgage brokers, estate and letting agents, accountants, and home improvement trades. Each has its own search phrases, groups, enquiry guidance, forbidden topics and leak assumptions (all placeholders until edited). Online shops are left out on purpose.

```sh
npm run outreach-settings                                   # lists every kind, on or off, with its rules
npm run outreach-settings -- --enable-type solicitors       # or --disable-type id; "all" for every kind
npm run outreach-settings -- --exclude-group "Name" --type solicitors
npm run restore-filtered -- --since 2026-11-16              # businesses dropped before testing for want of a name or a confirmed company
```

Settings stored before there were several kinds keep working: clinics on, the rest off, until one is switched on.

## Deploying

See `DEPLOY.md`: the variables the service needs and the order to do things in. The container sets its own database up at start (`dist/start.js`, then the server as an ordinary user). `WH_ROLE=standby` makes a runner that starts no runs, sends nothing and does not read the mailbox: exactly one runner may be primary for a mailbox. `npm run export-config` prints the non-personal configuration to carry to another database.

**Open risk: there is no tested backup of the server's database.** See the end of `DEPLOY.md`.

## Before any deploy: check the schemas

```sh
npm run build && npm run check-schemas     # needs ANTHROPIC_API_KEY_SALEKH (environment or runner/.env); costs a fraction of a penny
```

It sends every structured-output schema the pipeline uses to the real API and prints pass or the API's own error for each. Tests never call the API, so this is the only thing that can tell you a schema will be refused. Run it after any change to a schema in `src/outreach/stages.ts`. It exits 1 if any fails.

If analyses failed through a fault of ours, `npm run reset-attempts` sets the attempt count back for businesses still waiting, and `npm run reset-attempts -- --restore-failed-since YYYY-MM-DD` also puts back those set aside as `analysis_failed` since that day.

## Migrations

Plain SQL in `white-house/db/migrations/`, applied in name order, each once. A file that has been applied is never edited: write a new one. Run as the owner of the database, as a deliberate step. The runner container does not run migrations and its image does not contain them.

## Where things are

| Path | What |
| --- | --- |
| `API.md` | The HTTP contract with the house UI |
| `src/server.ts` | HTTP: health check, token check, routes |
| `src/runtime.ts` | The house snapshot, scores, approvals, kill switch, and agent runs |
| `src/agents/departments.ts` | Which department types have an agent, their model, turn limit and tools |
| `src/agents/session.ts` | One run's working copy, environment and allow list |
| `src/agents/tools.ts` | The in-process tools an agent has |
| `src/agents/sdk-driver.ts` | The Claude Agent SDK call. The only file that imports the SDK |
| `src/agents/scripted-driver.ts` | The fake driver every test uses |
| `src/control/` | The control layer: gateway, approvals, config, runs, events, connectors |
| `src/control/connectors/posthog.ts` | Read only traffic totals |
| `src/jobs/pull-traffic.ts` | Plain code: totals into `metrics` |
| `src/outreach/pipeline.ts` | The prospecting pipeline, stage by stage |
| `src/outreach/stages.ts` | The three single model calls and the code that checks their answers |
| `src/outreach/store.ts` | The master list: dedupe, suppression, analysis, score, competitors, purge, numbers |
| `src/outreach/score.ts`, `settings.ts`, `normalise.ts`, `extract.ts` | Filters and score, settings, dedupe keys, what code reads off a page |
| `src/control/connectors/agent-reach.ts`, `companies-house.ts` | Search and page reading; the Companies House register |
| `src/agents/model-caller.ts` | One structured model call (Anthropic SDK), and the scripted stand-in tests use |
| `src/evals/` | Eval runner and its command line |
| `src/seed.ts`, `src/set-budget.ts`, `src/migrate.ts` | Seed, budget and migration commands |
