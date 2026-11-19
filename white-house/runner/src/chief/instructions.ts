import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelCaller } from "../agents/model-caller.js";
import { engageKillSwitch } from "../control/config.js";
import { isUuid, lock, type Db, type Tx } from "../control/db.js";
import { emitEvent } from "../control/events.js";
import { finishRun, startRun } from "../control/runs.js";
import { changeOutreachSettings } from "../outreach/admin.js";
import { addTo, chiefSchema, noTotals } from "../outreach/stages.js";
import type { z } from "zod";

/**
 * The Chief of Staff: Salekh types an instruction in his own words, one model call reads it, and CODE decides what
 * happens (agents/chief-of-staff.md is what the model is told; this file is what is allowed):
 *
 *   setting      one change from the closed list below. Only ever PROPOSED: nothing changes until Salekh says yes, and
 *                then it is made through the same owner-only code as the app's own switches (the UI's database role,
 *                as the owner). The changes here only ever tighten or move within limits Salekh already set: none of
 *                them raises a rung, lifts a stop or sends anything. Asked to raise a rung or lift a stop, it says
 *                where his own switch is, and does nothing.
 *   engineering  a change to code or behaviour: stored as a ticket for a Claude Code session (`npm run tickets`).
 *                Shown as "Waiting for engineering" until a session marks it done. Never "done" before that.
 *   question     not clear enough: one short question back. His answer is a new instruction that points at it.
 *
 * Why not the gateway: the gateway acts on the world outside the house, inside caps, and the database lets its role
 * only ever tighten a setting. These are the owner's own settings, so the owner's yes is the approval, and the change
 * goes through the owner's code path, exactly as if he had pressed the switch himself.
 *
 * Everything is append only: instructions, and every step after (instruction_updates). Nothing he typed goes in an
 * event; events carry fixed words and a fixed code.
 */

export const CHIEF_MODEL = "claude-sonnet-5-5" as const;
export const CHIEF_DEPARTMENT = "chief-of-staff";
const REASON = "asked for through the Chief of Staff, and confirmed by the owner";

export type InstructionStatus = "reading" | "proposed" | "done" | "not_done" | "waiting_engineering" | "needs_answer" | "answered";
export type ChiefRead = z.infer<typeof chiefSchema>;

/** What the Chief of Staff may change, once Salekh says yes. Nothing else, whatever the model says. */
export const ALLOWED_CHANGES = ["followups_ask_first", "pause_floor", "kind_off", "kind_on", "add_place", "remove_place"] as const;
export type AllowedChange = (typeof ALLOWED_CHANGES)[number];

/** Asked for, but only Salekh can do it, with his own switch. Code never does these for him. */
export const OWNER_ONLY: Record<string, string> = {
  followups_send_without_asking: "Only you can do that one: it's the switch above the follow-up emails on the call list.",
  resume_floor: "Only you can start a stopped floor again: press Resume on that floor.",
};

export interface Change {
  what: AllowedChange;
  /** The floor's slug. */
  floor: string;
  kind_id?: string;
  place?: string;
}

export interface OutreachFloor {
  businessId: string;
  slug: string;
  name: string;
  kinds: { id: string; name: string; enabled: boolean }[];
  places: string[];
}

export interface Decision {
  status: Exclude<InstructionStatus, "reading" | "answered">;
  restated: string;
  department: ChiefRead["department"];
  kind: ChiefRead["kind"];
  change: Change | null;
  question: string | null;
  ticket: string | null;
  note: string | null;
}

