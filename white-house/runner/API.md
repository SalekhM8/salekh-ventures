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

Body `{ "question": string }`. The Chief of Staff. Not built yet: answers 501 `{ "reason": "not_built" }`.
