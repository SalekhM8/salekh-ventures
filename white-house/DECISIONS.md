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