const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const PLACE = /^[A-Za-z][A-Za-z' .-]{1,59}$/;

/** Plain words for a change, as Salekh sees it on the panel. */
export function describeChange(change: Change, floors: OutreachFloor[]): string {
  const floor = floors.find((f) => f.slug === change.floor);
  const on = floors.length > 1 && floor ? ` on ${floor.name}` : "";
  const kind = floor?.kinds.find((k) => k.id === change.kind_id)?.name ?? change.kind_id ?? "";
  switch (change.what) {
    case "followups_ask_first": return `Follow-up emails will wait for your yes before they go${on}.`;
    case "pause_floor": return `Everything on ${floor?.name ?? change.floor} stops until you press Resume.`;
    case "kind_off": return `Stop looking for ${kind}${on}.`;
    case "kind_on": return `Start looking for ${kind} again${on}.`;
    case "add_place": return `Add ${change.place} to the places searched${on}.`;
    case "remove_place": return `Stop searching ${change.place}${on}.`;
  }
}

/**
 * What happens to one reading. Plain code, no model: the model's answer is a suggestion, and this is where it is
 * held to the closed list. Raising a rung and lifting a stop are refused here, and again when the change is made.
 */
export function route(read: ChiefRead, floors: OutreachFloor[]): Decision {
  const restated = clip(read.restated, 300) || "I read your instruction.";
  const base = { restated, department: read.department, kind: read.kind, change: null, question: null, ticket: null, note: null };
  const ask = (question: string): Decision => ({ ...base, status: "needs_answer", question: clip(question, 400) });

  if (read.kind === "question") return ask(read.question.trim() || "What would you like me to change?");
  if (read.kind === "engineering") {
    const ticket = read.ticket.trim();
    if (!ticket) return ask("What should change, and how will you know it's right?");
    return { ...base, status: "waiting_engineering", ticket: ticket.slice(0, 3000) };
  }

  // A setting.
  const setting = { ...base, department: "outreach" as const };
  if (read.change === "none") return ask("Which setting do you want changed?");
  const ownerOnly = OWNER_ONLY[read.change];
  if (ownerOnly) return { ...setting, status: "not_done", note: ownerOnly };
  if (!(ALLOWED_CHANGES as readonly string[]).includes(read.change)) return ask("Which setting do you want changed?");
  const what = read.change as AllowedChange;

  if (floors.length === 0) return { ...setting, status: "not_done", note: "There's no Outreach department to change yet." };
  const named = read.floor.trim();
  const floor = named ? floors.find((f) => same(f.slug, named) || same(f.name, named)) : floors.length === 1 ? floors[0] : undefined;
  if (!floor) return ask(`Which floor: ${floors.map((f) => f.name).join(" or ")}?`);
  const done = (note: string): Decision => ({ ...setting, status: "done", note });
  const propose = (change: Change): Decision => ({ ...setting, status: "proposed", change });

  switch (what) {
    case "followups_ask_first":
    case "pause_floor":
      return propose({ what, floor: floor.slug });
    case "kind_off":
    case "kind_on": {
      const given = read.kind_id.trim();
      const kind = given ? floor.kinds.find((k) => same(k.id, given) || same(k.name, given)) : undefined;
      if (!kind) return ask(`Which kind of business: ${floor.kinds.map((k) => k.name).join(", ")}?`);
      if (kind.enabled === (what === "kind_on")) return done(what === "kind_on" ? `Already looking for ${kind.name}.` : `Already not looking for ${kind.name}.`);
      return propose({ what, floor: floor.slug, kind_id: kind.id });
    }
    case "add_place": {
      const place = read.place.trim();
      if (!PLACE.test(place)) return ask("Which town or city?");
      if (floor.places.some((p) => same(p, place))) return done(`${place} is already searched.`);
      return propose({ what, floor: floor.slug, place });
    }
    case "remove_place": {
      const place = floor.places.find((p) => same(p, read.place));
      if (!place) return ask(read.place.trim() && PLACE.test(read.place.trim()) ? `${read.place.trim()} isn't one of the places searched. Which place did you mean?` : "Which town or city?");
      return propose({ what, floor: floor.slug, place });
    }
  }
}

// ---- the store ---------------------------------------------------------------------

export interface InstructionView {
  id: string;
  at: string;
  said: string;
  answers: string | null;
  status: InstructionStatus;
  restated: string | null;
  department: string | null;
  kind: string | null;
  /** In plain words, when a change is proposed or was made. */
  change: string | null;
  question: string | null;
  note: string | null;
  updatedAt: string;
}

interface UpdateInput {
  status: InstructionStatus;
  restated?: string | null;
  department?: string | null;
  kind?: string | null;
  change?: Change | null;
  question?: string | null;
  ticket?: string | null;
  note?: string | null;
  byKind: "system" | "member" | "engineering";
  memberId?: string | null;
  /** The floor a change is for. */
  businessId?: string | null;
  now: Date;
}

async function addUpdate(t: Tx, tenantId: string, instructionId: string, u: UpdateInput): Promise<void> {
  await t.query(
    `insert into instruction_updates (tenant_id, instruction_id, status, restated, department, kind, change, question, ticket, note, by_kind, member_id, business_id, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
    [tenantId, instructionId, u.status, u.restated ?? null, u.department ?? null, u.kind ?? null, u.change ? JSON.stringify(u.change) : null,
     u.question ?? null, u.ticket ?? null, u.note ?? null, u.byKind, u.memberId ?? null, u.businessId ?? null, u.now],
  );
  // Fixed words only: never what he typed.
  await emitEvent(t, { tenantId, businessId: null, department: CHIEF_DEPARTMENT, type: "stage", now: u.now, summary: `An instruction to the Chief of Staff is now: ${u.status.replace(/_/g, " ")}`, reasonCode: `instruction_${u.status}` });
}

/** The newest step of each instruction, and the reading it is based on. */
const CURRENT = `
  select i.instruction_id, i.said, i.answers, i.created_at,
         cur.status, cur.note, cur.question as cur_question, cur.created_at as updated_at, cur.change as cur_change,
         rd.restated, rd.department, rd.kind, rd.change, rd.question, rd.ticket
    from instructions i
    join lateral (select * from instruction_updates u where u.instruction_id = i.instruction_id order by u.seq desc limit 1) cur on true
    left join lateral (select * from instruction_updates u where u.instruction_id = i.instruction_id and u.kind is not null order by u.seq desc limit 1) rd on true`;

export async function currentOf(t: Tx, instructionId: string): Promise<any | null> {
  if (!isUuid(instructionId)) return null;
  return (await t.query(`${CURRENT} where i.instruction_id = $1`, [instructionId])).rows[0] ?? null;
}

// ---- tickets, for an engineering session ----------------------------------------------

export interface Ticket { id: string; at: string; said: string; restated: string | null; department: string | null; ticket: string }

/** Every engineering ticket still waiting, oldest first. */
export async function openTickets(db: Db, tenantId: string): Promise<Ticket[]> {
  return db.tx(tenantId, async (t) => {
    const rows = (await t.query(`${CURRENT} where cur.status = 'waiting_engineering' order by i.created_at`)).rows;
    return rows.map((r) => ({ id: r.instruction_id, at: new Date(r.created_at).toISOString(), said: r.said, restated: r.restated, department: r.department, ticket: r.ticket }));
  });
}

/** An engineering session marks a ticket done, with a note Salekh will read. Only a ticket still waiting can be. */
export async function markTicketDone(db: Db, tenantId: string, id: string, note: string, now = new Date()): Promise<"done" | "not_found" | "not_waiting"> {
  const text = note.trim();
  if (!text || text.length > 2000) throw new Error("a note of 1 to 2000 characters is needed: what was done, in plain words");
  return db.tx(tenantId, async (t) => {
    if (!isUuid(id)) return "not_found";
    await lock(t, "instruction", id);
    const cur = await currentOf(t, id);
    if (!cur) return "not_found";
    if (cur.status !== "waiting_engineering") return "not_waiting";
    await addUpdate(t, tenantId, id, { status: "done", note: text, byKind: "engineering", now });
    return "done";
  });
}

// ---- the Chief of Staff in the runtime -------------------------------------------------

export interface InstructionDeps {
  /** The gateway's role: reads and writes instructions, runs and events. */
  db: Db;
  /** The UI's role: makes the change, as the owner, on his yes. */
  uiDb: Db;
  tenantId: string;
  clock: () => Date;
  model: ModelCaller | null;
  apiKey: () => Promise<string | null>;
  whRoot: string;
  usdToGbp: number;
  floors: () => Promise<OutreachFloor[]>;
  ownerId: () => Promise<string | null>;
  /** The follow-up switch, set to "ask me first" (2). The only rung this file can set, and it is the lower one. */
  followupsAskFirst: (businessId: string, reason: string) => Promise<{ ok: boolean; reason?: string }>;
  changed: () => void;
  track: (key: string, work: Promise<void>) => void;
  /** A standby reads nothing and changes nothing. */
  standby: boolean;
}

type Answer<T> = ({ status: 200 | 202 } & T) | { status: 404 } | { status: 409 | 422; reason: string };

const NOT_READ: Record<string, string> = {
  no_model: "I can't read instructions yet: no model is connected to me.",
  no_api_key: "I can't read instructions yet: no model is connected to me.",
  no_prompt: "I can't read instructions yet: my instructions file is missing.",
  kill_switch: "Everything is stopped, so I haven't read it. Press Resume, then ask again.",
  budget_exceeded: "I've used today's budget for reading instructions. Ask again tomorrow, or raise my budget.",
  budget_not_configured: "I have no daily budget set, so I can't read instructions yet.",
  failed: "I couldn't read that one. Try again in a minute.",
};

export function createInstructions(deps: InstructionDeps) {
  const { db, tenantId } = deps;
  const tx = <T>(fn: (t: Tx) => Promise<T>) => db.tx(tenantId, fn);

  function view(r: any, floors: OutreachFloor[]): InstructionView {
    const change = (r.cur_change ?? r.change) as Change | null;
    return {
      id: r.instruction_id, at: new Date(r.created_at).toISOString(), said: r.said, answers: r.answers ?? null, status: r.status,
      restated: r.restated ?? null, department: r.department ?? null, kind: r.kind ?? null,
      change: change && ["proposed", "done"].includes(r.status) ? describeChange(change, floors) : null,
      question: r.status === "needs_answer" ? (r.cur_question ?? r.question ?? null) : null,
      note: r.note ?? null, updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  /** What the model is given: the instruction, the conversation it answers, and what can be changed. */
  async function userText(id: string, floors: OutreachFloor[]): Promise<string> {
    const chain: { said: string; question: string | null }[] = [];
    let at: string | null = id;
    for (let i = 0; at && i < 5; i += 1) {
      const r: any = await tx((t) => currentOf(t, at as string));
      if (!r) break;
      chain.unshift({ said: r.said, question: r.question ?? null });
      at = r.answers ?? null;
    }
    const lines: string[] = [];
    chain.forEach((c, i) => {
      lines.push(i === chain.length - 1 ? `Instruction (now): ${c.said}` : `Earlier he said: ${c.said}`);
      if (i < chain.length - 1 && c.question) lines.push(`You asked: ${c.question}`);
    });
    lines.push("", floors.length ? "Floors with an Outreach department:" : "No floor has an Outreach department.");
    for (const f of floors) {
      lines.push(`- floor id "${f.slug}" (${f.name})`);
      lines.push(`  kinds of business: ${f.kinds.map((k) => `"${k.id}" ${k.name} (${k.enabled ? "on" : "off"})`).join(", ")}`);
      lines.push(`  places searched: ${f.places.join(", ") || "none listed"}`);
    }
    return lines.join("\n");
  }

  async function read(id: string): Promise<void> {
    const now = deps.clock();
    const fail = async (why: string) => {
      await tx((t) => addUpdate(t, tenantId, id, { status: "not_done", note: NOT_READ[why] ?? NOT_READ.failed, byKind: "system", now: deps.clock() }));
      deps.changed();
    };
    if (!deps.model) return fail("no_model");
    const apiKey = await deps.apiKey();
    if (!apiKey) return fail("no_api_key");
    const system = await readFile(path.join(deps.whRoot, "agents", "chief-of-staff.md"), "utf8").catch(() => null);
    if (!system) return fail("no_prompt");
    const floors = await deps.floors();
    const user = await userText(id, floors);
    // The kill switch and the Chief of Staff's budget are checked here, like any run.
    const started = await startRun(db, { tenantId, businessId: null, department: CHIEF_DEPARTMENT, trigger: "chief:instruction", model: CHIEF_MODEL }, { now });
    if (!started.started) return fail(started.reason);
    const totals = noTotals();
    let data: ChiefRead | null = null;
    try {
      const reply = await deps.model.call(apiKey, { stage: "chief", model: CHIEF_MODEL, system, user, schema: chiefSchema, maxTokens: 2000, effort: "low" });
      addTo(totals, reply);
      data = reply.ok ? (reply.data as ChiefRead) : null;
    } finally {
      await finishRun(db, {
        tenantId, runId: started.runId, status: data ? "done" : "failed",
        tokensIn: Math.round(totals.inputTokens + totals.cacheCreationTokens), tokensOut: Math.round(totals.outputTokens), tokensCached: Math.round(totals.cacheReadTokens),
        costUsd: totals.costUsd, costGbp: Math.round(totals.costUsd * deps.usdToGbp * 1e6) / 1e6, ...(data ? {} : { error: "instruction_not_read" }),
      }, { now: deps.clock() });
    }
    if (!data) return fail("failed");
    const d = route(data, floors);
    const businessId = d.change ? (floors.find((f) => f.slug === d.change?.floor)?.businessId ?? null) : null;
    await tx((t) => addUpdate(t, tenantId, id, { ...d, businessId, byKind: "system", now: deps.clock() }));
    deps.changed();
  }

  /** He typed an instruction (or answered a question). Stored at once; read in the background. */
  async function ask(body: unknown): Promise<Answer<{ id: string }>> {
    if (deps.standby) return { status: 409, reason: "standby" };
    const b = (body ?? {}) as { text?: unknown; answers?: unknown };
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text || text.length > 1000) return { status: 422, reason: "text must be 1 to 1000 characters" };
    const answers = b.answers === undefined || b.answers === null ? null : String(b.answers);
    const now = deps.clock();
    const made = await tx(async (t): Promise<Answer<{ id: string }>> => {
      if (answers) {
        await lock(t, "instruction", answers);
        const parent = await currentOf(t, answers);
        if (!parent) return { status: 404 };
        if (parent.status !== "needs_answer") return { status: 409, reason: "not_waiting_for_an_answer" };
      }
      const id = (await t.query("insert into instructions (tenant_id, answers, said, created_at) values ($1, $2, $3, $4) returning instruction_id", [tenantId, answers, text, now])).rows[0].instruction_id as string;
      if (answers) await addUpdate(t, tenantId, answers, { status: "answered", byKind: "member", memberId: await deps.ownerId(), now });
      await addUpdate(t, tenantId, id, { status: "reading", byKind: "system", now });
      return { status: 202, id };
    });
    if (made.status !== 202) return made;
    deps.changed();
    deps.track(`chief:${made.id}`, read(made.id).catch(async (err) => {
      console.error(`chief of staff: reading failed: ${err instanceof Error ? err.name : "error"}`);
      await tx((t) => addUpdate(t, tenantId, made.id, { status: "not_done", note: NOT_READ.failed, byKind: "system", now: deps.clock() })).catch(() => undefined);
    }));
    return made;
  }

  async function list(): Promise<{ instructions: InstructionView[] }> {
    const floors = await deps.floors();
    const rows = await tx(async (t) => (await t.query(`${CURRENT} order by i.created_at desc limit 30`)).rows);
    return { instructions: rows.map((r) => view(r, floors)) };
  }

  /** Make one allowed change, as the owner. Checked again here: the stored change is not trusted either. */
  async function apply(change: Change, floors: OutreachFloor[], owner: string): Promise<{ ok: true } | { ok: false; note: string }> {
    if (!(ALLOWED_CHANGES as readonly string[]).includes(change.what)) return { ok: false, note: "That isn't a change I'm allowed to make." };
    const floor = floors.find((f) => f.slug === change.floor);
    if (!floor) return { ok: false, note: "That floor no longer has an Outreach department." };
    try {
      switch (change.what) {
        case "followups_ask_first": {
          const r = await deps.followupsAskFirst(floor.businessId, REASON);
          return r.ok ? { ok: true } : { ok: false, note: "The follow-up switch couldn't be changed." };
        }
        case "pause_floor":
          await engageKillSwitch(deps.uiDb, { tenantId, businessId: floor.businessId, memberId: owner, reason: REASON, now: deps.clock() });
          return { ok: true };
        case "kind_off":
        case "kind_on":
          await changeOutreachSettings(deps.uiDb, tenantId, `${floor.slug}:outreach`, change.what === "kind_on" ? { enableTypes: [change.kind_id as string] } : { disableTypes: [change.kind_id as string] }, REASON);
          return { ok: true };
        case "add_place":
        case "remove_place":
          await changeOutreachSettings(deps.uiDb, tenantId, `${floor.slug}:outreach`, change.what === "add_place" ? { addAreas: [change.place as string] } : { removeAreas: [change.place as string] }, REASON);
          return { ok: true };
      }
    } catch (err) {
      console.error(`chief of staff: a change could not be made: ${err instanceof Error ? err.name : "error"}`);
      return { ok: false, note: "The change couldn't be made. Nothing was changed." };
    }
  }

  /** His yes or no to a proposed change. */
  async function decide(id: string, body: unknown): Promise<Answer<{ instruction: InstructionView }>> {
    if (deps.standby) return { status: 409, reason: "standby" };
    const decision = (body as { decision?: unknown } | null)?.decision;
    if (decision !== "yes" && decision !== "no") return { status: 422, reason: "decision must be yes or no" };
    const owner = await deps.ownerId();
    if (!owner) return { status: 409, reason: "no_owner" };
    const cur = await tx((t) => currentOf(t, id));
    if (!cur) return { status: 404 };
    if (cur.status !== "proposed" || !cur.change) return { status: 409, reason: "not_waiting_for_a_yes" };
    const floors = await deps.floors();
    const result = decision === "yes" ? await apply(cur.change as Change, floors, owner) : { ok: false as const, note: "You said no, so nothing was changed." };
    // Recorded only if it is still waiting: two presses make one record.
    await tx(async (t) => {
      await lock(t, "instruction", id);
      const now = await currentOf(t, id);
      if (now?.status !== "proposed") return;
      await addUpdate(t, tenantId, id, result.ok
        ? { status: "done", change: cur.change, note: "Done.", byKind: "member", memberId: owner, businessId: floors.find((f) => f.slug === cur.change.floor)?.businessId ?? null, now: deps.clock() }
        : { status: "not_done", note: result.note, byKind: "member", memberId: owner, now: deps.clock() });
    });
    deps.changed();
    const after = await tx((t) => currentOf(t, id));
    return { status: 200, instruction: view(after, floors) };
  }

  return { ask, list, decide, read };
}

export type Instructions = ReturnType<typeof createInstructions>;
