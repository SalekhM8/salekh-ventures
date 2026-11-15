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

### Other commands

```sh
# One room's daily budget, until the settings screen exists.
DATABASE_URL_UI=... WH_TENANT_ID=... npm run budget -- salekh-ventures:research 1.50

# A department's eval cases against the real model. One model run per case: it costs money.
ANTHROPIC_API_KEY_SALEKH=... npm run evals -- salekh-ventures data
```

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
| `src/evals/` | Eval runner and its command line |
| `src/seed.ts`, `src/set-budget.ts`, `src/migrate.ts` | Seed, budget and migration commands |
