# Deploying the runner

The image is built from `white-house/Dockerfile` with `white-house/` as the build context. It needs no shell access and no manual database step: everything the database needs is done by the container when it starts.

## What happens at start

`CMD` is `node dist/start.js`. It does two things, in two processes:

1. **Setup, as root, once per start** (only when `DATABASE_URL_ADMIN` is set). Under a database lock, so two instances cannot do it together:
   - applies any migration not yet applied (the files are in `/opt/white-house-db/migrations`, readable by root only);
   - creates or updates three logins, `wh_live_agent`, `wh_live_gateway` and `wh_live_ui`, each a member of one White House role and nothing else, with the passwords given;
   - seeds the tenant (with the id in `WH_TENANT_ID`), its floors, rooms, default budgets, the outreach settings and schedule, the enquiry cap and rung. It only ever adds what is missing;
   - **on the first boot only** (the tenant has no outreach settings yet), applies `WH_BOOTSTRAP_CONFIG` in place of the defaults.
   If any step fails it prints one line starting `BOOTSTRAP FAILED` (never a URL or a password) and exits 1. The server is not started.
2. **The server, as uid 1000**, with `DATABASE_URL_ADMIN`, `WH_BOOTSTRAP_CONFIG` and every variable like them (`DATABASE_URL`, `PGPASSWORD`, `POSTGRES_PASSWORD` and so on) taken out of its environment. It builds its three connection URLs from `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME` and the three passwords, then removes the passwords from its own environment too. Agent runs are given a bare environment, as before.

## Environment variables

Names only. **S** marks a secret.

| Variable | | What it is |
|---|---|---|
| `DATABASE_URL_ADMIN` | **S** | The database owner's private URL (`postgres://postgres:...@...railway.internal:5432/railway`). Used by the setup step only. |
| `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME` | | The private host, port and database name. The server builds its own three URLs from these. |
| `WH_DB_PASSWORD_AGENT`, `WH_DB_PASSWORD_GATEWAY`, `WH_DB_PASSWORD_UI` | **S** | Three different passwords, 16 characters or more each. You invent them. Changing one and restarting changes the login's password. |
| `WH_TENANT_ID` | | The tenant's uuid. Use the one from the local machine so the two match. |
| `WH_OWNER_NAME`, `WH_OWNER_EMAIL` | **S** (personal) | The owner, for the seed. Never in the repo. |
| `WH_BOOTSTRAP_CONFIG` | | Optional. One line of base64 from `npm run export-config -- --base64`. Used on the first boot only; harmless to leave, tidier to remove afterwards. |
| `WH_API_TOKEN` | **S** | 32 characters or more. The site's server sends it as a bearer token. A shorter one is refused on a public address. |
| `WH_TRUST_PROXY` | | Set to `1` on Railway, so failed logins are counted per caller and not per proxy. |
| `WH_ENQUIRY_RUNG` | | **The owner's switch.** `2`: each test enquiry needs a yes. `3`: test enquiries send themselves, inside the daily cap, the sending hours and the checks. Applied at each start as a new version of the rung in the owner's name, only when it changes something. Anything else stops the start. Unset: the rung is left where it is. |
| `WH_OUTREACH_ENABLED_TYPES` | | Optional. A comma separated list of kinds of business to have switched on, and every other kind off: `clinics,solicitors,financial-advisers,estate-agents,accountants,trades`. Applied at each start, as a new version of the settings only when it changes something. Unset: the kinds are left as they are. This is how a kind is switched on the server, which has no shell. |
| `WH_ROLE` | | `primary` (the default) or `standby`. Exactly one runner may be primary for a given test mailbox. |
| `ANTHROPIC_API_KEY_SALEKH` | **S** | The tenant's model key. |
| `GOOGLE_PLACES_API_KEY` | **S** | Finding businesses. Without it and with no search tool, Outreach cannot run. |
| `TEST_MAILBOX_ADDRESS`, `TEST_MAILBOX_APP_PASSWORD` | **S** | The test mailbox. Set on the primary only. |
| `COMPANIES_HOUSE_API_KEY` | **S** | Optional. Without it companies are "not checked". |
| `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_HOST` | **S** (the key) | Optional. Traffic totals for the Data room. |
| `WH_USD_TO_GBP` | | Optional. Without it a placeholder rate is used and said so in the log. |
| `PORT` | | Set by Railway. |
| `HOST` | | `0.0.0.0`, already set in the image. |

