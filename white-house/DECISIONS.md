# Decisions

Every decision made during the build, with the date and the reason (BRIEF.md section 1, instruction 8). Newest at the bottom. Nothing here is changed after the fact: a reversal is a new entry.

Status key: **Decided** (Salekh said so), **Found** (established by inspection, Salekh to confirm), **Open** (waiting on Salekh), **Build** (made by the build agent within the brief, reversible).

---

## Section 17 decisions

### 1. Site stack and host. Found, 12 Nov 2026

Salekh's answer was left as a placeholder. From the repo:

- Next.js 16.2.6 (App Router), React 19.2.4, TypeScript, Tailwind v4, GSAP, framer-motion, Lenis.
- Hosted on Vercel, project `palmer-clone`, repo `SalekhM8/salekh-ventures`, branch `main`.
- The site has no auth and no database today. Server actions send email through Resend.

Consequence: the "auth provider already in use" (section 11, private UI) does not exist on this site. ROOTS uses Clerk. See open item A.

### 2. Runner host. Open, 12 Nov 2026

Salekh's answer was left as a placeholder. Recommendation: **Railway**, one always on service built from `white-house/Dockerfile`.

Reason: an always on container with a Dockerfile deploy and a secret store is all the runner needs, the Railway CLI is already installed on Salekh's machine, and billing is by usage so an idle runner is cheap. Railway's docs list $10 per GB of RAM and $20 per vCPU per month, charged by the second on what is used. A 4 GB, 2 vCPU service pinned flat out all month would be about $80, so the brief's "roughly £30" holds only if the runner is idle most of the day, which is the design. Replace with the real figure after a week. Region to be checked against data residency before ROOTS data of any kind goes through it.

### 3. Scheduling. Open, 12 Nov 2026

Salekh's answer was left as a placeholder. Recommendation: **Inngest**, with the runner serving its jobs over HTTP.

Reason: checked against Inngest's usage limits page on 12 Nov 2026. A step may run for up to 2 hours unless the host cuts it off sooner, and an always on container does not. The free plan allows 5 concurrent steps and 50,000 executions a month, both well above this system's volume (the container itself only fits two or three agent runs at once). It is already in use at ROOTS. The fallback in the brief (a Postgres backed queue inside the runner) stays available if Inngest becomes a problem.

### 4. Approvals. Decided, 12 Nov 2026

Through the app, with Telegram as Salekh's backup while it is built.

### 5. Floors at launch. Decided, 12 Nov 2026

ROOTS, Mastore, Twilight, Salekh Ventures. Salekh's answer did not mention deal sourcing, so it stays "possibly later" as the brief has it.

### 6. API budget. Decided, 12 Nov 2026

£300 a month, hard limit $500.

### 7. Does ROOTS talk to customers on WhatsApp today? Open, 12 Nov 2026

Salekh's answer was left as a placeholder. Evidence only, not an answer: a search of the ROOTS codebase found no WhatsApp link, number or API call. That does not rule out WhatsApp being used by hand from a phone.

### 8. Do ROOTS PostHog events contain anything about a person's health? Open, 12 Nov 2026

Salekh's answer was left as a placeholder. Evidence only, from a quick search of the ROOTS code, not an audit of what is stored in PostHog:

- Four custom events (`checkout_form_started`, `checkout_pay_pressed`, `checkout_error` twice) plus a manual `$pageview`.
- URLs are reduced to the path only, and clinical routes (consultations, account, admin, auth) are stripped completely.
- Session recording is off by default, started on marketing pages only, with inputs masked.
- `posthog.identify(userId)` is called, so events are tied to a person.

Point for Salekh and the pharmacist to settle: no health answers are sent, but an identified person moving through a weight loss treatment funnel (a path such as a dose selection page) may itself count as data about health. The brief already restricts ROOTS Data to counts and totals, which is the right default either way.

---

## Build decisions, phase 0

### B1. Where `white-house/` sits. Build, 12 Nov 2026

At the repo root, beside `src/`, exactly as section 7 lays out. It is a separate project: its own `package.json` (in `runner/`), its own TypeScript config, its own `.gitignore`.

### B2. Keeping the site and the runner apart. Build, 12 Nov 2026

Three small changes to the site so the two cannot interfere:

- `tsconfig.json`: `white-house` added to `exclude`. The site's config includes every `.ts` file in the repo, so without this the site build would type check the runner.
- `eslint.config.mjs`: `white-house/**` added to the ignore list.
- `.vercelignore`: `white-house` is not uploaded to Vercel. The site imports nothing from it.

Reason: standing instruction 6.

### B3. Runner image. Build, 12 Nov 2026

`white-house/Dockerfile`, built with `white-house/` as the whole build context. Inside the image the tree is `/white-house/{CLAUDE.md, agents, skills, businesses, runner}` with nothing above it, so no parent CLAUDE.md can load into a run. `BRIEF.md`, `DECISIONS.md`, `evals/` and `db/` are left out of the image: they are not agent context and agents must never read or edit them. The process runs as a non root user.

### B4. The empty runner. Build, 12 Nov 2026

Node 22, TypeScript, no runtime dependencies. One HTTP server answering `GET /health`. No scheduler, no agents, no gateway, no credentials. The Agent SDK is not installed yet (current npm release on 12 Nov 2026 is 0.3.322; it gets pinned when the first agent is built, after reading the changelog).

### B5. Department folders. Build, 12 Nov 2026

Only departments listed "at launch" in section 4 have folders. ROOTS Customer Relations and Engineering are not created until their phase. Every department and business CLAUDE.md is a placeholder holding only facts taken from the brief. Nothing about voice, pricing, clients or compliance wording has been written, because none of it has been supplied.

### B6. Model strings. Build, 12 Nov 2026

`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`. These are the complete identifiers: they take no date suffix, so the bare string is the exact pin.

---

## Section 18 checks done in phase 0

| Item | Result | Source and date |
| --- | --- | --- |
| API prices | Match the brief. Opus 5.5 $4 and $20, Sonnet 5.5 $2 and $10, Haiku 5.5 $0.10 and $0.50 up to 100,000 tokens then $0.50 and $2.50. Cache reads $0.20 on Opus 5.5 and $0.10 on Sonnet 5.5, which is 5% of input. Default cache life 5 minutes | Anthropic's API reference bundled with Claude Code, dated 3 Nov 2026. Not re-read on the live pricing page: confirm in the console when the workspaces are created |
| Model version strings | As B6 | Same |
| Fable and Mythos need 30 day retention | Confirmed | Same |
| Inngest limits for jobs lasting minutes | Fine. Step limit 2 hours, free plan 5 concurrent steps | inngest.com/docs/usage-limits/inngest, 12 Nov 2026 |
| Agent SDK resources per run | 1 GiB RAM, 5 GiB disk, 1 CPU as a starting point, as the brief says | Anthropic's Agent SDK hosting page, 12 Nov 2026 |
| Container host pricing | Railway: $10 per GB RAM, $20 per vCPU per month, by usage | docs.railway.com/pricing/plans, read through a search summary, 12 Nov 2026. Confirm on the pricing page before signing up |
| Database pricing | **Not checked.** Depends on open item B | |

---

## Open items raised by the build agent

**A. Login for the private UI.** The brief says to use "the auth provider already in use", but this site has none. Suggested: Clerk, because ROOTS already uses it and it has two factor. Needed before phase 3, and it shapes the `members` table in phase 1.

**B. Where the White House database lives.** The brief says its own Postgres with point in time recovery from day one, and row level security. Suggested: Neon, a new project separate from ROOTS, because Salekh already uses it and recovery is built in. Pricing and the recovery window on the plan chosen are not yet checked. Needed before phase 1.

**C. The existing site content.** The landing page is rebuilt around the house in phase 3. Until then the current studio offer, pricing tiers, journal and `/sync` page stay live unchanged. Say if any of it should come down sooner.

**D. This build session runs on Claude Fable 5.2.** The brief bars anything touching patients from Fable and Mythos models. So no patient level ROOTS data is to be pasted into, or pulled by, this build session at any phase.

---

## 12 Nov 2026, later: Salekh said go

Salekh's words: "get to work go on go go go!! wanna see some ui/ux today and other bits also, whatever structure is best".

### G1. Open structural choices settled by delegation. Decided, 12 Nov 2026

"Whatever structure is best" is taken as accepting the build agent's recommendations. Salekh can reverse any of them:

- Runner host: Railway (decision 2).
- Scheduling: Inngest, with the Postgres queue as fallback (decision 3).
- Private UI login: Clerk (open item A).
- White House database: a new Neon project, separate from ROOTS (open item B). Local development and tests use a throwaway Postgres in Docker.

Decisions 7 and 8 (ROOTS WhatsApp, ROOTS PostHog health data) stay open. Neither blocks phase 1. Decision 8 must be answered before ROOTS Data reads PostHog in phase 2.

### G2. Phase 1 started with the phase 0 check still open. Decided, 12 Nov 2026

The phase 0 check (Meta token pulls ROOTS figures, a call works on each workspace key, runner deployed) needs Salekh's logins and has **not** passed. On Salekh's instruction the build goes ahead with the parts of phase 1 that need no credentials: migrations, the gateway, approvals, config and their tests, all against a local database. Nothing is deployed and no outside system is touched. The phase 0 check still has to pass before phase 2.

### G3. Design pass brought forward. Decided, 12 Nov 2026

Salekh asked to see UI today. The design pass from phase 3 (design system, then the house, room, approvals, digest and ask screens on phone and desktop) is done now as designs for sign off. No UI is coded in the site until he has signed the designs off (standing instruction 9). The designs show sample states, clearly marked as samples. The built UI will run on the real event stream only.

### G4. Local prototype of the house. Decided, 12 Nov 2026

The design canvas did not load for Salekh and he asked for it to run on localhost, in the Salekh Ventures look (black, white, Inter) with Motion. A prototype now lives in the site at `src/app/house/page.tsx` and `src/components/house/HouseScene.tsx`, at `/house`, marked no index. The `motion` package was added to the site. It runs a sample simulation in the browser and says so on screen: no agents, no real data, no connection to the runner. It is a design prototype for sign off, not the built UI. The built UI still has to run on the real event stream (BRIEF.md section 13), and the simulation code is removed when it does. Not committed, not deployed.

---

## Phase 1 build decisions, 12 Nov 2026

Made by the build agent while building the core and control layer (BRIEF.md sections 3, 6, 8, 9 and phase 1 of section 17). All are **Build** status: within the brief, reversible, for Salekh to confirm. Items marked **Open** need his answer.

### What was built

Migrations for every table in section 9, a migration runner, the event emitter, run records with cost capture and department budgets, versioned config, the gateway and approvals, with one dummy action type and an in-memory dummy connector. 98 automated tests against a real Postgres 17, passing on Node 20 and Node 22. Nothing deployed, no real connector, no credential, no agent.

