# Runner HTTP API, version 1

The contract between the runner and the house UI. The browser never calls the runner: the site's server calls it with a token and passes the result on.

Every request carries `Authorization: Bearer <WH_API_TOKEN>`. Without it the answer is 401. In local development the runner listens on 127.0.0.1 only. All bodies are JSON.

Room ids are `<business>:<department>`, for example `salekh-ventures:data`. Business ids: `roots`, `mastore`, `twilight`, `salekh-ventures`. Department ids: `data`, `ads`, `creative`, `customer-relations`, `engineering`, `research`.

> **Changed 16 Nov 2026 (deployment).** `GET /health` needs no token and answers `{"status":"ok"}` and nothing else. After ten requests with a wrong or missing token from one address in five minutes, further ones from that address are answered `429 {"error":"too_many_attempts"}` with a `Retry-After` header; a request with the right token is always let through. On a standby runner (`WH_ROLE=standby`), `POST /v1/rooms/:roomId/run` and a decision on an enquiry approval answer `409 {"reason":"standby"}`.

## GET /v1/house

Everything the house needs to draw itself. The UI polls this (about every 1.5 seconds). Nothing in it may contain personal data: log text and task text are the fixed summaries from the event stream.

```json
{
  "generatedAt": "2026-11-12T19:40:00.000Z",
  "killSwitch": { "global": false, "floors": [] },
  "rooms": [
    {
      "id": "salekh-ventures:data",
      "business": "salekh-ventures",
      "department": "data",
      "state": "idle",
      "task": "Nothing assigned",
      "pendingApprovalId": null,
      "proposal": null,
      "log": [{ "id": "evt_1", "at": "2026-11-12T19:39:10.000Z", "kind": "started", "text": "Run started" }],
      "outputs": [{ "id": "out_1", "at": "2026-11-12T19:39:40.000Z", "title": "Daily read", "runId": "run_1", "score": null }],
      "costTodayGbp": 0.04,
      "budgetTodayGbp": 1.5
    }
  ],
  "handoffs": [{ "id": "evt_9", "from": "chief", "to": "salekh-ventures:data", "at": "2026-11-12T19:39:09.000Z" }]
}
```

- `state` is one of `idle`, `working`, `waiting`, `done`, `failed`, `handoff`.
  - `working`: a run is in progress.
  - `waiting`: an approval for this room is pending. `pendingApprovalId` is set and `proposal` is `{ "title": string, "reason": string, "actionType": string, "rung": number, "expiresAt": string, "undoable": boolean }`.
  - `done`: the last run finished within the last 60 seconds.
  - `failed`: the last run failed and has not been acknowledged.
  - `handoff`: this room handed work on within the last 10 seconds.
  - otherwise `idle`.
- `log`: the last 14 events for the room, oldest first.
- `outputs`: the last 6 finished pieces of work, newest first.
- `handoffs`: handoffs and briefs from the last 30 seconds, so the UI can draw them once each (it remembers ids it has drawn).
- A room appears for every department registered on an active floor, whether or not it has ever run.

## GET /v1/outputs/:id

`{ "id", "roomId", "runId", "at", "title", "body" }` where `body` is the work itself as Markdown. 404 if unknown.

## POST /v1/outputs/:id/score

Body `{ "score": 1-10, "note": string? }`. A score under 9 without a note is refused with 422. Stores the score, and when under 9 creates a proposed memory note for that department (BRIEF.md section 10). Answers `{ "ok": true }`.

## POST /v1/approvals/:id

Body `{ "decision": "approve" | "reject" }`. Recorded as the tenant's owner. On approve the gateway carries out exactly the stored payload. Answers `{ "status": "approved" | "rejected" | "expired" | "voided" | "refused", "reason": string? }`.

> **Added 16 Nov 2026 (test enquiries).** For an approval whose action is `enquiry.send_email`, "approved" means the yes is recorded. The enquiry is then sent by the runner in turn, with a gap between sends (default 90 seconds) and within the day's allowance, so it may not have gone when this answers. `voided` with reason `payload_changed` means what would be sent is no longer what was shown: nothing is sent.

## GET /v1/rooms/:roomId/approvals  (added 16 Nov 2026)

The approvals waiting in one room, oldest first. Answers 404 for an unknown room.

```json
{ "approvals": [ {
  "id": "uuid", "payloadHash": "64 hex characters", "expiresAt": "ISO time", "actionType": "enquiry.send_email",
  "enquiry": { "business": "name", "town": "place or null", "purpose": "prospect | rival", "to": "address", "subject": "text", "body": "text" }
} ] }
```