Do **not** set on this service: `AGENT_REACH_BIN` (the tool is not in the image; job adverts are simply not searched on the server and the shortlist says so once), `DATABASE_URL` (if Railway offers to inject it, decline: the server strips it anyway), `WH_BOOTSTRAP` (only for running the setup inside the server process, which the image does not do), `WH_RUN_UID`/`WH_RUN_GID` (default 1000, the image's `node` user).

## Order of operations

1. **Before anything, on the Mac:** `npm run build && npm run check-schemas`. All five must pass.
2. **On the Mac, with nothing waiting to be sent:** reject or let expire any enquiry approvals still pending in `wh_dev`, and do not approve any more there. See "Starting with an empty list" below.
3. **Export the settings:** `npm run export-config` to read them, then `npm run export-config -- --base64` for the one line to paste. It prints on stderr how many suppressions it left out (those that are about people). If that number is not 0, add them on the server by hand.
4. **Set the variables** in the table on the Railway service. `WH_ROLE` unset or `primary`.
5. **Deploy.** Watch the log for one line: `bootstrap: <n> migrations applied, 3 logins set, tenant ready, ...` (11 migrations on a first boot; on a database already set up, only the new ones). Then `white-house-runner listening on 0.0.0.0:<port> (API v1 on)`.
6. **Check:** `GET /health` answers `{"status":"ok"}` with no token. `GET /v1/house` answers 401 without the token and the house with it.
7. **Set the Mac to standby:** `WH_ROLE=standby` in `runner/.env`, restart the local runner. From then on it starts no runs, sends nothing and does not look in the mailbox.
8. **Point the site's server** at the Railway URL with the same `WH_API_TOKEN`.
9. Optional: remove `WH_BOOTSTRAP_CONFIG`. A second boot ignores it anyway.

A later deploy needs nothing special: the setup runs again, applies any new migration, writes the outreach settings again if they are in an older shape (the log line then ends "outreach settings written again for 1 room"), and changes nothing else. **A server whose settings were carried over before there was more than one kind of business has clinics switched on and every other kind off: set `WH_OUTREACH_ENABLED_TYPES` to switch the others on.**

## Starting with an empty list

The server starts with no businesses on its master list. That is deliberate, and safe as long as these hold:

- **Nothing sent from the Mac is unknown to the server.** "One enquiry per business, ever" is kept in each database separately. If an enquiry has been sent from the Mac, the server does not know and could send the same business a second one. Before switching, confirm `select count(*) from enquiries where status in ('sent','sending','failed')` is 0 in `wh_dev`. If it is not, those businesses must be suppressed on the server first (by domain), and their replies will only be read by the Mac.
- **Pending approvals on the Mac are dead.** A standby refuses them (409 `standby`). They expire after 24 hours.
- **Suppressions about people are not carried** (email addresses, phone numbers). The export says how many it left out.
- The rotation through places starts again from the top, so the first runs repeat Places calls already paid for locally. A small cost, not a risk.

## Not done: backups

**There is no backup beyond whatever Railway's volume gives, and point-in-time recovery (BRIEF) is not confirmed.** Nothing in this code takes a backup: it has nowhere to put one. This is an open risk. What would close it: either Railway's own backups switched on for the Postgres service and a restore actually tried once, or an object store (a bucket) to which the runner writes a nightly `pg_dump`, with a restore tried once. Until then, a lost volume loses the master list, every suppression and the audit trail.

## Enquiries that send themselves

With `WH_ENQUIRY_RUNG=3`, the log line at start ends "test enquiries set to rung 3 (sent without asking)". From then on:

- Enquiries already waiting for a yes are withdrawn (never approved) and, if they pass today's checks, queued. The rest are closed unsent.
- Sending happens only on working days between 09:00 and 17:30 London time, 90 seconds apart, up to the daily cap. The daily run at 08:00 queues; sending starts at 09:00. **Bank holidays are not known to the system**: add dates to `enquiry_no_send_dates` in the outreach settings (there is no command for that yet on the server; carry it in the settings).
- Each shortlist opens with how many were sent without asking. The full text of each is at `GET /v1/rooms/salekh-ventures:outreach/enquiries` (with the token; personal data).
- Sending stops for the day, and the shortlist opens with the reason, after more than three failed sends or bounces, any reply that reads as a complaint, or the mailbox refusing the login.
- To go back: set `WH_ENQUIRY_RUNG=2` and redeploy. Anything queued then waits for a yes. The kill switch (`POST /v1/kill-switch`) stops all sending at once without a deploy.