### P1. Tests first, with one honest caveat

The control layer's tests were written before the control layer (standing instruction 3). They were not run red against an empty implementation, because every test file imports the compiled control layer and would only have failed at import. Instead, after they passed, each guard was removed in turn from the compiled code and the suite rerun: kill switch, key check, expiry, wrong account, payload hash, stored payload check, cap, run budget, gateway budget, hard ceiling, single use, demotion, rung 1, and one event. Every removal made at least one test fail. Reason: that shows the tests can fail for the right cause, which is the point of writing them first.

### P2. `tenant_id` and `business_id` on every table

Every table has both columns. `business_id` is NULL where a row belongs to the whole tenant or the whole house (a member, a device, the global kill switch, a Chief of Staff run or budget). On `tenants` the `tenant_id` is the primary key and `business_id` is always NULL (a check enforces it); on `businesses` the `business_id` is the primary key. A row's business must belong to the row's tenant, enforced by a composite foreign key. Reason: the brief says every table carries both, and one uniform shape lets a single test check all of them.

### P3. Row level security

Each connection opens a transaction and sets the tenant for that transaction (`app.tenant_id`). Every table has row security enabled and forced, with a restrictive policy that the row's tenant must equal that setting, and a permissive policy for the three White House roles only. No tenant set means no rows. Reason: it fails closed, and it works through a connection pooler because the setting lasts one transaction. Limit to know about: a role could set another tenant's id itself, so this guards against mistakes in our own code, not against a hostile holder of a database login. The real wall between clients is section 15's one database per client.

### P4. Three database roles, privileges by column

`wh_agent`, `wh_gateway`, `wh_ui`, none able to log in; each deployment creates login roles as members and keeps the passwords in the secret store. No role has DELETE on anything.

- `wh_agent` reads `metrics` and approved `memory_notes`, inserts into `proposals` and `queue_items`, and nothing else. It cannot even read `config_versions`, `actions`, `approvals` or `events`.
- `wh_gateway` writes actions, approvals, events, runs and the ledger. On `config_versions` the database lets it insert only two things: engaging a kill switch, and a rung lower than the current one. It cannot resume, raise a rung, or touch caps, budgets, targets or schedules.
- `wh_ui` writes config and records approval answers. It cannot insert an action or mark an approval used.
- Nobody can update `approvals.payload` or `approvals.payload_hash`, `actions.input`, `proposals.payload`, an event's summary, or any config row.

Reason: section 9 asks for the agent role; the rest puts rules 1 and "resuming needs the UI" into the database, where a bug in the runner cannot get round them.

### P5. A `proposals` table, which section 9 does not list

Added. One row per submission to the gateway, including refused ones, with the gateway's decision. Reason: section 9 says the agent role can "insert proposals" and section 8 speaks of "the proposal tables", but the only listed table holding a proposal is `approvals`, which the agent role must not write. Rung 1 ("the proposal is stored") also needs somewhere to store it that is not an approval. `approvals` and `actions` both point back to their proposal.

### P6. Idempotency

The action key is claimed at the brief's seventh check, under a lock, backed by a partial unique index on `proposals` and a unique constraint on `actions (tenant_id, action_key)`. A second submission is refused with `duplicate_key`. A key that was only ever refused (for example over the cap) is not used up and may be submitted again. A key whose execution failed is used up: the outside system may have changed, so it is never retried blind. Keys are per tenant.

### P7. Check order and what each refusal does

The eight checks run in the brief's order and the first failure refuses. All eight run at rung 1 as well, so a recommendation that would break a cap is refused, not stored as a recommendation. A missing cap or a missing department budget refuses (fail closed). Unknown floor is refused before a proposal row is written, because there is no floor to attach it to; it is still an event.

### P8. Hard ceilings

Each action type carries `maxRung` in code. The gateway uses the lower of config and ceiling, so config above the ceiling has no effect, and the UI path refuses to promote past it. Only rungs 1 to 4 are modelled: the brief's "None, routed to the pharmacist" row has no action type yet and will need a routing path of its own when ROOTS clinical work is built. Ceilings that depend on the floor or on the content (a ROOTS ad mentioning a prescription only medicine) are not modelled yet: the plan is a separate action type with its own ceiling, to settle in phase 2.

### P9. Caps

Every action type names one cap and how many units a payload uses. The limit is config (kind `cap`) per floor. Usage is the sum over that floor's `actions` rows in the window (the tenant's calendar day, or the last hour), counting failed executions too, compared with a live figure from the connector where it offers one; the higher is used, and a live read that errors refuses the action. The check and the action row share one transaction under a lock, so simultaneous actions cannot both squeeze under. Pending approvals do not reserve cap; the cap is checked again when the yes is carried out. Per customer caps are not built: no action type needs one yet.

### P10. Approvals

- Recording an answer (`decideApproval`) is separate from carrying it out (`executeApproval`), because the UI can record a yes but only the gateway holds a connector. `answerApproval` does both.
- A yes must carry the approval id and the payload hash the person saw. The hash is sha256 over JSON with sorted keys, since Postgres does not keep key order.
- At execution the stored payload is hashed again and must match both the stored hash and the hash that was approved. If not, the approval is voided and nothing runs.
- **`voided` is a fifth status, beyond the brief's four** (pending, approved, rejected, expired). Reason: none of the four describes "the payload was changed", and hiding it under rejected would lose the fact.
- Wrong account (not a member of that tenant, may not approve, or disabled) is ignored: the approval stays pending and an `answer_refused` event is written.
- Expiry is 24 hours by default. Nothing executes on an approval after its expiry, even if the yes was recorded in time (for example the kill switch was on until after it expired).
- If the kill switch, cap or budget stops an approved action, the yes stands and can be carried out later, before expiry.
- An approved action is always recorded at rung 2, the rung it was approved at.
- "Edit and approve" from section 13 is not built. It will be a new approval for the edited payload.

### P11. Rungs, promotion and demotion

No rung row means rung 1. Promotion is its own call: owner only, UI role only, one rung at a time, never past the ceiling. Showing the evidence first is left to the UI in phase 3. Demotion happens on a failed read back, on a read back that could not be done at all, and when an owner or approver marks an executed action wrong; it drops that action type one rung on that floor, writes a config row marked as made by the system, an event and an alert. A failed execution (the connector threw) does not demote: the brief names read back and marked wrong only. A connector with no read back leaves `verified` NULL and does not demote.

### P12. Kill switch

Stored as config (kind `kill_switch`), global (no business) or per floor; either one stops a floor. Lifting the global one does not lift a floor's own. Engaging works with the gateway role, so `/stop` on Telegram needs no UI; an owner or approver, or the system, may engage. Resuming is owner only and the database refuses it from any role but `wh_ui`. `startRun` also refuses while it is set.

### P13. Runs, cost and budgets

`startRun` refuses when the kill switch is set, when the department has no daily budget, or when it has spent it (spent equal to the limit counts as spent). `finishRun` records tokens in, out and cached and the cost on the run and adds them to `budget_ledger` for the tenant's calendar day (timezone on `tenants`, default Europe/London). A run finished twice is counted once. Budgets are config (kind `budget`, key = department), per floor, or with no floor for a house wide department.

**Open: currency.** Budgets are in pounds and the provider reports dollars. `finishRun` takes the pounds figure from its caller and can store the dollar figure beside it. Nothing here converts, because no exchange rate has been given and one must not be invented. Needed before phase 2 records real costs.

### P14. Events

One table, one ordered sequence number, 26 event types: the brief's eight for runs plus the gateway's and the settings screen's steps. `summary` is a fixed line written by code. `action_type`, `rung` and `reason_code` are fixed codes: an action type name that is not on the list is outside text and is kept out of that column. Full detail goes in `payload`, with `payload_expires_at` 90 days on; `purgeExpiredPayloads` clears payloads past that date and leaves the row. Nothing schedules the purge yet. The emitter also refuses a summary that looks like it holds an email address or a phone number, as a backstop only.

**Open: retention of approvals and actions.** `approvals.payload`, `actions.input`, `actions.output` and `proposals.payload` and `reason` can hold personal data and have no expiry, because they are the audit record of "the exact thing that was approved". The brief sets 90 days only for event payloads. Salekh to say how long the audit record keeps full payloads.

### P15. Notifications

The gateway writes in-app `notifications` rows only (to approvers for an approval, to owners for a rung 3 action, a failure or a demotion). Nothing is delivered: push, email and Telegram come with phase 3. Rung 4 writes none, except that a failed execution or a demotion always tells the owners.

### P16. Connectors and credentials

A connector has `execute`, optional `readBack` and optional `liveCapUsage`. The gateway is built with its connectors and is the only code that holds them. The dummy connector is a Map in memory with switches to make execute or read back fail. There is no credential store yet, because there is no credential.

### P17. Migrations stay out of the runner image

`.dockerignore` still excludes `db/`, and the Dockerfile is unchanged apart from what `npm ci` now installs (`pg`, `zod`). Migrations are run as a deliberate step by the database owner from a developer machine or the deploy pipeline (`npm run migrate`), never by the runner at start. Reason: the runner connects as `wh_gateway`, which cannot alter the schema, and should stay that way. The image was built from `white-house/` alone and checked: no `db/`, `BRIEF.md`, `DECISIONS.md` or `evals/` inside.

### P18. Tooling

`pg` and `zod` are the only runtime dependencies. `engines` relaxed to Node 20 or later so the tests run locally (Node 20) and in the image (Node 22). Tests use `node:test`, in plain JavaScript against the compiled output like the existing health test, with an injected clock for expiry, caps and budget days. `npm test` now needs `DATABASE_URL`, including for the health test.

### Not done in phase 1, on purpose

- Nothing picks up a `proposals` row inserted directly by the agent role; today the gateway writes the row itself when a tool calls `submit`. The grant exists because section 9 asks for it.
- No sweep for an action left in `executing` by a crash between the connector call and the audit update. The row is there and the key is used up, so it cannot run twice, but nothing reports it yet.
- No undo. `undoable` is recorded on each action only.
- "A fresh sign in" for cap raises and promotions is a UI matter for phase 3; the control layer checks the member is an active owner.
- Members are matched to logins by `auth_subject`, to be filled when Clerk is wired in (G1).
- The weekly export of config and point in time recovery (section 9, backups) belong to the hosted database, not built here.

### G5. The house is 3D. Decided, 12 Nov 2026

Salekh rejected the flat line drawing and the Salekh Ventures styling for it. He asked for the real White House in 3D, rotatable, in a lively cartoon style, where clicking the entrance takes you inside and the Chief of Staff gives a summary. This replaces the "illustrated and flat, full 3D is not in version one" line in BRIEF.md section 13.