`enquiry` is present only for `enquiry.send_email` and is exactly the stored payload: what is shown is what a yes sends. **This endpoint returns personal data on purpose** (a business's name and email address, and the message). It is the only one that does. `GET /v1/house` still carries none: there the room shows `state: "waiting"` and a task line with a count only, for example `"12 enquiries waiting for your yes"`. Do not cache or log this response.

## GET /v1/rooms/:roomId/enquiries?since=  (added 17 Nov 2026)

What was sent from one room, newest first. `since` is an ISO date and time; without it, the last seven days. At most 500. Answers 404 for an unknown room and 422 for a `since` that is not a date.

```json
{ "enquiries": [ {
  "id": "uuid", "business": "name", "town": "place or null", "kind": "clinics | solicitors | ...", "purpose": "prospect | rival",
  "to": "address", "subject": "text", "body": "text", "status": "queued | proposed | approved | sending | sent | failed | rejected | expired",
  "proposedAt": "ISO time", "sentAt": "ISO time or null", "withoutApproval": true
} ] }
```

`withoutApproval` is true for an enquiry that went (or is queued to go) at rung 3, with nobody's yes. **Like the approvals list, this returns personal data on purpose** and must not be cached or logged. When test enquiries are at rung 3 there is nothing to approve: the room is not `waiting`, the approvals list is empty, and each shortlist opens with how many were sent without asking.

## POST /v1/prospects/:prospectId/outcome  (added 18 Nov 2026)

What happened when Salekh telephoned a business from the call list. Body:

```json
{ "outcome": "no_answer | call_back | interested | meeting_booked | not_interested | wrong_person", "note": "text, optional, at most 1000 characters", "followUpOn": "YYYY-MM-DD, optional" }
```

`followUpOn` is allowed only with `call_back` or `interested`. Answers `{ "ok": true }`; 404 for a prospect that is not known (or not an id); 422 with a `reason` for anything else wrong. Append only: each call adds a record and none is changed or removed, so the history is kept. `not_interested` also suppresses the business for good, by its website, company number, name and postcode, and every address it was written to or publishes: it is never sent an enquiry again and never found again. Each recording writes one event with the fixed summary "A call outcome was recorded" and no payload. **The note is personal data** (it may name the person spoken to): it is never in an event or in `/v1/house`.

## GET /v1/rooms/:roomId/calls  (added 18 Nov 2026)

Every business in the room that has a shortlist card or any recorded call, newest shortlisted first. 404 for an unknown room.

```json
{ "calls": [ {
  "prospectId": "uuid", "name": "business name",
  "latest": { "outcome": "call_back", "note": "text or null", "followUpOn": "YYYY-MM-DD or null", "at": "ISO time" },
  "history": [ { "outcome": "...", "note": "...", "followUpOn": "...", "at": "..." } ]
} ] }
```

`latest` is null when no call is recorded; `history` is newest first. **Personal data on purpose** (the notes), like the approvals and enquiries lists: do not cache or log it.

> **Added 19 Nov 2026.** Each entry also has `"putBackAt": "ISO time or null"` (the owner put it back after its latest `not_interested`, and that still holds) and `"canPutBack": true | false` (its latest call is `not_interested`, it is not put back, and nothing the business itself did holds it off).

## POST /v1/prospects/:prospectId/put-back  (added 19 Nov 2026)

The owner undoes his own `not_interested`. Body: `{ "reason": "text, optional, at most 300 characters" }`. Answers `{ "ok": true, "lifted": n }`, the number of suppressions lifted (0 when it was already put back). 404 for an unknown prospect; 422 for a bad reason; 409 `not_after_this_outcome` when its latest call is not `not_interested`; 409 `they_asked_not_to_be_contacted` when the business, or any record of the same business, opted out, complained or bounced, or any of its keys is suppressed for anything but the owner's own call. The suppressions themselves are never changed (0019): a put-back is an append-only record that lifts only those the call list added. A later `not_interested` suppresses it again, and an opt-out after a put-back wins at once. Writes one event, "The owner put a business back on the call list", with no name.

Call notes and the words of finished follow-up emails are blanked once a business has had no new call or follow-up for 12 months (`WH_NOTES_KEEP_MONTHS`, 1 to 120), once a day (0020). Outcomes, dates, and that an email was sent and to which address are kept.

> **Added 18 Nov 2026 (follow-up emails).** The outcome body may also carry `"followUpTo": { "name": "text, optional", "email": "address" }`, allowed only with `interested`, `call_back` or `meeting_booked`; an address that does not look like one answers 422 and nothing is recorded. After one of those three outcomes WITH a note, a follow-up email is drafted in the background (one model call, a few seconds): see the follow-up routes below. The answer is still `{ "ok": true }`. Without `followUpTo` the draft has no recipient: the system never takes an address from anywhere else.

Each card in a Shortlist's Markdown carries its business's id on the line after its heading, as `<!-- prospect:<uuid> -->` (an HTML comment, not shown), and opens its profile with `- Estimated leak: £400 to £9,000 a month (estimate)` or `- Estimated leak: no figure (<why>)`. The output's `data.cards[]` has `prospect_id`, `estimated_leak` (`{ low, high, basis: "own_price" | "nearby_median" | "kind_median", workings }` or null) and `no_leak_reason`. Shortlists written before 18 Nov 2026 have neither line.

## Follow-up emails after a call  (added 18 Nov 2026)

A follow-up is sent, if at all, from the OWNER's mailbox (`OWNER_MAIL_*`, never the test mailbox) as the action `followup.send_email`: rung 2 (each needs a yes) unless the owner has chosen rung 3 (sent without asking), at most `followups_per_day` a day (seeded 20), never two to one business within 24 hours, never to a business that is suppressed or whose latest call says not interested, nothing while the kill switch is set. **Every route here returns or takes personal data on purpose** (who it is to and what it says): do not cache or log it. Nothing of it is in `/v1/house` or in any event; the house shows a count only, for example `"1 follow-up email waiting for your yes"`.

### GET /v1/rooms/:roomId/followups

The room's follow-ups, newest first: every one still open, and any other changed in the last 30 days. 404 for an unknown room.

```json
{
  "followups": [ {
    "id": "uuid", "prospectId": "uuid", "business": "name",
    "status": "draft | waiting_for_you | approved | sending | sent | failed | not_sent",
    "outcome": "interested | call_back | meeting_booked | null",
    "to": { "name": "text or null", "email": "address" },
    "subject": "text", "body": "text", "problems": ["what the checks found wrong"],
    "payloadHash": "64 hex characters, or null without a recipient",
    "createdAt": "ISO", "updatedAt": "ISO", "sentAt": "ISO or null", "from": "address it went from, or null",
    "copiedAt": "ISO or null", "reason": "why it was not sent or is held, a fixed code, or null"
  } ],
  "rung": 2,
  "ownerMailbox": { "configured": true, "address": "hello@... or null" },
  "drafting": ["prospect ids being drafted for just now"]
}
```

- `to` is null until Salekh gives a recipient; such a follow-up cannot be sent at any rung.
- `draft`: not waiting for anyone (no recipient, a check failing, edited at rung 3, or a yes that ran out). `waiting_for_you`: waiting for a yes. `approved`: the yes is recorded and it has not gone, because no owner mailbox is connected (`reason: "no_mailbox"`: copy it and send it yourself) or the gateway held it back (`kill_switch`, `cap_exceeded`, ...; press Send again later). `failed`: the mail server was reached and the send failed: it may have gone, and it is not tried again. `not_sent`: `you_said_do_not_send`, `replaced_by_a_newer_draft`, `suppressed`, `not_interested`.
- The checks, made on every draft and every edit: under 180 words, signed `Salekh Mahmood, Salekh Ventures` on the last line, no `£`, `$`, `€`, `%` or "per cent", no link, web address or email address in it, a recipient that is an email address. The model's own draft is also held to: no promise, no claim that it is already connected to their systems, ends with the ask for a 20-minute call this week, no number not in the facts, and the stored test result stated as stored.

### POST /v1/followups/:id

Body, any of: `{ "subject": "text", "body": "text", "to": { "name": "text?", "email": "address" } | null, "copied": true }`. Only while it is `draft`, `waiting_for_you` or `approved` (409 otherwise). The checks run again. **A change to the subject, the message or the address voids a yes, or the wait for one** (the approval becomes `voided`, reason `payload_changed`): it is a draft again, and at rung 2, if it passes, it is put to wait for a yes on what it now says, with a new `payloadHash`. An edit never sends anything, at any rung. `copied: true` notes that Salekh copied it to send himself (no change to what would be sent). Answers `{ "followup": { ... } }`; 422 for a bad field.

### POST /v1/followups/:id/decision

Body `{ "decision": "send" | "dont_send", "payloadHash": "the hash shown (needed with send)" }`. Answers 200 `{ "status": "...", "reason": "..."? }` with the follow-up's status afterwards, or 409 `{ "reason" }` when nothing could be done: `no_recipient`, `payload_mismatch` (it is not what was shown), `fails_checks`, `sent_in_the_last_24_hours`, `no_mailbox` (at rung 3, nothing to approve and nothing to send it with), `already_sent`, or a gateway refusal before any yes (`kill_switch`, `cap_exceeded`, ...). `send` on a draft puts it to the gateway and records the yes in one step; with no owner mailbox it ends at `{ "status": "approved", "reason": "no_mailbox" }` and nothing is sent. An answer given to a follow-up's approval through `POST /v1/approvals/:id` goes through this same code.

### POST /v1/rooms/:roomId/followup-rung

Body `{ "rung": 2 | 3, "reason": "text, optional" }`. The owner's switch: 2 "ask me first", 3 "send without asking". Recorded as a new version of the rung, in the owner's name, with the reason (a fixed one when none is given). Answers `{ "rung": n }`; 422 for anything else. At rung 3 a follow-up with a recipient is sent as soon as it is drafted, inside the cap and every check; without a recipient it waits. Follow-ups already waiting for a yes when the rung rises keep waiting: nobody approves them on Salekh's behalf.

### POST /v1/prospects/:prospectId/followup

Body `{ "note": "text, optional", "to": { "name"?, "email" }? }`. Draft a follow-up (again) now, in the background: 202 `{ "ok": true }`. The latest call must be `interested`, `call_back` or `meeting_booked` (409 `not_after_this_outcome` otherwise), and there must be a note, this one or that call's (422 otherwise). A new draft sets aside any follow-up for the same business that has not gone, withdrawing its yes.

## POST /v1/approvals/batch  (added 16 Nov 2026)

Body `{ "decisions": [ { "id": "uuid", "decision": "approve" | "reject", "payloadHash": "as shown" } ] }`, 1 to 200 items. Each item goes through the same code as `POST /v1/approvals/:id`, one at a time, in the order given. Always answers 200 with one result per item, in the same order:

```json
{ "results": [ { "id": "uuid", "status": "approved | rejected | expired | voided | refused | not_found | invalid", "reason": "string, sometimes" } ] }
```

Send back the `payloadHash` that was shown: if it does not match, that item is `refused` with reason `payload_mismatch` and nothing is sent. A body that is not a list of 1 to 200 items answers 422.

## POST /v1/kill-switch

Body `{ "on": boolean }`. Global. Answers `{ "killSwitch": { "global": boolean, "floors": [] } }`.

## POST /v1/rooms/:roomId/run

Starts one run of that department now, if it has an agent, is in budget and the kill switch is off. 202 with `{ "runId" }`, or 409 with `{ "reason" }` (for example `no_agent`, `over_budget`, `kill_switch`, `already_running`, `no_api_key`).

## POST /v1/rooms/:roomId/acknowledge

Clears a `failed` state once Salekh has looked. Answers `{ "ok": true }`.

## POST /v1/ask

Body `{ "text": string, "answers": "instruction id, optional" }`. Salekh tells the Chief of Staff something in his own words (1 to 1000 characters), or answers a question it asked (`answers`: an instruction whose status is `needs_answer`, else 409 `not_waiting_for_an_answer`). Stored at once and answered 202 `{ "id" }`; one model call reads it in the background (the kill switch and the `chief-of-staff` daily budget apply, as to any run). Code then decides, from runner/src/chief/instructions.ts:

- a setting from the closed list (follow-ups ask first, pause a floor, a kind of business on or off, a place added or taken off): `proposed`. Nothing changes until his yes, below.
- "send follow-ups without asking" or "start a stopped floor": `not_done`, with where his own switch is. The Chief of Staff can never raise a rung or lift a stop.
- a change to code or behaviour: `waiting_engineering`, a ticket for a Claude Code session (`npm run tickets`, and `npm run tickets -- done <id> "<note>"`).
- unclear: `needs_answer`, with one question.

**Returns his own words on purpose** (here and below): nothing he typed is in `/v1/house` or in any event. A standby answers 409 `standby`.

## GET /v1/instructions

The last 30, newest first: `{ "instructions": [{ "id", "at", "said", "answers", "status", "restated", "department", "kind", "change", "question", "note", "updatedAt" }] }`. `status` is one of `reading`, `proposed`, `done`, `not_done`, `waiting_engineering`, `needs_answer`, `answered`. `change` is the change in plain words, when one is proposed or was made.

## POST /v1/instructions/:id

Body `{ "decision": "yes" | "no" }`, for a `proposed` change only (else 409 `not_waiting_for_a_yes`). A yes makes the change through the owner's own code path (the UI's role, in the owner's name, with the reason "asked for through the Chief of Staff"), checked again against the closed list. Answers `{ "instruction" }`.