The prototype at `/house` is now a 3D scene (`src/components/house3d/`), built with three.js through React Three Fiber and Drei, which were added to the site. The building is modelled in code from simple shapes: the south front with the bow, six columns, balustrade and garden stairs, the north portico, and the wings. Windows on the south front are the rooms. It is still a sample simulation with no agents behind it, and the flat prototype was deleted. Not committed, not deployed.

Still to settle: this is a hand-built model, not an architect's. Getting to the detail of a professional render means buying or commissioning a 3D model and loading it in place of the coded one, which is Salekh's call and cost.

### G6. Blocky world, places you can walk to, film branding. Decided, 12 Nov 2026

Salekh's feedback on the first 3D pass: the experience made no sense, the robots should be dressed humanoids, there was no detail, he could only talk to the Chief of Staff and not go to rooms or question anything, transitions were slow, and the dark cards were wrong. He suggested a Minecraft-like character and said to take branding from his dast. films (Fraunces, Inter, cream, ink, coral), which he is not launching elsewhere.

What changed in the prototype at `/house`:

- Blocky voxel style throughout. Agents are block people in suits with a tie in their department's colour.
- Four kinds of place: the grounds (the rotatable house), a floor opened up like a doll's house, a room, and the Oval Office. A Places list on the left reaches any of them in one click, and a trail at the top shows where you are.
- A room shows what it is doing now, the work it has made (each piece can be scored 1 to 10) and what has happened, newest first.
- The Chief of Staff can be asked questions. In the prototype the answers are worked out from the simulation by simple rules, and the screen says so. The real one answers from the log (BRIEF.md section 13).
- Moving between places is a 0.16 second cream fade. The camera no longer flies through the door.
- Panels use the dast. film palette and type.

Stays on three.js in the browser, not a game engine: it has to load instantly on the landing page and run inside the phone app, and a game engine export is too heavy for both.

---

## House API, agent harness and first two departments: build decisions, 12 Nov 2026

Made by the build agent. All are **Build** status unless marked **Open**. Nothing was deployed. **Nothing has run against the real model**: there is no API key yet, and every test uses a scripted driver.

### State of verification when this was written

The last complete test run was 139 tests, 138 passing, on Node 20. The one failure was a test fixture fault (two scores written at the same instant on the fake clock), fixed in the test and confirmed by rerunning the four new test files (all passing). A final complete run could not be made: the machine's disk filled (about 160 MB free of 228 GB), Docker began returning input/output errors, and the throwaway Postgres stopped answering. The Node 22 run and the container image build were not confirmed for this work for the same reason. Rerun `npm test` once space is freed and Docker is restarted before relying on any of it.

### H1. SDK use checked against the documentation, not written from memory

`@anthropic-ai/claude-agent-sdk` pinned at exactly 0.3.322. Option names and behaviour were read on 12 Nov 2026 from the official pages (agent-sdk/typescript, custom-tools, hooks, permissions, cost-tracking, hosting, claude-code-features) and from the type definitions shipped in the package, which the code compiles against. Each run is one `query()` with: `cwd` the department folder; `settingSources: ["project"]` (the documented way to load the CLAUDE.md files in `cwd` and its parents; user and local settings are not loaded); `tools` listing only the built-ins that department may have (none, or web search and fetch for Research); `allowedTools` naming each permitted tool; `permissionMode: "dontAsk"`, which denies anything that would otherwise prompt; a `PreToolUse` hook with no matcher that denies every tool not on the list, with `onFailure: "block"`; `strictMcpConfig: true`; `persistSession: false`; `maxTurns`; the model id; and an `env` of six variables. One spawn check was made with a fixture folder and a key that is not real: the bundled CLI started under that environment, accepted every option and was refused by the API for the key, as expected.

### H2. The agent's environment

`ANTHROPIC_API_KEY` (the tenant's, read from `ANTHROPIC_API_KEY_<TENANT SLUG>` in the runner's environment), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CONFIG_DIR` and `HOME` pointing at a folder made for that run, `PATH`, and `CLAUDE_AGENT_SDK_CLIENT_APP`. Nothing else: no database address, no PostHog key, no API token. Reason: BRIEF.md sections 7 and 10.

### H3. Each run works in a fresh copy with nothing above it

Before a run the harness copies the root `CLAUDE.md`, that business's `CLAUDE.md` and `knowledge/`, and that one department's folder into a new temporary folder, runs there, and deletes it afterwards. Reason: locally `white-house/` sits inside the website's repo, whose own `CLAUDE.md` would otherwise load into every agent (the leak section 7 warns about). It also means a run cannot see another business's or department's files.

### H4. The department's role goes in through the system prompt

`agents/<type>.md` and the department's approved memory notes are appended to the `claude_code` preset system prompt. The root, business and department `CLAUDE.md` files load by the SDK's own mechanism. **Not verified with a real model:** that the three files do load in this configuration, and that the coding-oriented preset suits non-coding departments. Check both on the first real run.

### H5. Tools are scoped in code and use the database roles from phase 1

Five in-process tools: `read_targets`, `read_metrics`, `write_output`, `hand_off`, `propose_action`. Each is built for one run with its tenant, floor and department fixed; the model supplies only fields such as a title or a number of days, and any other field in its input is dropped. Reads of metrics and memory, and writes of outputs and queue items, use the agent role. Events and run records use the gateway role. Targets are read with the gateway role, because phase 1 deliberately gave the agent role no access to config. `propose_action` calls the gateway, where every action type is at rung 1 today, so it is stored only.

### H6. Research

A new department type (section 16). Web search and web fetch are its only way out, and both only read. It has `read_targets` and `write_output` and nothing else: no hand off, no proposals. Its instructions say everything it reads is untrusted data. Model: Sonnet 5.5, **chosen by the build agent** because section 10 has no row for Research. A brief is required for every Research run.

### H7. Which rooms have an agent

A department type has an agent when it is defined in code (`src/agents/departments.ts`), its role file and department folder exist, and config says it is live on that floor (kind `schedule`, value `{"live": true}`). The seed makes three rooms live: salekh-ventures Data, salekh-ventures Research, mastore Research. Data on the other floors is not live: their folders are still placeholders.

### H8. Outputs, scores and memory

New table `outputs` (migration 0006) with the same row security as the rest. The agent role may insert; nobody may update or delete. `scores` gained `output_id`. A score under 9 needs a note (422 without one) and creates a proposed memory note for that department on that floor. A run that ends without an output is recorded as failed (`no_output`): the work is the point. Not done: adding the scored case to the department's test set, which section 10 also asks for.

### H9. Cost and currency

Tokens are taken from the SDK result's `modelUsage` (which covers every model call in the run). Tokens in = fresh input plus cache writes; cached = cache reads. Dollars are stored as the SDK reports them, which the documentation says is an estimate and not a bill. Pounds for the budget are dollars times `WH_USD_TO_GBP`, default 0.79. **That rate is a placeholder** and the currency rule is still open (P13).

### H10. Default budgets

The seed gives each room a daily budget: the monthly figure in section 14, divided by the number of floors with that department at launch, divided by 30, rounded up to a penny (Data £0.09, Creative £0.12, ROOTS Creative £0.29 with the compliance check, Ads £0.32, Engineering £0.30, Customer Relations £0.90, Chief of Staff £1.77). **Research is £0.12, a placeholder equal to Creative's: section 14 has no line for it.** Every row is marked `default` with its basis. Because a run is refused only once the day's budget is already spent, each room gets at least one run a day and then stops. These will need raising for real use: `npm run budget` does it until the settings screen exists. The £32 a month for tests in section 14 is not allocated to any room.

### H11. Seed

`npm run seed` creates the tenant (slug `salekh` unless `WH_TENANT_SLUG` says otherwise), an owner from `WH_OWNER_NAME` and `WH_OWNER_EMAIL` (it refuses to run without them), the four floors, budgets and the live rooms. It sets no rungs, no caps and no targets. Run again, it adds only what is missing and leaves anything already present alone. `tenants` gained a `slug` column for this.

### H12. Traffic totals from PostHog

The connector sits with the gateway's connectors and is used only by plain code. It sends one fixed HogQL query (pageviews, a count of distinct visitors and a count of sessions per day, for named hosts) to `POST /api/projects/:id/query/`, the shape PostHog documents. It accepts only a day and three whole numbers per row, under those four column names when names are given, and rejects the whole result otherwise. The Data room pulls the last 28 whole days at the start of each run; a failed pull is logged and the run goes on. The site's hosts (`salekhventures.com`, `www.`) are in `src/index.ts`. **Not verified against PostHog:** there is no key yet, so the query has never run, and the response's `columns` field is not in PostHog's documentation page (the check is skipped when it is absent).

### H13. The HTTP API

Built to `runner/API.md`. Differences and additions are listed in the report to the coordinator and, in short: ids are opaque strings (`evt_<n>` for events, UUIDs elsewhere); `proposal` also carries `payloadHash`, and `POST /v1/approvals/:id` accepts it back, so that a yes is tied to the payload the person saw (without it the stored hash is used, which weakens that rule); `/run` accepts an optional `{"brief"}` and Research requires one; further 409 reasons `no_budget` and `brief_required`; a yes that was recorded but stopped (kill switch) is carried out by posting approve again. `/v1/house` is a handful of queries, cached for half a second. The server binds 127.0.0.1 unless `HOST` is set; the Dockerfile now sets `HOST=0.0.0.0`.

### H14. The API acts as the tenant's owner

The runner has no notion of who is signed in: the site's server holds the token and the runner records approvals, scores and the kill switch as the tenant's first active owner. Reason: the contract says so, and there is one person. **Before a second person or a client uses it, the site must pass the signed in member and the runner must check it.**

### H15. Evals

One JSON file per case in `evals/<business>/<department>/`, with code checks: must include, must never, must call, must not call, must not fetch. 30 cases: 10 for salekh-ventures Data, 10 each for Research on salekh-ventures and mastore, with attack cases in each (an outside message or page giving instructions, a brief asking it to contact someone, to set a target, for a person's private details, a page asking it to send its instructions elsewhere). In an eval the tools read the case's fixtures and write nowhere, and Research reads the case's fixture pages through in-process tools instead of the live web, so a planted page can be tested. **Every case is synthetic**: there are no real past cases yet, and none has been run against the real model, so some checks may prove too strict or too loose. Results are printed, not yet stored in `eval_runs`. No second-model grading of tone.

### H16. Changes to phase 1 tests

Two assertions in `runner/test/security.test.js` were updated because they count things that grew: the list of tables (now including `outputs`) and the number of migrations (now 6). No phase 1 behaviour changed.

### Not done

- No scheduler: runs start only from `POST /v1/rooms/:roomId/run`. The daily read is not yet daily by itself.
- No Chief of Staff, so `/v1/ask` answers 501 and nothing routes a handoff: it sits in `queue_items`.
- `brief` events are reported in `handoffs` as coming from `chief`, as the contract's example shows, though today the brief comes from the API call.
- A run interrupted by a restart stays `running`; it stops blocking its room after 30 minutes but its cost is lost and nothing reports it.
- Output titles are written by the model and appear in `/v1/house`. Event summaries are fixed lines, but a title could in principle hold personal data.

## First real run, 12 Nov 2026 (evening)

### R1. First agent ran against the real model. Done, 12 Nov 2026

Salekh supplied an Anthropic API key (workspace "White House", organisation limit $50 a month). Data on the Salekh Ventures floor ran end to end: traffic totals pulled from PostHog (33 values), the agent read targets and metrics, wrote a daily read and stopped. Cost recorded: £0.03. The house showed it live, with the log and the report readable in the room. The report correctly said no target is set, that the store was a day behind, and declined to read a trend into very small numbers.

### R2. The key was pasted into the chat. Open, 12 Nov 2026

The key is stored in `runner/.env` (not in git). Because it was pasted into the build chat it should be replaced with a fresh one once things are stable.

### R3. Local database moved off Docker. Build, 12 Nov 2026

The Mac's disk filled during the build and Docker's image store was damaged. The local development database now runs from the Postgres 16 already installed on the Mac, as a private cluster in `white-house/.dev/pg` on port 55432 (ignored by git). All 139 runner tests pass on it. Docker itself still needs repairing by Salekh; nothing in his other Docker projects was touched.

### R4. Budgets for the first runs. Build, 12 Nov 2026

The seeded daily budgets from section 14 allow about one run a day per room. Salekh Ventures Data was raised to £1 a day so it can be run and re-run while it is being tuned. Salekh sets the real figures.

### R5. Site to runner link is development only. Build, 12 Nov 2026

`src/app/api/house/[...path]/route.ts` passes the house's requests to the runner with a server-side token. It can approve actions and flip the kill switch and there is no login yet, so it refuses to work outside a local development server.

## 15 Nov 2026

### S1. The agents Salekh wants. Decided, 15 Nov 2026

In his words, for three businesses (Salekh Ventures, Mastore, Twilight):

- **Salekh Ventures** has two sides. One: existing and former clients who ask for development work over WhatsApp, where he makes small changes. Two: the AI agent army (the White House), built for himself first.
- Departments he named: customer relations, outreach (built around tactics he is still perfecting and will supply), content creation and editing, ads and ad management. Paid ads do not start until January. Until then it is organic content, outreach and calling, with organic content edited by an agent.
- Agents do everything except outgoing phone calls and closing, which stay with him.
- Mastore: the same set (customer relations, outreach, content, ads, ad management, editing). Twilight: similar.

Outreach is a new department type and is not built. It needs his tactics and a decision on what it may send on its own before it is written (BRIEF.md section 16). Twilight's version of every department carries the clinical and medicine advertising limits recorded in its fact sheet.

### S2. Site inverted to black on white, new home page. Decided, 15 Nov 2026

At Salekh's request the site's colours were inverted (white ground, black type) and the home page was replaced. The new home page sells the AI departments offer and has the White House in the hero as a demo prospects can use.

- The demo is the same house in a demo mode: a browser simulation, made up business names ("Health clinic", "Software company", "Online shop", "Services firm"), no connection to the runner, and labelled as a simulation on the page. This is not the censored live feed described in BRIEF.md section 13; that comes later, when there is real activity worth showing.
- The old home page sections (studio hero, services, pricing, testimonials, FAQ) are no longer on the home page. Their components are still in the repo, and /work, /about, /journal and /contact remain. The "Sync" link was removed from the navigation because that offer became Mastore; the page itself still exists.
- Copy makes no claims about results. It says the system is being built on Salekh's own businesses first.
- Not committed, not deployed. Deploying needs Salekh's go-ahead.

### S3. Home page: team form, phone version. Decided, 15 Nov 2026

At Salekh's request, after seeing the first live version:

- The small header row above the headline was removed.
- "Message Salekh" was replaced by "Build your team": a form that asks one question at a time (kind of business, departments, one follow-up chosen from the departments picked, team size, timing, name, mobile number, optional email). Picking a kind of business ticks a suggested starting team. The mobile number is required. The lead is emailed to Salekh through the site's existing email set-up and sent to Meta as a Lead, the same way the earlier lead form worked.
- The button appears in the hero, after the departments, at the close, and as a bar fixed to the bottom of the screen on phones. Chips under the hero open the form with the kind of business already chosen.
- Phones: the house shows as a slowly turning picture that does not capture swipes, so the page scrolls. Tapping it opens the house full screen with its own phone layout. Shadows are off and the pixel ratio is lower on phones, and the scene stops drawing while off screen.
- Fixed: the 3D scene's floating labels now draw into a layer the house owns. Before, removing a label could throw an error.

Salekh mentioned "55 possible agents". No such list has been agreed in this build: there are seven department types. The form offers those seven until he supplies a longer list.

Checked by driving a separate headless Chrome at desktop and phone sizes: the page, the whole form (the test lead arrived with every answer) and the phone walk through the house.

### S4. Phone fixes after Salekh used the live page on his iPhone. Decided, 15 Nov 2026

- The closing section ("Ten clients. No more." and its paragraph) was removed: Salekh found it bizarre and unprofessional. The page no longer mentions a client limit. It closes with "See what your team would look like."
- In the house on a phone: labels on the building are larger; floor name tags that ran off the edge are hidden (Places covers them); the bottom sheets for a room and for the Chief of Staff start folded down so the scene stays visible, and open with a tab; a floor shows about two rooms and is swiped sideways.
- Chief of Staff chat: the box uses 16px type so iPhones do not zoom the page when it is tapped; the page behind is pinned and the house follows the keyboard; asking a question opens the conversation and keeps the newest answer in view; each answer is stamped with its time, because the simulation keeps moving and two answers a few seconds apart can differ; the suggested questions sit on one row.
- The Chief of Staff on the public demo is still simple rules over the simulation, not a model. It now answers a few more kinds of question (what this is, price, whether it is real, what has happened) and says what it can answer when it does not recognise one.

### S5. Phone: slide sheet, floors on the grounds, form asks revenue. Decided, 15 Nov 2026

- The "fold down" tab was replaced, at Salekh's request, by a sheet that slides: drag it up or down between fully minimised, half and full height, or tap the grabber. It opens at half height.
- On a phone the grounds now show the four floors and the Oval Office as tags down the right edge. They had been hidden because the in-scene tags ran off the screen.
- The browser's blue focus box on the question field was replaced with a rounded outline in the house's own colour.
- The team form now also asks roughly what the business takes a month (five bands) and for a website or Instagram (optional). The mobile number was already required. The lead email's subject line carries the name, kind of business, revenue band and phone number.

### S6. The catalogue of 55 agent jobs. Decided, 15 Nov 2026

Salekh asked for "the 55 agents". No such list existed in the build, so one was drafted as a proposal and he approved it as written: 55 jobs across eight groups (Customer Relations 8, Outreach 8, Content 9, Ads 8, Data 7, Engineering 7, Research 5, Running the house 3). It lives in one file, `src/lib/agents.ts`, which the home page, the team form and the house all read.

- Home page: the departments section is now the catalogue. A visitor opens a department and taps the agents they want. Their picks carry into the form, tick the matching departments, and are listed in the lead email.
- House: a room's panel lists the agents that room can hold. Running several real agents in one room comes as each is built.
- Only two of the 55 are built (Data: Daily Read, Research: Market Report). The page words them as jobs an agent is built and trained for, not as things already running.
- Each one still needs, before it is real: a written job, the business's facts, access to the right system, test cases and a scorecard. Outreach also needs Salekh's tactics and his rule on what it may send unseen.

---

## Prospecting pipeline (Outreach room): build decisions, 15 Nov 2026

Made by the build agent. **Build** status unless marked **Open**. Smallest version that produces a daily shortlist: find, analyse, score, shortlist. **Nothing is sent to anyone**: no sending code exists and no sending action type is registered. The mystery enquiry, follow ups and replies (steps 3, 6 and 7 of Salekh's brief) are not built. Not run against the real model by the build agent. 178 tests pass, all with a scripted model and a stubbed search tool.

### O1. Code fetches and decides; a model only reads and drafts (changed mid-build)

The first design gave an agent web search and fetch in a tool loop. On Salekh's point about cost it was replaced before it was finished: fetching is plain code through Agent Reach, and a model is called at three fixed points, one call each, with a fixed input, a structured answer, no tools and no web access.

| Point | Model | What it does | What code does around it |
| --- | --- | --- | --- |
| Find | `claude-haiku-5-5`, up to 25 results a call | Says which search results and job adverts are real businesses of the right kind, and which signal each shows | Runs the searches, drops what is already known or suppressed before asking, finds the employer's own site, deduplicates, records |
| Analyse | `claude-haiku-5-5`, one call a business | Reads up to four of the business's own pages and fills the analysis, giving a page number for each fact | Fetches the pages, reads contact routes, company number and postcode off them itself, checks every answer against its page, asks Companies House |
| Draft | `claude-sonnet-5-5`, one call a business that passed | Writes why it made the list, a sample reply, a first message and a call opener | Filters, scores, builds the competitor comparison, checks the draft against written rules and sends it back once if it fails |

These calls use the Anthropic TypeScript SDK (`@anthropic-ai/sdk`, pinned 1.8.0, already present as a dependency of the Agent SDK) with structured outputs (`messages.parse`, `output_config.format`), behind a small interface so tests use a scripted stand-in. The Agent SDK is not used by this room. The model never supplies an address: it refers to a result or a page by number and code supplies the address.

Reworked because of the change: the three agent tools, the per-prospect agent runs, the agent's web allow list for this room and the first version of the pipeline tests were dropped; the store, the dedupe keys, the filters and score, and the Companies House connector carried over.

### O2. Agent Reach, and only four of its actions

`AGENT_REACH_BIN` gives the binary. The connector runs `web search`, `web read`, `linkedin jobs` and `linkedin read` and nothing else: its instagram, facebook, twitter and reddit channels cannot be reached from the code. Each call has a timeout, takes its arguments as a list (never a shell string), and keeps at most 6,000 characters of a page and 1,500 of a search result. A LinkedIn profile address is refused before the tool is run, a LinkedIn address is never read through the plain web channel, and anything `linkedin jobs` returns that is not an advert's own page is dropped. Unset: the find stage stops with "the search tool is not configured". A real `linkedin jobs` call was made once by hand to see the shape of its answer: it works without a login and returns the advert text, which names the employer.

Fetched pages are cached in the database for the day (`fetched_pages`) and deleted after a day. It is the one table a role may delete from, because it is a cache of public pages and should not be kept.

### O3. Two routes into the master list, one dedupe

Route one starts from public job adverts for the front desk roles in settings (receptionist, front of house, patient coordinator, treatment coordinator, practice administrator), through `linkedin jobs` for each place and one web search for adverts elsewhere. Route two starts from the kind of business and the place. Both end at the same `recordProspect`. A business found by route two that also has an advert gets the signal added to its row, matched by the same keys. An advert's evidence is written by code: its title, its address and the date seen. An advert from a recruiter that hides the employer is skipped and counted, with a fixed event. A source that fails, refuses or times out is skipped with a fixed event and not retried.

**Limits, plainly.** From an advert the employer's own site is found by one search and taken only when the site's address carries a word of the employer's name; otherwise that advert leads nowhere. Adverts can be old (the one seen by hand was five months old): the card shows the date seen, not the date posted. **Meta adverts and weak social accounts cannot be seen**: there is no source for them in this version (Agent Reach's social channels are excluded and the Meta Ad Library is not reachable), so in practice the signals found will be front desk adverts and whatever a result or a business's own pages say. `runs_ads` is always "not found" and the card says so.

### O4. One row per business, decided by code

Keys: the website's host (no scheme, no www; a page on a shared platform such as Facebook is not a key), the Companies House number, a hash of the normalised name and postcode, and a near match of names at one postcode (the same once generic words such as "dental" or "clinic" are removed). Unique indexes in the database hold the first three whatever the code does. A prospect needs its own website or a name with a postcode, or it cannot be recorded. Learning a company number during analysis can reveal a duplicate, which is then set aside as `duplicate`.

### O5. Suppressions are permanent

`suppressions` has no update or delete grant for any role, and a trigger refuses update, delete and truncate even from a superuser. Checked when a business is recorded and again when it is scored. Suppressing by email or phone is stored but nothing reads those two kinds yet (nothing sends).

### O6. Personal data

A named owner or manager and the contact routes live in `prospects` and in the finished shortlist a person reads. They are never written to `events`: stage lines are fixed templates with numbers only, no brief or model input is stored for this room, and a failed stage records a fixed code, not the error's text. Agent tools have no access to the prospecting tables. A person's name is kept only when the page it is said to come from contains it, and only from the business's own pages or the Companies House register (directors are public). Prospects filtered out are purged after 90 days: name, site, analysis, signals and contact details go; the keys that stop it being found again stay. Open: `purgeProspects` and `purgeFetchedPages` exist but nothing schedules them. The page cache can hold whatever a public page says, including a testimonial; it is kept one day.

### O7. Filters and score (rules before models)

Filters, in order, first failure recorded: not analysed; not a limited company (Companies House, or the business says sole trader or partnership); no signal; no named contact; limited company not confirmed; no contact route; no sign of money (a high value service, several staff, or two or more locations). Each can be switched off in settings.

Score out of 100: **signals** 25 front desk advert, 15 Meta adverts, 10 weak social, 10 poor reviews, at most 45; **money** 10 high value service, 10 adverts seen running, 10 for five or more staff or 5 for three or four, 5 for two or more locations, at most 30; **reach** 5 a named contact plus each kind of route once (WhatsApp 4, Instagram 3, phone 3, Facebook 2, form 1, email 1, booking 1), routes at most 10; **limited company confirmed** 10; **reply speed** nothing, not tested. Weights are settings.

**Not as the brief has it:** "replied slowly or not at all" cannot be judged without the test, so it is neither filtered on nor scored, and every card says "Not tested yet". **With no Companies House key** a business is "not checked" and is kept, flagged on its card (a setting can make that a refusal). "Poor reviews" has no lead agent in the strategy's table: it is set to Enquiries as a placeholder. **Open: Salekh to confirm.**

### O8. England, a few places a run

The territory is England. A list of 40 English cities and large towns is in settings (editable, a starting spread, not a considered list). Each run takes the next three, never searched first, then longest ago, and records it in `search_coverage`.

### O9. Competitors

For each shortlisted business the card compares it with up to three other businesses of the same kind already on the master list and found for the same place, same postcode district first. The comparison is written by code as facts with sources: reviews, ways to enquire, a front desk advert, opening hours, each "not found" where unknown, and "Not tested yet" for reply time. Links are stored in `prospect_competitors` with room for the later test comparison; a tested business keeps its result on its own row, so one competitor serves several prospects. **Limit:** competitors are only those the searches happened to find and analyse, not a deliberate search for the nearest three, so early cards may have none.

### O10. No email outreach

The first message is a short direct message for Salekh to send by hand or say on a call. Code refuses a draft that reads like an email, claims a test, quotes a number or a result, or uses hype, and asks once more. The card names the best route and why (WhatsApp, then Instagram, then phone, then Facebook, then a form) and never suggests email. Because he no longer emails prospects, the "limited companies only for cold email" rule guards nothing sent today; the filter is kept because the brief asks for limited companies.

### O11. Runs, budget, kill switch, cost

Each stage is one row in `runs` with the tokens and estimated cost of all its model calls. The kill switch and budget are checked before each stage by the phase 1 code, and again before every model call inside a stage. A stop leaves everything recorded; the next run picks up unanalysed prospects. Cost is tokens times list prices (an estimate; Haiku 5.5's higher rate above 100,000 prompt tokens is modelled and every prompt is kept far below it). Each shortlist records per-stage calls, tokens and cost, and cost per business looked at and per business shortlisted. The seeded daily budget for this room is **£2, a placeholder** with no basis in section 14.

### O12. Not followed from the SDK guidance, on purpose

The current guidance for `claude-sonnet-5-5` is to enable a server-side fallback model for refusals. It is not enabled: the brief pins each model by exact id, and a silent change of model would change cost and behaviour. A refusal is recorded as a failed draft and the business is held for the next run.

### O13. Changes to earlier work

- Migration 0007: `prospects`, `prospect_events`, `suppressions`, `prospect_competitors`, `search_coverage`, `fetched_pages`; a `setting` kind of config; a `stage` event type; `outputs.data`.
- `/v1/house`: a room is `working` while a pipeline is between stages, and its task line is the latest stage line. No change of shape.
- The agent session's hook now refuses LinkedIn profile addresses for every department (Research included).
- Seed: Outreach added to the Salekh Ventures floor, live, with its settings and placeholder budget.
- Earlier tests updated where they count tables, migrations and seeded rows.

### Not done

- Steps 3, 6 and 7 of the brief. No sending of any kind.
- No scheduler: a run starts from the API. "By 9am" needs one.
- Reviews and Google Maps: only a count and rating a business states on its own pages. No listing site is read.
- Purges are not scheduled. No API to add a suppression or edit settings (functions exist; the UI does not).
- Evals: 14 synthetic cases for this room, each testing one model call. None run against the real model.

---

## Prospecting, second round after the first real run: build decisions, 15 Nov 2026

Made by the build agent after the coordinator's first real run (50 found, 44 analysed, 2 shortlisted, £0.09). **Build** status unless marked **Open**. Not run against the real model by the build agent. 189 tests pass. Migration 0008 is new and has not been applied to `wh_dev` by the build agent.

### Q1. Groups and chains are left out

Salekh sells to owner-run clinics. A business is treated as part of a group when any of these holds: its own pages say so (a new analysis field, with the page, "not found" allowed); its name, website or registered company names a group on the settings list `excluded_groups`; or it shows ten or more premises (`chain_locations`). It is filtered out with the reason `part_of_group`, checked first of all the filters. A group on the list is set aside as soon as it is found, before any analysis is spent on it. A group is never offered as a local competitor. An owner with two or three sites is not a group, and the model is told so.

The list is seeded with six groups, each checked on 15 Nov 2026 on its own website as describing itself as a group or network: PortmanDentex, Rodericks Dental Partners, mydentist, Colosseum Dental, Thérapie Clinic, Riverdale Healthcare. **Not on the list because their sites could not be read that day:** Bupa Dental Care, Together Dental, Laser Clinics UK. Salekh adds any others with `npm run outreach-settings -- --exclude-group "..."`.

### Q2. Job adverts are the main way in

- Eight places a run by default (was three), 25 advert results per role per place (the tool's cap), and every advert search for every place is run before the searches by kind and place.
- Search results are asked about adverts first, and prospects found from a front desk advert are analysed first; the others fill what is left of the batch. Businesses found by kind and place are still recorded and analysed: they are the competitor pool.
- **An advert's age is read by code** from words such as "3 weeks ago". Older than `advert_max_age_days` (60) it is not a signal; the business is still recorded. An advert that does not show its age still counts, and its evidence line says the age is not shown. The age shown is kept with the signal.
- A run may make at most `max_fetches_per_run` (600) searches and page reads. Past that a call fails like any refused source and the run carries on. Every shortlist reports how many were made, how many came from the cache and how many were not made.
- "No named contact" is still a filter. Each run also counts how many failed **only** for want of a named person while no Companies House key was set, so the worth of the key can be seen.

### Q3. The comparison is one table

Per card: a Markdown table with a row for each fact (reviews, ways to enquire, front desk advert, opening hours, reply time) and a column for the prospect and up to three competitors, "not found" where unknown, sources numbered and listed once beneath. Then only the differences that go against the prospect, each a sentence of fact written by code: a route a competitor publishes that was not found for the prospect, a higher review rating, opening hours published where the prospect's were not found. If none goes against it, the card says so. The drafting model is given only those sentences.

### Q4. A daily schedule inside the runner

The room's `schedule` config (which already holds the live flag) may carry `daily_at`, read in the tenant's time zone. The runner looks every minute and, once the time has passed, starts the room through the same call the API uses, so the kill switch, budget and every other check are the same. Before starting it writes a `scheduled` event for that room and day under a lock; a restarted runner finds it and leaves the day alone. A run that cannot start is recorded as skipped with a fixed reason and is **not** tried again that day. A runner that only comes up after the time still does the day's run. Seeded: Outreach at 08:00, nothing else. If the event cannot be written (migration 0008 missing) nothing is started.

**Not proven by a test:** two runners looking at exactly the same moment are kept to one run by the lock. The test for it passes with the lock removed, because the two did not interleave, so the lock rests on reasoning, not on a failing test.

### Q5. From the command line, as the UI's role

`npm run suppress -- <website or company number> "<reason>"` and `npm run outreach-settings` (print; `--areas-per-run`, `--batch-size`, `--exclude-group`, `--include-group`, `--daily-at HH:MM|off`). Each change is a new version of config against the tenant's owner. A reason is required for a suppression and kept with it.

### Q6. Recruiters' adverts that hide the employer

One attempt, by code, to tie the advert to a business already on the list for that place: a full postcode in the advert that exactly one business has, or a postcode district with exactly one business on the list. A match is stored on that business as an **unconfirmed** signal, shown on a card as "possible signal, not counted", and left out of the filters, the score and the choice of lead agent. **Limit:** a business's postcode is only known once it has been analysed, so in practice this attaches to businesses analysed on an earlier run. Most such adverts give no postcode and are still skipped and counted.

### What changed in the filters and the score

- New filter, first in the order: `part_of_group`.
- Signals that count are confirmed ones only; an advert older than 60 days is not one.
- The score formula and weights are unchanged from the first round (route weights were already changed there for direct messages).
- Analysis order and search order changed; batch size is still 50.

### Could not do

- A posted date is only what the advert's own text says ("N weeks ago"). No absolute date is captured, and adverts found through web search rarely show an age.
- "Ads posted by recruitment agencies" are matched by postcode only. Matching on the description (services, opening days) was not attempted: it would be a guess.
- The three large groups named above could not be verified, so they are not seeded.

---

## Prospecting, third round: living within the search tool's limits, 15 Nov 2026

Made by the build agent after the second real run failed with every source refused. The cause was Agent Reach limiting itself (`RATE_LIMITED`, with a wait of about 40 minutes) and its job advert source asking for a login (`NEED_LOGIN`). **Build** status. No schema change, so no new migration. The real tool was called twice by hand, once per channel, to read the two error shapes. 198 tests pass, all with the stubbed tool returning those shapes.

### T1. The tool's error codes are read

The connector now reads the tool's JSON even when it exits with an error. `RATE_LIMITED` becomes a rate limit with the wait taken from its hint ("Wait 2501 seconds..."), `NEED_LOGIN` becomes "this source is unavailable", anything else is a plain failure. Salekh will not sign a personal account in, so a login request is not a fault to fix.

### T2. A limited channel is left alone for the rest of the run

The tool has two channels here: web (search and read) and LinkedIn (job adverts). The first time one reports a rate limit or asks for a login, it is not called again in that run, and one fixed event records it, with the number of seconds when the tool gave one. The second real run made 64 calls into a limit; the same situation now makes one call per channel.

### T3. Degrade, do not fail

- Whatever the find stage got before a limit is used.
- If the limit arrives during analysis, the businesses not reached stay as found, with no failed attempt against them, and the run goes on to score and draft what was analysed.
- The run fails, with the fixed reason `search_rate_limited`, only when nothing was found, nothing was waiting and nothing was analysed.
- The shortlist's notes open with a plain line when the run was cut short, why, the wait given, and how many businesses are waiting.

### T4. Backlog first

A run now begins by analysing businesses found on earlier runs and never analysed (advert-led ones first), and only then looks for new ones, up to what is left of the batch size. If the backlog fills the batch, nothing new is looked for and no searches are spent. The first run row of a pipeline is therefore `outreach:analyse` when anything is waiting, and `outreach:find` otherwise.

### T5. Pacing

A minimum gap between calls to the tool (`min_seconds_between_fetches`, default 1.5 seconds) and the per-run limit lowered from 600 to 300. Advert searches run with the roles in the order of the settings list (receptionist first), and a place's advert searches stop when two in a row bring nothing new. At 1.5 seconds a run of 300 calls takes at least seven and a half minutes on fetching alone. **Not known:** what the tool's real limits are. 274 calls in one run were accepted and the next run 12 minutes later was refused, so 300 a run with a gap is a guess at staying inside them, not a measured figure.

### T6. One retry by the scheduler

A scheduled run that failed with `search_rate_limited` is tried once more the same day, after the wait the tool gave (60 minutes if none). The mark that the retry has been used is written before the retry starts, so a restart cannot repeat it. If the second try fails for any reason the scheduler records that it has given up for the day. A run that failed for any other reason is not retried.

### Could not do

- The tool's limits are not documented in what it prints, so the pacing cannot be proved sufficient. If runs are still limited, lower `areas_per_run` or `max_fetches_per_run`, or raise the gap.
- With the advert source asking for a login, route one depends on web search for adverts on other boards, which showed fewer and less clearly dated adverts on the first run. Until that source is available again, expect fewer advert-led businesses.

## Prospecting, fourth round: the test enquiry by email and the capture score, 16 Nov 2026

Salekh's decisions, as given: email only; sent from a test mailbox he owns and signed with his first name; he approves every enquiry in week one; one enquiry per business ever; no booking, no health details, nothing false about who is asking; no follow up and no reply from the test mailbox; wait 24 hours before scoring. Two additions arrived during the build: an estimated monthly leak shown as a range with its workings, and rivals tested only for a business that has itself scored low.

### E1. One sending action, and where each rule is held

`enquiry.send_email` is the second action type on the closed list. Highest rung ever 3, cap `enquiries_per_day`, not undoable, connector `mail`. Its payload is the enquiry id, the prospect id, the address, the subject and the body. Because that is personal data, the gateway's events for this action carry the payload's hash and not the payload (`privatePayload`), and the reason given is a fixed line.

- **One enquiry per business, ever**: two unique indexes on `enquiries` (per business, per address), which only a rejected or expired enquiry leaves room in. The connector also claims the row as `sending` before it sends, so a second attempt has nothing to send. A send that fails after the claim is marked `failed` and is never retried, because it may have gone.
- **Nothing without his yes**: rung 2 through the normal gateway path (payload hash, 24 hour expiry, single use). The connector sends only when the stored enquiry equals the approved payload, and the gateway's role cannot update the address, subject or body.
- **Suppressed businesses**: refused when proposed and checked again in the moment before sending.
- **The credentials**: `TEST_MAILBOX_ADDRESS` and `TEST_MAILBOX_APP_PASSWORD` are read in `index.ts` and handed to the mail connector only. No agent, model call or event sees them.

### E2. Reading replies is narrow by construction

The mailbox connector asks the mail server to search for messages whose In-Reply-To or References header names an enquiry's Message-ID, or that come from the address written to, or from the business's own domain when the address is on that domain. Only the messages those searches return are fetched. A shared mail provider's domain never counts, only the exact address. Nothing is replied to, moved, flagged or deleted. Reply text is stored in `prospects.test_result` and nowhere else, with the same purge as the rest of a prospect.

Automatic or a person: headers first (`Auto-Submitted`, `X-Autoreply`, `Precedence`, an "automatic reply" subject). When they do not settle it, one cheap model call reads the reply. The same call says whether the question was answered and a next step offered, and a "yes" counts only when the sentence it quotes is really in the reply. An opt-out, by plain words or by that reading, adds a suppression for the address (and the domain when it is the business's own) at once.

### E3. The capture score

Out of 100, six parts: reply speed 50 (15 minutes 50, 1 hour 42, 4 hours 32, later the same day 22, within 24 hours 12, none 0), reply quality 20 (answered 12, next step 8), follow up 10, routes 20 (4 per kind up to three, 8 if one works out of hours), reviews answered and social activity not measured. Unmeasured parts are left out and the score is scaled over the rest; the card always says "measured on N of M parts". All weights are in the `capture_weights` setting. The earlier score is now called fit.

"Same working day" is implemented as the same calendar day in the tenant's time zone. Opening hours are not reliable enough to use.

### E4. The shortlist rule, and businesses that cannot be emailed

Tested: capture at or below `capture_threshold` (50) and the fit filters, with no signal asked for (the test is the signal). A fast, good replier is filtered out as `captures_well` and kept as a comparison. A business that opted out is filtered out as `opted_out`.

Not testable by email (no address published, or Salekh rejected its enquiry): no capture score. It is shortlisted only on the rule in force before tests, which is fit plus a confirmed signal, and its card says why it has no capture score. This is a choice the brief did not make; the alternative is never to shortlist such a business.

### E5. The estimated leak

`price x enquiries a month x share lost to a slow reply x share that would have bought`, low and high. The price is kept only when the business's own page shows that number, with the page as its source. The other three are in `leak_assumptions`, seeded as cautious placeholders (20 to 60 enquiries, 10% to 30%, 10% to 25%). **They come from no study and no benchmark and are Salekh's to edit.** No published price, or a person replied within four hours: no figure, and the card says why. `min_estimated_leak` (5,000 pounds, on the high end) applies only when an estimate exists. The drafting model is never given the estimate, and code refuses any first message with a pound sign or a percentage in it.

### E6. Rivals

A business that passes fit and publishes an email is tested as a possible client in its own right, whoever its neighbours are. So "rivals" tested later are the local competitors that are not themselves candidates (they failed a fit filter) and publish an email: up to the three already linked to the prospect, once each, each needing approval. The prospect's card goes out as soon as its own result is in, marked "rivals not tested yet" when any rival's result is still to come, and is issued again when they are in. A rival's result is stored and reused for every prospect it is compared with.

### E7. Sending

Approving an enquiry records the yes; a single sender then works through approved enquiries one at a time, oldest first, with `enquiry_send_gap_seconds` (90) between them. It stops at the kill switch, the day's cap or the budget and picks up on the next ten minute round. The pipeline never proposes more than the day's allowance, so overflow waits unproposed for the next day rather than holding an approval that would expire.

### Could not do, or not as written

- The real mailbox connector (`connectors/mailbox.ts`) has not been run against a mail server by this build: tests use a mailbox in memory, as instructed. The narrowness of reading rests on that file's search calls and should be watched on the first real batch.
- "Same working day" is the same calendar day (E3).
- Whether the enquiry's content is "false about who is asking" is checked by fixed patterns (patient claims, booking requests, health words, links). A draft could still invent a circumstance no pattern knows. Salekh's approval of every enquiry is the real check.
- An approval lasts 24 hours. An enquiry approved but held by the kill switch for longer than that expires and is not sent; the business can be proposed again.
- A reply that arrives after scoring is stored (for three days) but does not change a score already given.

### E8. Google Places is the main way to find businesses (added the same day)

Places API (New), Text Search only, by plain code on the gateway side (`connectors/places.ts`). The key is read in `index.ts` and travels in a header. No key: the pipeline finds businesses by web search as before, and the shortlist says so.

- **One field mask, in one place**: id, displayName, formattedAddress, postalAddress, location, businessStatus, websiteUri, nationalPhoneNumber, rating, userRatingCount, regularOpeningHours (periods and weekdayDescriptions), and nextPageToken. By Google's data fields table (read 16 Nov 2026) the dearest of these is in the Enterprise tier, so every call is billed as **Text Search Enterprise**. Up to three pages (60 results) per place.
- **Reviews**: the rating and the count come from Places with the place as the source, and replace whatever a business's own page claims. **"Reviews answered" stays not measured.** The Review object in Places API (New) has no field for an owner's reply, so the API cannot say whether a business answers its reviews. Asking for `reviews` would also move every call to the Enterprise + Atmosphere tier. So reviews are not fetched at all, Place Details is never called, and no review text or reviewer's name is stored anywhere.
- **Dedupe**: the place id is one more unique key on `prospects`. A business found earlier another way gains its place id when Places returns it.
- **No website**: recorded (so it is not found again) and set aside as `no_website`. It cannot be analysed or tested by email, and the shortlist says how many.
- **Order of finding**: job adverts first (a bonus signal), then Places fills the batch for each place in the day's rotation. The web search for "business type in place" is no longer made when Places is configured; Agent Reach reads each business's own pages and looks for adverts.
- **Rivals**: when a business scores low and has a location from Places, one Text Search ranked by distance round it (setting `rival_search_radius_metres`, 5000) gives its nearest three of the same kind that are open and have a website. They go on the master list like any other business, are analysed on the next run, and are then put forward for the same enquiry. Its card says "rivals not tested yet" until then. A business with no Places location falls back to the master list as before.
- **Opening hours**: the card's evidence says whether the test enquiry was sent while the business was open or closed, by the hours Google shows. **The points for "a route that works out of hours" are unchanged**: no rule was given for turning opening hours into points, and inventing one would be a guess. This needs a decision.
- **Limit**: `max_places_calls_per_run` (20). Calls made, calls not made at the limit and failures are on the run's output with the price tier. The Places cost is not in the model cost figure.

### E9. LinkedIn job adverts: national search, place matched in code, a pause is respected (added the same day)

`agent-reach linkedin jobs` is now run without `--location`, which the source answers with an error followed by a pause. One national search per query is kept for ten minutes and each advert is offered only for a place its own location names. An advert's facts are read from the `raw` record of the tool's answer (`company`, `location`, `listed`), because its `text` is empty. `UPSTREAM_BROKEN` with a `retry_after_seconds` is a new state, "paused": the channel is left alone for the rest of the run, with one fixed event and a line in the shortlist. Without a stated wait it is an ordinary failed search. Putting the place in the query text was tried once against the real tool and does not narrow the results, so it is not relied on.

### E10. The search tool's limits are per action, and searching is never essential when Places is configured (added after the first real runs)

Two real runs produced nothing: `web search` was rate limited, the whole tool was marked limited for the run, and 43 businesses that needed only page reads were left. Fixed:

- **Per action.** `web search`, `web read`, `linkedin jobs` and `linkedin read` are tracked separately. One going down never stops another, nor Places, nor the mailbox.
- **Order of a run**: collect replies; score what is 24 hours old (code only, now done before anything that can be limited); analyse the backlog (page reads); find with Places; analyse; propose enquiries; then, last and optional, the job advert searches; then the cards. Without Places the advert and web searches stay at the front, because they are then the only way to find anything.
- **Inside analysis** the one web search (for a site's other pages) already degraded to the home page alone. An advert naming a business that is already on the list for that place now takes its website from the list, so no search is needed to tie the two.
- **A short wait is honoured**: a rate limit with a stated wait of 30 seconds or less is waited out and the call made once more. A longer wait, no stated wait, or a second refusal gives up on that action for the run.
- **"Cut short" means page reads were limited** (or the run reached its own limit on calls). A limit on searching is said in a plain line and the run carries on.
- Up to ten new businesses named in adverts are recorded by the late advert stage, to be read on the next run.

### E11. Pages are read directly; the search tool's reader is only a fallback (added after web read was limited too)

With `web read` rate limited as well, nothing could be analysed. Reading a business's own pages no longer depends on anybody's allowance: `connectors/direct-read.ts` fetches them by plain code, and Agent Reach `web read` is asked only when a direct read fails for an ordinary reason or returns almost no text (under 200 characters, which usually means a site drawn by JavaScript).

- **What it will connect to**: http and https, ports 80 and 443, public addresses only. Private, loopback, link-local, carrier, documentation and multicast ranges are refused, for IPv4 and IPv6, on the first request and on every redirect (5 at most). **It uses node:http, not fetch**, so the check sits in the socket's own lookup: the address checked is the address connected to, and a name that resolves differently a moment later gets nowhere. fetch offers no way to pin that without another dependency.
- **Limits**: 15 seconds for the whole request, 2 MB, text/html and text/plain only. The User-Agent is `business-page-reader/1.0 (reads a business's own public pages; obeys robots.txt)`: a generic name, no personal details, not a browser's.
- **robots.txt** is fetched once per host per day (kept in the existing page cache) and obeyed for both readers. A group naming our agent applies if there is one, otherwise `*`; the longest rule wins. No file: nothing is disallowed. A server error on robots.txt is not a yes: the site is not read.
- **A bot check, a login or a refusal** (401, 403, 429, a challenge header, or a 200/503 with challenge markers and little text) is recorded as blocked, once. **The fallback reader is never used to get round a no**: disallowed, blocked, a refused address and a non-page all stop there.
- Businesses not read are set aside as `not_read_disallowed` or `not_read_blocked` and the shortlist says how many.
- **HTML to text** with `htmlparser2` (already in the tree under mailparser, now declared): scripts, styles and the menu's words go; headings, linked email addresses and phone numbers, JSON-LD, links to other sites (booking, WhatsApp, social) and, last, the page's links to its own site with full addresses are kept.
- **A site's other pages** come from the home page's own links, topped up from `/sitemap.xml` when fewer than two of contact, about or team, and treatments or prices are found. No web search is made for them when the direct reader is on.
- **Limits per action**: `direct read` is its own action. With it on, a limit on `web read` or `web search` never cuts a run short. A business that needed the fallback while it was limited is left as found, with nothing against it, and the run carries on. "Cut short" now means only that the run reached its own limit on calls (or, with `DIRECT_READ=off`, that the outside reader was limited, as before).
- The per-run fetch cap, the gap between calls (plus 2 seconds per host), the page limit per business (4) and the daily cache all apply unchanged. Page text is untrusted data in prompts exactly as before.

### E12. The analysis schema that the API would not compile, and no more silent failure (added after the first real analysis run)

Every analysis call failed with `400 invalid_request_error: The compiled grammar is too large`. Round 4 had added one more nullable field to a schema already built of nullable pairs, and the pipeline recorded only a fixed code, so it looked like 49 quiet failures.

- **The schema is flat and has no nulls.** "Not said" is `""` or `0` with page `0`; the legal form has a `not_stated` value. Nothing is optional and there is no union. Emails, phones, routes, links, the company number and the postcode were already read by code and are not in the schema. Everything the capture score, the leak estimate (service, published price, page) and enquiry drafting need is still there. It did not need splitting into two calls.
- **`npm run check-schemas`** sends each stage's schema (find, analyse, enquiry, reply, draft) to the real API with a one line prompt and 16 tokens, and prints pass or the API's error. Tests cannot see this fault, because they never call the API: this command is the check, and it is a step before any deploy.
- **A refused request is never silent.** For a 4xx other than 408 and 429 the model caller keeps the API's error type and the first 300 characters of its message (never the request body). The pipeline writes an event with reason code `model_request_error` and that detail, does not count it against the business (no failed attempt), and after three identical refusals in a row stops the stage: analysis and card drafting fail the run with the line "Analysis stopped: the model refused the request: <type>"; enquiry drafting stops and says so at the top of the shortlist.
- **Calls that failed are not presented as work.** A stage's `model_calls` counts answered calls; `failed_calls` is shown beside it when there are any.
- **`npm run reset-attempts`** sets `analysis_attempts` back to nought for businesses still in stage `found`. With `--restore-failed-since YYYY-MM-DD` it also puts back to `found` those set aside as `analysis_failed` since that day, with a `restored_after_request_error` line on each one's record.

## Deployment: the runner on a server with no shell, 16 Nov 2026

### D1. The database is set up by the container at start

The server's database has no public address and there is no shell, so migrations, logins and the seed all run from inside the container (`bootstrap.ts`), under an advisory lock, every time it starts. It only adds what is missing; a second start changes nothing but the passwords. A failure prints one fixed line with no URL or password in it and exits 1.

### D2. Two processes, so the server never holds the owner's URL

`start.js` runs the setup as root and then starts the server as uid 1000 with the owner's URL (and anything like it) removed from its environment. A different user cannot read the parent's environment or the migration files, which are root's alone and sit outside `/white-house`. Deleting a variable inside one process would not have given that: the original environment stays readable to anything running as the same user. The earlier rule "the image does not carry the SQL files" is replaced by "it carries them where nothing but the setup can read them".

### D3. The server's logins

`wh_live_agent`, `wh_live_gateway`, `wh_live_ui`: each a member of its one White House role, no superuser, no create role, no create database, no bypass of row level security. Passwords must be 16 characters or more and all different.

### D4. Configuration is carried over once, and only what is not about people

`npm run export-config` prints the settings, schedules, budgets, rungs and caps in force and the suppressions that name a business. The bootstrap applies it on the first boot only, as version 1 of each value, and refuses anything else in it: a suppression that is an email or phone, a rung past an action's ceiling, an action this code does not have, a target, the kill switch, any unknown field.

### D5. One mailbox, one owner

`WH_ROLE=standby`: no scheduler, no run triggers (409 `standby`), no sending, no reading of the mailbox, and the mailbox is not held by the process at all. The default is primary.

### D6. The API on a public address

`/health` says `{"status":"ok"}` and nothing more. Every `/v1` route is checked for the token before the route is looked at, in constant time over hashes. Ten failures from one address in five minutes are answered 429 after that; **a correct token is always let through**, because behind a proxy many callers can share an address and the site's own server must not be locked out by a stranger's guessing. The protection is the token's length (32 characters or more, enforced off localhost); the limit is there to blunt noise. The log line for a failed route carries the route's first word and the error's kind, never the path, the body or the error's text.

### D7. No search tool on the server

With no Agent Reach, every one of its actions is "not configured" and nothing is run or counted. Outreach then needs Google Places and the direct reader; with both it runs fully and says once that job adverts are not searched there. Without them it stops as before.

### D8. Time

The schedule is read in the tenant's time zone by the database (`at time zone`), so the container's own clock zone does not matter. Tested with the process fourteen hours from London across both 2027 clock changes.

### OPEN RISK: backups

Point-in-time recovery, which BRIEF asks for, is **not confirmed** on the server's database, and this build takes no backup of its own because there is nowhere to put one. Nothing here pretends otherwise. To close it: switch on and test the provider's backups, or give the runner a bucket for a nightly dump and test a restore.

## Prospecting, fifth round: more than one kind of business, 17 Nov 2026

### K1. A list of kinds, each with its own rules

The single `business_type` is replaced by `business_types` in the outreach settings. Each kind has an id (stored on every prospect), a name, the phrases searched for, its own excluded groups, guidance for the analysis on what its high value service is, guidance for the enquiry, its own forbidden topics with the reason given back when one is found, whether an emailed test is a fair test of it (`email_test`), a caution printed on its cards, who to ask for when nobody is named, its job advert search hint, and its leak assumptions.

Seeded: private dental and aesthetics clinics; solicitors (conveyancing and family law); independent financial advisers and mortgage brokers; estate and letting agents; accountants for small businesses; home improvement trades doing large jobs. **Every leak assumption is the same cautious placeholder for every kind (20 to 60 enquiries a month, 10% to 30% lost, 10% to 25% would have bought). None has been set for its trade and none comes from a study.** Fees that are a percentage (advisers, estate agents) are not a published price, so those kinds will often get "no estimate".

**Online shops are not a kind, on purpose:** a shop has no enquiry-to-booking path to test. Trades have `email_test` on, with a caution on every trade's card that trades answer the phone and messages far more than email, so an emailed test may under-report them (the coordinator's reading of Salekh's strategy file; I did not read that file).

### K2. Rotation, and everything else, is by kind

A run takes the next few (kind, place) pairs, least recently searched first, then least often searched, then place by place. `areas_per_run` is now the number of pairs. One Places call per search phrase per pair, the first page of every phrase before the second page of any. A prospect keeps its kind; its analysis, enquiry, checks, leak estimate, card and rivals all follow it; a rival is always the same kind. Stats are also given per kind. Job adverts are searched only for a kind that has a search hint (clinics).

### K3. Settings stored before this are read as they are, and written back in the new shape

A stored value with `business_type` at the top becomes: that one kind as "clinics", keeping its name, groups, forbidden words and assumptions, **switched on, and every other kind switched off**. So a house that was looking for clinics goes on looking for clinics until another kind is switched on. Nothing is rewritten on read. It is written in the new shape, as a new version, the next time the settings are changed from the command line, or at the next start of the server (bootstrap). Fresh settings have all six on.

On the server, which has no shell, kinds are switched with `WH_OUTREACH_ENABLED_TYPES` (a comma separated list of ids: exactly those are on). Locally: `npm run outreach-settings -- --enable-type solicitors` (or `all`), `--disable-type`, and `--type` for per-kind group changes.

### K4. The test comes before the name and the company

27 of 48 analysed businesses were dropped before testing for want of a named person or a confirmed limited company. Now a business that matches its kind, is not a group or suppressed, and publishes an email is tested. After its result, and only for those at or below the capture threshold, Companies House is asked (company, and a director's name when nobody is named). Then: a limited company is required for the shortlist (Salekh's rule); a named person is not, and the card says "no named person found: ask for the owner or the practice manager" (worded per kind). `npm run restore-filtered -- --since YYYY-MM-DD` puts back to be tested the businesses dropped for those two reasons.

A consequence: every local business of a kind that publishes an email is now tested in its own right, so "rivals tested later" are in practice the ones Places finds near a low scorer, or ones that waited for the day's allowance.

Without a test mailbox the old order and the old filters still apply, a named person included.

### K5. Enquiries are varied by code, not left to chance

Each enquiry is given one of six shapes (greeting, which question comes first, how it closes), picked by a number worked out from the business's id, so a batch is spread across them and the same business always gets the same one. The service asked about is cut to the first item of whatever the price list said ("implants, veneers, Invisalign and whitening" becomes "implants") before the model sees it. The prompt was rewritten for any kind of business. Every check still applies, with one added for every kind: no address or postcode.

## Test enquiries that send themselves (rung 3), 17 Nov 2026

Salekh's decision as owner: test enquiries send without his yes; his task is to call the shortlisted businesses. Rung 3 was already the ceiling for `enquiry.send_email`. What follows is what makes that safe.

### S1. The switch is the owner's

`WH_ENQUIRY_RUNG` (2 or 3) on the server, applied at start as a new version of the rung in the owner's name, reason "set by the owner through the server's settings"; anything else stops the start. Locally `npm run outreach-settings -- --enquiry-rung 3`, never past the ceiling in code. The settings output says "EACH NEEDS YOUR YES" or "SENT WITHOUT ASKING, inside the limits below".

### S2. Nothing is approved on anyone's behalf

At rung 3 an enquiry is never given an approval at all. It is recorded as `queued` (a new status), and a single sender puts it to the gateway when its turn comes; the gateway logs it as executed at rung 3. Enquiries that were waiting for a yes when the rung rose are withdrawn: the approval becomes `voided` with reason `rung_changed`, nobody is named as having decided, and the enquiry is queued afresh only if it passes today's checks (otherwise it is closed unsent and the business can be drafted for again). One event each. This runs at the start of every run and on every ten minute round, which includes the one at boot.

### S3. The checks are the gate, so they are tighter and are made twice

Made when drafted, and again in the moment before sending:

- **One named service.** Each kind has a list of target services by name, with the words that show a business offers one. The enquiry asks about exactly one of them, by the list's own name, never the business's wording. A draft that does not name it, or that asks about "services" in general, is refused. A clinic with no listed treatment in view is asked about "a new patient consultation".
- **The right services, not just the right trade.** For solicitors, financial advisers, accountants and trades a business must be seen to offer a target service or it is set aside as `not_a_target_service` and never written to (a solicitor doing only immigration work, a plumber on call-outs). The analysis is asked which target service the pages show; code confirms it against the list. The Places search phrases were already specific to the service; the looseness was in what counted as a match.
- **No greeting by the time of day**, in the shapes or in a draft.
- **Sending hours.** Working days, 09:00 to 17:30 in the tenant's time zone (settings). Outside them an enquiry waits. `enquiry_no_send_dates` is a list of dates to skip, **seeded empty: the build does not know England's bank holidays and does not invent them.**
- Unchanged: one per business ever, the daily cap, the gap, suppression, the kill switch, no health, case, money or property details, no booking, no address, no links, signed.

### S4. Circuit breakers

Sending stops for the rest of the tenant's day, with one event and a line that opens the shortlist, when: more than three sends fail or bounce in a day; any reply reads as a complaint about being contacted (the opt-out detection, widened; that business is also suppressed); or the mailbox refuses the login. A refused login means the message certainly did not go, so that enquiry is put back in the queue and not marked failed. A bounce is not a reply and not a result: the business is not judged on its silence (`enquiry_bounced`), and the bounce's text is not kept. Stopping applies to approved enquiries as well as queued ones.

### S5. Reading it afterwards

Each shortlist opens with how many were sent without asking since the last was written, by kind (no names). Which enquiries a shortlist has told of is kept on it by id, so none is told of twice or missed. `GET /v1/rooms/:roomId/enquiries?since=` returns who was written to, the full text, when, the status and whether it went without an approval. That is personal data, like the approvals list, and nothing of it is in `/v1/house`.

### Could not do, or worth knowing

- Bank holidays are not known (S3).
- At rung 2, a yes given more than 24 hours before the next sending hours open (Friday evening for Monday) expires unsent, because an approval lasts 24 hours. At rung 3 nothing expires in the queue.
- Sending runs behind a run, so a shortlist is written before that run's enquiries have gone: they are told of on the next one, and a breaker tripped by them opens the next one.
- The complaint detection is a list of phrases plus the reply reader's own judgement. A complaint worded unlike any of them would not trip it.

## Evenings and weekends: sending slots and out-of-hours scoring, 17 Nov 2026

Salekh's correction: keeping test enquiries to working hours hid the thing he sells against. People enquire in the evening and at weekends, and a business that leaves those until the next afternoon is losing money. S3's "working days, 09:00 to 17:30" is replaced.

### W1. Sending every day, in three slots

Enquiries may go every day from 07:00 to 21:30 in the tenant's zone (settings), never in the small hours. The week is divided into three slots: `in_hours` (a working day, 09:00 to 17:30), `evening` (a working day, 17:30 until sending stops) and `weekend` (any other day, 09:00 to 17:30). An early weekday morning and a weekend evening belong to no slot. Each enquiry queued to send without asking is given the slot its kind of business has been tested in least over the last fortnight, so every kind is spread evenly across all three, and it waits for that slot (a weekend one drafted on Monday goes on Saturday). The slot is stored on the enquiry (`sent_slot`), with whether the business was open at the moment of sending by the hours Google shows (`opening_state`: open, closed, or unknown when Places gave none). Enquiries queued before there were slots are given one on the next round. `enquiry_slots` says which slots are in use. An enquiry a person approved (rung 2) goes in whichever slot is open.

`non_working_dates` (bank holidays: treated as a weekend day) and `enquiry_no_send_dates` (nothing sent at all) are both **seeded empty: the build knows no bank holidays and does not invent them.**

### W2. Out-of-hours scoring

"Sent while they were shut" means closed by Google's hours for that business, or, where there are none, sent in the evening or weekend slot. For such an enquiry the reply-speed part scores whether anything USEFUL came back and how soon against when they next opened: a person, or an automatic reply that answered the question or offered a booking. Bands: useful within 15 minutes 50; the same day while still shut 42; by the end of their first hour open (which includes anything useful sent in the night) 32; later the day they next opened 22; the day after (within 36 hours of opening) 12; nothing 0. A bare acknowledgement is noted and scores nothing. Automatic replies are therefore now read by the cheap model too, for whether they answered or offered a next step, with the same rule that a "yes" needs a sentence really in the reply. The note says both things: what useful came back and when, and the clock time to a person's reply. Sent while they were open, the working-hours bands apply unchanged, whatever the day.

When they next open is taken from Google's hours for the business, or from the working day in the settings when there are none, and is fixed at the moment of sending.

### W3. When it may be scored

24 hours after sending, or the end of the next working day for an evening or weekend send, whichever is later. Fixed at sending and stored with the test.

### W4. Rivals, same slot only

A rival proposed for a low scorer is queued for the same slot as that prospect's enquiry. On the card, a competitor tested in another slot is shown as "tested in working hours: not compared" and is never used in the line about who replied faster. The card says when the enquiry was sent in the tenant's own time and whether they were open: "Sent Tuesday 19:42, when they were closed".

### W5. The leak for an out-of-hours test

One more assumption per kind, `share_arriving_out_of_hours` (placeholder 30% to 50%, from no source). It is used only for a test sent while they were shut, and the workings say so. If something useful came back, no leak is estimated from that test.

### W6. Every kind, every run

A run searches one place for every kind that is switched on (the place that kind searched longest ago), then, if `areas_per_run` allows more, the pairs searched longest ago. The default limit on Places calls is 40, and calls are reported by kind. The day's enquiry allowance is shared evenly across kinds, one from each in turn, so a kind with fewer ready passes its share on.

### W7. The owner's settings on a server with no shell

`WH_OUTREACH_SETTINGS_PATCH` is base64 of a JSON object holding only what is to change. Objects are merged key by key, lists replace, and `business_types` is merged kind by kind. The result must pass the settings' own checks (an unknown key, a value past its limit, or anything that is not a setting stops the start, and nothing of the patch is applied). It is written as a new version in the owner's name. Its hash is kept, and a start that finds the same hash applies nothing. Rungs stay with `WH_ENQUIRY_RUNG`. If `WH_OUTREACH_ENABLED_TYPES` is also set it is applied first, on every start, so do not switch kinds in both.

### Worth knowing

- A weekend enquiry can wait up to six days for its slot. With three slots a third of each day's enquiries go that day in working hours, a third that evening, and a third on the next weekend day.
- Results sent before this change have no slot: they are scored and compared as before.
- "The same day while still shut" is by the calendar day in the tenant's zone.

