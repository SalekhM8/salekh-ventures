"use client";

/* The Outreach shortlist as Salekh wants it: who to call, why, and their score.
   Read from the report's own text, which is written in a fixed shape by the
   runner, so today's reports work without being written again. The full
   report stays one click away.

   Each card records what happened on the call. Calls are kept by the
   business's id, so the same business shows the same history on every
   shortlist it appears in.

   After Interested, Call back or Meeting booked with a note, the runner
   writes a follow-up email. It shows on the card to check, change, send,
   copy or drop. Nothing is sent without Salekh pressing Send, unless he
   has switched follow-ups to "send without asking".

   After Interested or Meeting booked, or when he presses "Make a plan",
   the Closer writes a one-page plan for the next call: what we found, what
   we'd set up, what they might say, and the price. It is for him only and
   is never sent to anyone. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { C, SANS, SERIF } from "./model";
import { Markdown } from "./Markdown";
import type { CallOutcome, CallRecord, Followup, FollowupAnswer, FollowupEdit, FollowupList, OutcomeInput, Plan, PlanList, ProspectCalls } from "./live";

export type Lead = {
  rank: number;
  name: string;
  /** The business's id, from the marker the runner writes under each heading. Null on reports written before it. */
  prospectId: string | null;
  score: number | null;
  kind: string;
  town: string;
  happened: string;
  rival: string | null;
  who: string;
  phone: string | null;
  route: string | null;
  opener: string;
  message: string;
  /** "£400 to £9,000 a month", or null when there is no figure. */
  leak: string | null;
  /** The sum behind the figure, or why there is none. */
  leakWorkings: string;
  /** No figure for want of prices (rather than, say, a quick reply). */
  leakNoPrice: boolean;
  section: string;
};

const after = (text: string, label: string) => {
  const m = new RegExp(`^- ${label}: (.*)$`, "m").exec(text);
  return m ? m[1].trim() : "";
};
const block = (text: string, heading: string) => {
  const i = text.indexOf(`**${heading}`);
  if (i < 0) return "";
  const start = text.indexOf("\n\n", i);
  const end = text.indexOf("\n\n", start + 2);
  return text.slice(start + 2, end < 0 ? undefined : end).trim();
};

const KIND: Record<string, string> = {
  "private dental and aesthetics clinics": "Clinic",
  "solicitors for conveyancing and family law": "Solicitor",
  "independent financial advisers and mortgage brokers": "Financial adviser",
  "estate and letting agents": "Estate agent",
  "accountants for small businesses": "Accountant",
};

const REISSUED = " (issued again: rivals' results are in)";

/** The estimate, from the one-line form at the top of the profile, or from the full line on older reports. */
function leakOf(section: string): Pick<Lead, "leak" | "leakWorkings" | "leakNoPrice"> {
  const line = after(section, "Estimated leak");
  const full = /\*\*Estimated leak: (£[\d,]+ to £[\d,]+ a month)\.\*\*.*?Workings: (.*?)\.?$/m.exec(section);
  const none = /\*\*Estimated leak: no figure\.\*\* (.*)$/m.exec(section);
  if (line.startsWith("£") || full) {
    return { leak: line ? line.replace(/\s*\(estimate\)\s*$/, "") : (full?.[1] ?? null), leakWorkings: full?.[2] ?? "", leakNoPrice: false };
  }
  const untested = /\*\*Capture score: none\.\*\*/.test(section) ? "not tested yet" : "";
  const why = (line.match(/^no figure \((.*)\)$/)?.[1] ?? none?.[1] ?? untested).replace(/\.$/, "");
  return { leak: null, leakWorkings: why ? why.charAt(0).toUpperCase() + why.slice(1) + "." : "", leakNoPrice: !why || /price/i.test(why) };
}

/** The leads in a shortlist report, worst first. Empty when the text is not a shortlist. */
export function parseShortlist(body: string): Lead[] {
  const heads = [...body.matchAll(/^## (\d+)\. (.+)$/gm)];
  return heads
    .map((h, k) => {
      const start = h.index ?? 0;
      const end = k + 1 < heads.length ? (heads[k + 1].index ?? body.length) : body.length;
      const section = body.slice(start, end);
      const score = /\*\*Capture score: (\d+)/.exec(section);
      const kindRaw = after(section, "Kind of business");
      const where = after(section, "Where");
      const reply = /- reply speed: \d+ of \d+\. (.*)$/m.exec(section)?.[1] ?? "";
      const quality = /- reply quality: \d+ of \d+\. (.*)$/m.exec(section)?.[1] ?? "";
      // The fastest rival that replied, from the comparison lines under the table (one line each).
      const minutes = (n: string, unit: string) => Number(n) * (unit.startsWith("hour") ? 60 : 1);
      const cmpStart = section.indexOf("Sources:");
      const cmpEnd = section.indexOf("**Why they can afford");
      const comparison = cmpStart >= 0 ? section.slice(cmpStart, cmpEnd > cmpStart ? cmpEnd : undefined) : "";
      // Rival names come from the comparison table's header row; their reply times from the lines under it.
      const header = /^\| \| (.+) \|$/m.exec(section)?.[1]?.split(" | ").map((n) => n.trim()) ?? [];
      const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rivals = header.slice(1).flatMap((name) => {
        const m = new RegExp(`${esc(name)} replied to the same kind of enquiry in (\\d+(?:\\.\\d+)?) (minutes?|hours?)`).exec(comparison);
        return m ? [{ name: name.split(" - ")[0], time: `${m[1]} ${m[2]}`, mins: minutes(m[1], m[2]) }] : [];
      });
      const fastest = rivals.sort((a, b) => a.mins - b.mins)[0];
      const rival = fastest ? [fastest.name, fastest.time] : null;
      const phone = /^\s+- phone: (\+?[\d][\d ]*\d)/m.exec(section)?.[1]?.trim() ?? null;
      const best = after(section, "Best route");
      const who = after(section, "Who").replace(/\s*\(source: [^)]*\)/g, "");
      const prospectId = /^<!-- prospect:([0-9a-f-]{36}) -->$/m.exec(section)?.[1] ?? null;
      return {
        rank: Number(h[1]),
        name: h[2].replace(REISSUED, "").replace(/[\s\u2000-\u2BFF\uFE0F]+$/u, "").trim(),
        prospectId,
        score: score ? Number(score[1]) : null,
        kind: KIND[kindRaw] ?? (kindRaw.startsWith("home improvement") ? "Trades" : kindRaw),
        town: where.split(",")[0] ?? "",
        happened: [reply, /no reply to assess/i.test(quality) ? "" : quality].filter(Boolean).join(" "),
        rival: rival ? `${rival[0]} replied to the same question in ${rival[1]}.` : null,
        who: who.startsWith("no named person") ? "Owner or practice manager (no name found)" : who,
        phone,
        route: best ? best.split(". Why:")[0] : null,
        opener: block(section, "Call opener"),
        message: block(section, "First message"),
        ...leakOf(section),
        section: section.replace(/^## \d+\. /, "## "),
      };
    })
    .sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
}

// ---- calls ----------------------------------------------------------------

const OUTCOMES: { id: CallOutcome; label: string }[] = [
  { id: "no_answer", label: "No answer" },
  { id: "call_back", label: "Call back" },
  { id: "interested", label: "Interested" },
  { id: "meeting_booked", label: "Meeting booked" },
  { id: "not_interested", label: "Not interested" },
  { id: "wrong_person", label: "Wrong person" },
];
const LABEL = Object.fromEntries(OUTCOMES.map((o) => [o.id, o.label])) as Record<CallOutcome, string>;
const WITH_DATE: CallOutcome[] = ["call_back", "interested"];
/** After these, with a note, a follow-up email is written. */
const FOLLOW_UP: CallOutcome[] = ["interested", "call_back", "meeting_booked"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Filter = "to_call" | "follow_ups" | "done" | "all";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "to_call", label: "To call" },
  { id: "follow_ups", label: "Follow ups" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

/** Today on this phone, as YYYY-MM-DD. */
const today = () => new Date().toLocaleDateString("en-CA");
/** "18 Nov", from a moment. */
const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
/** "Fri 21 Nov", from a date with no time. */
const dateOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function filterOf(latest: CallRecord | null | undefined, putBackAt?: string | null): Exclude<Filter, "all"> {
  if (!latest || putBackAt) return "to_call";
  switch (latest.outcome) {
    case "no_answer":
      return "to_call";
    case "call_back":
      return !latest.followUpOn || latest.followUpOn <= today() ? "to_call" : "follow_ups";
    case "interested":
      return "follow_ups";
    default:
      return "done";
  }
}

function said(c: CallRecord): string {
  return `Called ${dayOf(c.at)}: ${LABEL[c.outcome]}.${c.followUpOn ? ` Follow up ${dateOf(c.followUpOn)}.` : ""}`;
}

/** Reading and recording calls through the runner. Both must keep the same identity between renders (useCallback). */
export type CallsApi = {
  load: (roomId: string) => Promise<ProspectCalls[] | null>;
  save: (prospectId: string, body: OutcomeInput) => Promise<string | null>;
  /** Undo a "not interested" pressed by mistake. Null when done, or why not. */
  putBack: (prospectId: string) => Promise<string | null>;
};

/** Follow-up emails through the runner. Each function must keep its identity between renders (useCallback). */
export type FollowupApi = {
  load: (roomId: string) => Promise<FollowupList | null>;
  edit: (id: string, body: FollowupEdit) => Promise<FollowupAnswer>;
  decide: (id: string, decision: "send" | "dont_send", payloadHash: string | null) => Promise<FollowupAnswer>;
  request: (prospectId: string) => Promise<FollowupAnswer>;
  setRung: (roomId: string, rung: 2 | 3) => Promise<FollowupAnswer>;
};

/** The Closer's plans through the runner. Each function must keep its identity between renders (useCallback). */
export type PlanApi = {
  load: (roomId: string) => Promise<PlanList | null>;
  request: (prospectId: string) => Promise<string | null>;
};

const tone = (s: number | null) => (s === null ? "#8a7a72" : s < 40 ? "#B3261E" : s < 70 ? "#B26A00" : "#1c7046");

export function CallList({
  leads,
  report,
  roomId,
  loadCalls,
  saveOutcome,
  putBack,
  followupApi,
  planApi,
}: {
  leads: Lead[];
  report: string;
  roomId?: string;
  loadCalls?: CallsApi["load"];
  saveOutcome?: CallsApi["save"];
  putBack?: CallsApi["putBack"];
  followupApi?: FollowupApi;
  planApi?: PlanApi;
}) {
  const calls = roomId && loadCalls && saveOutcome ? true : false;
  const loadFollowups = followupApi?.load;
  const [fu, setFu] = useState<FollowupList | null>(null);
  const reloadFollowups = useCallback(async () => {
    if (!roomId || !loadFollowups) return;
    const got = await loadFollowups(roomId);
    if (got) setFu(got);
  }, [roomId, loadFollowups]);
  useEffect(() => {
    if (!roomId || !loadFollowups) return;
    let live = true;
    void loadFollowups(roomId).then((got) => {
      if (live && got) setFu(got);
    });
    return () => {
      live = false;
    };
  }, [roomId, loadFollowups]);
  // While a follow-up is being written, look again every few seconds.
  const writing = (fu?.drafting.length ?? 0) > 0;
  useEffect(() => {
    if (!writing) return;
    const timer = setInterval(() => void reloadFollowups(), 4000);
    return () => clearInterval(timer);
  }, [writing, reloadFollowups]);
  const loadPlans = planApi?.load;
  const [pl, setPl] = useState<PlanList | null>(null);
  const reloadPlans = useCallback(async () => {
    if (!roomId || !loadPlans) return;
    const got = await loadPlans(roomId);
    if (got) setPl(got);
  }, [roomId, loadPlans]);
  useEffect(() => {
    if (!roomId || !loadPlans) return;
    let live = true;
    void loadPlans(roomId).then((got) => {
      if (live && got) setPl(got);
    });
    return () => {
      live = false;
    };
  }, [roomId, loadPlans]);
  // While a plan is being written, look again every few seconds.
  const planning = (pl?.making.length ?? 0) > 0;
  useEffect(() => {
    if (!planning) return;
    const timer = setInterval(() => void reloadPlans(), 4000);
    return () => clearInterval(timer);
  }, [planning, reloadPlans]);
  const planOf = useMemo(() => new Map((pl?.plans ?? []).map((p) => [p.prospectId, p])), [pl]);
  /** The newest follow-up for each business. */
  const followupOf = useMemo(() => {
    const by = new Map<string, Followup>();
    for (const f of fu?.followups ?? []) if (!by.has(f.prospectId)) by.set(f.prospectId, f);
    return by;
  }, [fu]);
  const [open, setOpen] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const [filter, setFilter] = useState<Filter>("to_call");
  const [known, setKnown] = useState<ProspectCalls[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    if (!roomId || !loadCalls) return;
    const got = await loadCalls(roomId);
    if (got) setKnown(got);
    setLoadFailed(got === null);
  }, [roomId, loadCalls]);
  useEffect(() => {
    if (!roomId || !loadCalls) return;
    let live = true;
    void loadCalls(roomId).then((got) => {
      if (!live) return;
      if (got) setKnown(got);
      setLoadFailed(got === null);
    });
    return () => {
      live = false;
    };
  }, [roomId, loadCalls]);

  /** Each lead's business id: from its marker, or on an older report by its exact name when exactly one business has it. */
  const idOf = useMemo(() => {
    const byName = new Map<string, string[]>();
    for (const k of known ?? []) byName.set(k.name, [...(byName.get(k.name) ?? []), k.prospectId]);
    return (l: Lead): string | null => {
      if (l.prospectId) return l.prospectId;
      const ids = byName.get(l.name) ?? [];
      return ids.length === 1 ? (ids[0] ?? null) : null;
    };
  }, [known]);
  const byId = useMemo(() => new Map((known ?? []).map((k) => [k.prospectId, k])), [known]);
  const tabOf = (l: Lead) => {
    const id = idOf(l);
    const k = id ? byId.get(id) : undefined;
    return filterOf(k?.latest ?? null, k?.putBackAt ?? null);
  };

  const counts = { to_call: 0, follow_ups: 0, done: 0, all: leads.length };
  for (const l of leads) counts[tabOf(l)] += 1;
  const shown = filter === "all" ? leads : leads.filter((l) => tabOf(l) === filter);

  if (full)
    return (
      <div>
        <button type="button" onClick={() => setFull(false)} style={pill}>
          ← Back to the call list
        </button>
        <div className="mt-4">
          <Markdown text={report} />
        </div>
      </div>
    );

  const toCall = leads.filter((l) => l.score !== null && l.score < 70).length;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p style={{ font: `400 15px/1.5 ${SANS}`, color: "#4a3b34" }}>
          <strong style={{ color: C.ink }}>{leads.length} businesses tested</strong>, worst first. {toCall} scored under 70. The lower the score, the more
          enquiries they lose.
        </p>
        <button type="button" onClick={() => setFull(true)} style={pill}>
          View full report
        </button>
      </div>

      <div role="tablist" aria-label="Which calls to show" className="mt-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            style={{ ...pill, minHeight: 36, padding: "0 12px", background: filter === f.id ? C.ink : "transparent", color: filter === f.id ? C.surface : C.ink }}
          >
            {f.label} <span style={{ opacity: 0.75 }}>{counts[f.id]}</span>
          </button>
        ))}
      </div>
      {roomId && followupApi && fu && <FollowupSwitch roomId={roomId} list={fu} setRung={followupApi.setRung} onChanged={reloadFollowups} />}

      {calls && loadFailed && (
        <p className="mt-2" style={{ font: `400 13px/1.45 ${SANS}`, color: "#B3261E" }}>
          Could not load what was recorded on earlier calls.{" "}
          <button type="button" onClick={() => void load()} style={{ ...link }}>
            Try again
          </button>
        </p>
      )}

      {shown.length === 0 && (
        <p className="mt-4" style={{ font: `400 14px/1.5 ${SANS}`, color: "#7a6a62" }}>
          Nothing here.
        </p>
      )}

      <ol className="mt-4 grid min-w-0 gap-3" style={{ listStyle: "none", padding: 0, gridTemplateColumns: "minmax(0, 1fr)" }}>
        {shown.map((l) => {
          const id = idOf(l);
          const record = id ? byId.get(id) : undefined;
          return (
            <li key={l.rank} className="min-w-0 rounded-2xl p-3.5 sm:p-4" style={{ background: C.surface, border: `1.5px solid ${C.blush}`, overflowWrap: "anywhere" }}>
              <div className="flex items-start gap-3 sm:gap-4">
                <div
                  className="flex flex-none flex-col items-center justify-center rounded-full"
                  style={{ width: 52, height: 52, border: `3px solid ${tone(l.score)}`, color: tone(l.score) }}
                  aria-label={`Score ${l.score ?? "not measured"} out of 100`}
                >
                  <span style={{ font: `600 20px/1 ${SANS}` }}>{l.score ?? "–"}</span>
                  <span style={{ font: `500 9px/1 ${SANS}`, opacity: 0.8 }}>/100</span>
                </div>
                <div className="min-w-0 flex-1">
                  <h3 style={{ font: `300 22px/1.15 ${SERIF}`, letterSpacing: "-0.02em", color: C.ink }}>{l.name}</h3>
                  <p style={{ marginTop: 2, font: `500 12.5px/1.4 ${SANS}`, color: "#7a6a62" }}>{[l.kind, l.town].filter(Boolean).join(" · ")}</p>

                  <dl className="mt-3 grid gap-1.5" style={{ font: `400 14px/1.45 ${SANS}`, color: "#33271f" }}>
                    <Row label="What happened">{l.happened || "Not tested yet."}</Row>
                    {l.rival && <Row label="Their rival">{l.rival}</Row>}
                    <Row label="Could be losing">
                      <Leak lead={l} />
                    </Row>
                    <Row label="Ask for">{l.who}</Row>
                    <Row label="Call">
                      {l.phone ? (
                        <a href={`tel:${l.phone.replace(/[^\d+]/g, "")}`} style={{ color: C.ink, fontWeight: 600, textDecoration: "underline" }}>
                          {l.phone}
                        </a>
                      ) : (
                        "no phone found"
                      )}
                      {l.route && !l.route.startsWith("phone") ? <span style={{ color: "#7a6a62" }}> · or {l.route}</span> : null}
                    </Row>
                  </dl>

                  {l.opener && (
                    <p className="mt-3 rounded-xl p-3" style={{ background: C.panel, font: `400 14px/1.5 ${SANS}`, color: C.ink }}>
                      <span style={{ display: "block", font: `600 10.5px/1.4 ${SANS}`, letterSpacing: "0.18em", textTransform: "uppercase", color: C.terracotta }}>
                        Say this
                      </span>
                      “{l.opener}”
                    </p>
                  )}

                  <Outcome
                    prospectId={id}
                    record={record}
                    save={calls ? saveOutcome : undefined}
                    putBack={calls ? putBack : undefined}
                    onSaved={async () => {
                      await load();
                      await reloadFollowups();
                      await reloadPlans();
                    }}
                    followups={Boolean(followupApi)}
                    why={!calls ? "Not connected to the runner, so outcomes cannot be saved here." : "Record outcomes from tomorrow's list."}
                  />

                  {id && followupApi && fu && (fu.drafting.includes(id) || followupOf.has(id)) && (
                    <FollowupCard
                      followup={followupOf.get(id) ?? null}
                      writing={fu.drafting.includes(id)}
                      mailbox={fu.ownerMailbox}
                      rung={fu.rung}
                      api={followupApi}
                      prospectId={id}
                      onChanged={reloadFollowups}
                    />
                  )}

                  {id && planApi && pl && (
                    <PlanCard
                      plan={planOf.get(id) ?? null}
                      writing={pl.making.includes(id)}
                      notInterested={record?.latest?.outcome === "not_interested"}
                      request={() => planApi.request(id)}
                      onChanged={reloadPlans}
                    />
                  )}

                  <button type="button" onClick={() => setOpen(open === l.rank ? null : l.rank)} className="mt-3" style={pill}>
                    {open === l.rank ? "Hide full profile" : "Full profile"}
                  </button>
                  {open === l.rank && (
                    <div className="mt-3 border-t pt-3" style={{ borderColor: C.blush }}>
                      {l.message && (
                        <div className="mb-4">
                          <span style={{ font: `600 10.5px/1.4 ${SANS}`, letterSpacing: "0.18em", textTransform: "uppercase", color: C.terracotta }}>
                            Message to send{l.route ? ` (${l.route.split(",")[0]})` : ""}
                          </span>
                          <p className="mt-1" style={{ font: `400 14px/1.55 ${SANS}`, whiteSpace: "pre-wrap" }}>
                            {l.message}
                          </p>
                        </div>
                      )}
                      <Markdown text={l.section} />
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The estimated monthly leak, with its workings one tap away. */
function Leak({ lead }: { lead: Lead }) {
  const [open, setOpen] = useState(false);
  if (!lead.leak) {
    const text = lead.leakNoPrice ? "Not enough price data yet" : "No figure";
    return (
      <span>
        {text}
        {lead.leakWorkings && !lead.leakNoPrice ? <span style={{ color: "#7a6a62" }}>. {lead.leakWorkings}</span> : null}
      </span>
    );
  }
  return (
    <span>
      <strong style={{ fontWeight: 600 }}>{lead.leak}</strong>{" "}
      <span style={{ font: `600 10.5px/1 ${SANS}`, letterSpacing: "0.08em", textTransform: "uppercase", padding: "2px 6px", borderRadius: 6, background: C.panel, color: "#7a6a62" }}>
        estimate
      </span>
      {lead.leakWorkings && (
        <>
          {" "}
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} style={link}>
            {open ? "Hide workings" : "How?"}
          </button>
          {open && (
            <span className="mt-1 block" style={{ font: `400 13px/1.5 ${SANS}`, color: "#4a3b34" }}>
              {lead.leakWorkings}. Anything marked ASSUMPTION is a guess, not a measurement.
            </span>
          )}
        </>
      )}
    </span>
  );
}

/** The buttons for what happened on the call, the note, and what was saved before. */
function Outcome({
  prospectId,
  record,
  save,
  putBack,
  onSaved,
  why,
  followups,
}: {
  prospectId: string | null;
  record: ProspectCalls | undefined;
  save?: CallsApi["save"];
  putBack?: CallsApi["putBack"];
  onSaved: () => Promise<void>;
  why: string;
  /** Whether follow-up emails can be asked for here. */
  followups: boolean;
}) {
  const [picked, setPicked] = useState<CallOutcome | null>(null);
  const [note, setNote] = useState("");
  const [date, setDate] = useState("");
  const [toName, setToName] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState(false);
  const enabled = Boolean(prospectId && save);
  const latest = record?.latest ?? null;
  const earlier = record?.history.slice(1) ?? [];

  const undo = async () => {
    if (!prospectId || !putBack) return;
    setBusy(true);
    setError("");
    const failed = await putBack(prospectId);
    setBusy(false);
    if (failed) {
      setError(failed === "they_asked_not_to_be_contacted" ? "They asked not to be contacted, so they can't be put back." : `Not put back: ${failed}`);
      return;
    }
    await onSaved();
  };

  const submit = async () => {
    if (!prospectId || !save || !picked) return;
    const withEmail = followups && FOLLOW_UP.includes(picked) && toEmail.trim();
    if (withEmail && !EMAIL.test(toEmail.trim())) {
      setError("That email address does not look right.");
      return;
    }
    setBusy(true);
    setError("");
    const body: OutcomeInput = {
      outcome: picked,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(date && WITH_DATE.includes(picked) ? { followUpOn: date } : {}),
      ...(withEmail ? { followUpTo: { email: toEmail.trim(), ...(toName.trim() ? { name: toName.trim() } : {}) } } : {}),
    };
    const failed = await save(prospectId, body);
    setBusy(false);
    if (failed) {
      setError(`Not saved: ${failed}`);
      return;
    }
    setPicked(null);
    setNote("");
    setDate("");
    setToName("");
    setToEmail("");
    await onSaved();
  };

  return (
    <div className="mt-3 rounded-xl p-3" style={{ border: `1px solid ${C.blush}` }}>
      {latest && (
        <div className="mb-2" style={{ font: `400 14px/1.45 ${SANS}`, color: C.ink }}>
          <strong style={{ fontWeight: 600 }}>{said(latest)}</strong>
          {latest.note && <p style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>{latest.note}</p>}
          {record?.putBackAt && <p style={{ marginTop: 2, fontWeight: 600, color: "#1c7046" }}>You put them back on the list on {dayOf(record.putBackAt)}.</p>}
          {record?.canPutBack && putBack && (
            <div className="mt-2 grid gap-1">
              <button type="button" onClick={() => void undo()} disabled={busy} style={{ ...pill, justifySelf: "start" }}>
                {busy ? "Putting back…" : "Put back on the list"}
              </button>
              <span style={{ font: `400 13px/1.45 ${SANS}`, color: "#7a6a62" }}>Pressed Not interested by mistake? This lets you contact them again.</span>
            </div>
          )}
          {earlier.length > 0 && (
            <>
              <button type="button" onClick={() => setHistory(!history)} aria-expanded={history} style={{ ...link, marginTop: 4 }}>
                {history ? "Hide earlier calls" : `Earlier calls (${earlier.length})`}
              </button>
              {history && (
                <ul className="mt-1 grid gap-1.5" style={{ listStyle: "none", padding: 0, font: `400 13px/1.45 ${SANS}`, color: "#4a3b34" }}>
                  {earlier.map((c) => (
                    <li key={c.at}>
                      {said(c)}
                      {c.note ? <span style={{ display: "block", whiteSpace: "pre-wrap" }}>{c.note}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
      <span style={{ font: `600 10.5px/1.4 ${SANS}`, letterSpacing: "0.18em", textTransform: "uppercase", color: C.terracotta }}>
        {latest ? "Record another call" : "What happened on the call?"}
      </span>
      <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 128px), 1fr))" }}>
        {OUTCOMES.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={!enabled || busy}
            aria-pressed={picked === o.id}
            onClick={() => setPicked(picked === o.id ? null : o.id)}
            style={{
              ...pill,
              minHeight: 44,
              padding: "0 10px",
              width: "100%",
              background: picked === o.id ? C.ink : "transparent",
              color: picked === o.id ? C.surface : C.ink,
              opacity: enabled ? 1 : 0.45,
              cursor: enabled ? "pointer" : "not-allowed",
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      {!enabled && (
        <p className="mt-2" style={{ font: `400 13px/1.45 ${SANS}`, color: "#7a6a62" }}>
          {why}
        </p>
      )}
      {enabled && picked && (
        <div className="mt-3 grid gap-2">
          {WITH_DATE.includes(picked) && (
            <label style={{ font: `600 12px/1.45 ${SANS}`, color: "#7a6a62" }}>
              Follow up on (optional)
              <input type="date" value={date} min={today()} onChange={(e) => setDate(e.target.value)} style={{ ...field, display: "block", marginTop: 4 }} />
            </label>
          )}
          <label style={{ font: `600 12px/1.45 ${SANS}`, color: "#7a6a62" }}>
            Notes (optional)
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 1000))}
              rows={3}
              maxLength={1000}
              placeholder="Who you spoke to, what they said"
              style={{ ...field, display: "block", marginTop: 4, resize: "vertical" }}
            />
          </label>
          {followups && FOLLOW_UP.includes(picked) && (
            <fieldset className="grid min-w-0 gap-2" style={{ border: "none", margin: 0, padding: 0 }}>
              <legend style={{ font: `600 12px/1.45 ${SANS}`, color: "#7a6a62", padding: 0 }}>Email to (optional)</legend>
              <input type="text" value={toName} onChange={(e) => setToName(e.target.value.slice(0, 120))} placeholder="Their name" autoComplete="off" aria-label="Their name" style={field} />
              <input
                type="email"
                inputMode="email"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value.slice(0, 254))}
                placeholder="Their email address"
                autoComplete="off"
                autoCapitalize="none"
                aria-label="Their email address"
                style={field}
              />
              <p style={{ font: `400 13px/1.45 ${SANS}`, color: "#7a6a62" }}>
                {note.trim()
                  ? "A follow-up email will be written from your note for you to check. Without an address you can add one later."
                  : "Add a note and a follow-up email will be written from it for you to check."}
              </p>
            </fieldset>
          )}
          <button type="button" onClick={() => { if (picked === "not_interested" && !window.confirm("Never contact them again? If you press this by mistake you can put them back from Done.")) return; void submit(); }} disabled={busy} style={{ ...pill, background: picked === "not_interested" ? "#B3261E" : C.ink, color: C.surface, justifySelf: "start" }}>
            {busy ? "Saving…" : `Save: ${LABEL[picked]}`}
          </button>
          {picked === "not_interested" && (
            <p style={{ font: `600 13.5px/1.45 ${SANS}`, color: "#B3261E" }}>
              This means never contact them again. If they asked you to email them, pick Call back or Interested instead and add the address.
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="mt-2" style={{ font: `400 13px/1.45 ${SANS}`, color: "#B3261E" }}>
          {error}
        </p>
      )}
    </div>
  );
}

// ---- follow-up emails ------------------------------------------------------------

/** Why something did not happen, in plain words. Codes come from the runner (API.md). */
const WHY: Record<string, string> = {
  no_recipient: "Add who it is to first.",
  payload_mismatch: "It changed since you looked. Check it and press Send again.",
  fails_checks: "It breaks one of the rules shown above. Change it first.",
  sent_in_the_last_24_hours: "They had a follow-up in the last 24 hours. Try again tomorrow.",
  cap_exceeded: "Today's limit of follow-up emails has been reached. It can go tomorrow.",
  kill_switch: "Everything is stopped. It can go once you start things again.",
  budget_exceeded: "Today's budget is used up.",
  suppressed: "This business must not be contacted.",
  not_interested: "They said they are not interested.",
  no_mailbox: "No mailbox is connected for sending, so copy it and send it yourself.",
  you_said_do_not_send: "You chose not to send it.",
  replaced_by_a_newer_draft: "A newer one replaced it.",
  recommend_only: "Follow-up emails are set to suggest only.",
  already_sent: "It has already gone.",
  draft_failed: "It could not be written to the rules. Try again.",
  not_after_this_outcome: "A follow-up is written only after Interested, Call back or Meeting booked.",
};
const why = (code: string | null | undefined) => (code ? (WHY[code] ?? `Not done (${code.replace(/_/g, " ")}).`) : "");

/** "18 Nov 16:20". */
const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
};

function FollowupSwitch({ roomId, list, setRung, onChanged }: { roomId: string; list: FollowupList; setRung: FollowupApi["setRung"]; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alone = list.rung >= 3;
  const choose = async (rung: 2 | 3) => {
    if (busy || (rung === 3) === alone) return;
    setBusy(true);
    setError("");
    const r = await setRung(roomId, rung);
    setBusy(false);
    if (!r.ok) setError(`Not changed: ${why(r.reason)}`);
    await onChanged();
  };
  const option = (rung: 2 | 3, label: string) => {
    const on = (rung === 3) === alone;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={on}
        disabled={busy}
        onClick={() => void choose(rung)}
        style={{ ...pill, minHeight: 40, padding: "0 12px", flex: "1 1 140px", background: on ? C.ink : "transparent", color: on ? C.surface : C.ink }}
      >
        {label}
      </button>
    );
  };
  return (
    <div className="mt-4 min-w-0 rounded-xl p-3" style={{ border: `1px solid ${C.blush}` }}>
      <span style={{ font: `600 10.5px/1.4 ${SANS}`, letterSpacing: "0.18em", textTransform: "uppercase", color: C.terracotta }}>Follow-up emails</span>
      <div role="radiogroup" aria-label="Follow-up emails" className="mt-2 flex flex-wrap gap-2">
        {option(2, "Ask me first")}
        {option(3, "Send without asking")}
      </div>
      <p className="mt-2" style={{ font: `400 13px/1.45 ${SANS}`, color: "#4a3b34" }}>
        {alone
          ? "Each follow-up goes as soon as it is written, if you gave an email address. Never more than 20 a day, and never two to the same business within a day."
          : "Each follow-up waits on its card until you press Send."}{" "}
        {list.ownerMailbox.configured
          ? `They go from ${list.ownerMailbox.address ?? "your mailbox"}.`
          : "No mailbox is connected for sending yet, so nothing is sent: copy each one and send it yourself."}
      </p>
      {error && <p style={{ font: `400 13px/1.45 ${SANS}`, color: "#B3261E" }}>{error}</p>}
    </div>
  );
}

/** One follow-up email on its card: who it is to, what it says (editable), and Send, Don't send, Copy. */
function FollowupCard({
  followup,
  writing,
  mailbox,
  rung,
  api,
  prospectId,
  onChanged,
}: {
  followup: Followup | null;
  writing: boolean;
  mailbox: FollowupList["ownerMailbox"];
  rung: number;
  api: FollowupApi;
  prospectId: string;
  onChanged: () => Promise<void>;
}) {
  const [subject, setSubject] = useState(followup?.subject ?? "");
  const [body, setBody] = useState(followup?.body ?? "");
  const [toName, setToName] = useState(followup?.to?.name ?? "");
  const [toEmail, setToEmail] = useState(followup?.to?.email ?? "");
  const [seen, setSeen] = useState(followup?.updatedAt ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  // A newer version from the runner replaces what is in the boxes (once saved, or written again).
  if (followup && followup.updatedAt !== seen) {
    setSeen(followup.updatedAt);
    setSubject(followup.subject);
    setBody(followup.body);
    setToName(followup.to?.name ?? "");
    setToEmail(followup.to?.email ?? "");
  }

  const label = <span style={{ font: `600 10.5px/1.4 ${SANS}`, letterSpacing: "0.18em", textTransform: "uppercase", color: C.terracotta }}>Follow-up email</span>;
  if (!followup) {
    return (
      <div className="mt-3 rounded-xl p-3" style={{ background: C.panel }}>
        {label}
        <p className="mt-1" style={{ font: `400 14px/1.45 ${SANS}`, color: C.ink }}>
          Writing the follow-up email from your note…
        </p>
      </div>
    );
  }

  const open = ["draft", "waiting_for_you", "approved"].includes(followup.status);
  const toChanged = toEmail.trim() !== (followup.to?.email ?? "") || toName.trim() !== (followup.to?.name ?? "");
  const dirty = subject !== followup.subject || body !== followup.body || toChanged;
  const run = async (work: () => Promise<FollowupAnswer>, done?: (r: Extract<FollowupAnswer, { ok: true }>) => string) => {
    setBusy(true);
    setMessage("");
    const r = await work();
    setBusy(false);
    setMessage(r.ok ? (done?.(r) ?? "") : why(r.reason));
    await onChanged();
    return r;
  };
  const save = () => {
    if (toEmail.trim() && !EMAIL.test(toEmail.trim())) {
      setMessage("That email address does not look right.");
      return;
    }
    void run(() =>
      api.edit(followup.id, {
        ...(subject !== followup.subject ? { subject } : {}),
        ...(body !== followup.body ? { body } : {}),
        ...(toChanged ? { to: toEmail.trim() ? { email: toEmail.trim(), ...(toName.trim() ? { name: toName.trim() } : {}) } : null } : {}),
      }),
    );
  };
  const send = () => void run(() => api.decide(followup.id, "send", followup.payloadHash), (r) => (r.status === "sent" ? "" : why(r.reason)));
  const drop = () => void run(() => api.decide(followup.id, "dont_send", null));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${followup.subject}\n\n${followup.body}`);
    } catch {
      setMessage("Could not copy here. Select the text and copy it by hand.");
      return;
    }
    setCopied(true);
    // With no mailbox connected, copying it is how it is approved: the yes is recorded, so nothing waits in the house.
    if (!mailbox.configured && followup.status === "waiting_for_you" && followup.payloadHash) await api.decide(followup.id, "send", followup.payloadHash);
    await run(() => api.edit(followup.id, { copied: true }));
  };

  const status =
    followup.status === "sent" && followup.sentAt
      ? `Sent ${when(followup.sentAt)}${followup.from ? ` from ${followup.from.split("@")[0]}@` : ""}`
      : followup.copiedAt || copied
        ? "Copied: send it yourself"
        : followup.status === "sending"
          ? "Sending…"
          : followup.status === "failed"
            ? `It may not have gone. Look in the Sent folder${followup.from ? ` of ${followup.from}` : ""} before sending it again.`
            : followup.status === "not_sent"
              ? `Not sent. ${why(followup.reason)}`
              : !followup.to
                ? "Add who it is to before it can be sent."
                : !mailbox.configured
                  ? "No mailbox is connected for sending: copy it and send it yourself."
                  : followup.status === "approved"
                    ? `You said send. Not gone yet: ${why(followup.reason) || "it will go when you press Send again."}`
                    : rung >= 3
                      ? "Ready. Press Send to send it."
                      : "Waiting for you to press Send.";

  return (
    <div className="mt-3 min-w-0 rounded-xl p-3" style={{ background: C.panel }}>
      {label}
      <p className="mt-1" style={{ font: `600 13.5px/1.45 ${SANS}`, color: followup.status === "sent" ? "#1c7046" : C.ink }}>
        {status}
      </p>
      {writing && <p style={{ font: `400 13px/1.45 ${SANS}`, color: "#7a6a62" }}>A new one is being written…</p>}

      <div className="mt-2 grid min-w-0 gap-2">
        <label style={{ font: `600 12px/1.45 ${SANS}`, color: "#7a6a62" }}>
          To
          {open ? (
            <span className="mt-1 grid gap-2">
              <input type="text" value={toName} onChange={(e) => setToName(e.target.value.slice(0, 120))} placeholder="Their name" aria-label="Their name" autoComplete="off" style={field} />
              <input
                type="email"
                inputMode="email"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value.slice(0, 254))}
                placeholder="Their email address"
                aria-label="Their email address"
                autoComplete="off"
                autoCapitalize="none"
                style={field}
              />
            </span>
          ) : (
            <span className="mt-1 block" style={{ font: `400 14px/1.45 ${SANS}`, color: C.ink }}>
              {followup.to ? `${followup.to.name ? `${followup.to.name}, ` : ""}${followup.to.email}` : "nobody"}
            </span>
          )}
        </label>
        <label style={{ font: `600 12px/1.45 ${SANS}`, color: "#7a6a62" }}>
          Subject
          <input type="text" value={subject} readOnly={!open} onChange={(e) => setSubject(e.target.value.slice(0, 200))} style={{ ...field, display: "block", marginTop: 4 }} />
        </label>
        <label style={{ font: `600 12px/1.45 ${SANS}`, color: "#7a6a62" }}>
          Message
          <textarea value={body} readOnly={!open} onChange={(e) => setBody(e.target.value.slice(0, 4000))} rows={9} style={{ ...field, display: "block", marginTop: 4, resize: "vertical" }} />
        </label>
        {followup.problems.length > 0 && !dirty && (
          <ul style={{ margin: 0, paddingLeft: 18, font: `400 13px/1.45 ${SANS}`, color: "#B3261E" }}>
            {followup.problems.map((p) => (
              <li key={p}>{p.charAt(0).toUpperCase() + p.slice(1)}.</li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {open && dirty && (
          <button type="button" disabled={busy} onClick={save} style={{ ...pill, background: C.ink, color: C.surface }}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        )}
        {open && !dirty && mailbox.configured && (
          <button
            type="button"
            disabled={busy || !followup.to || followup.problems.length > 0}
            onClick={send}
            style={{ ...pill, background: C.ink, color: C.surface, opacity: !followup.to || followup.problems.length > 0 ? 0.45 : 1 }}
          >
            {busy ? "Sending…" : "Send"}
          </button>
        )}
        {open && (
          <button type="button" disabled={busy} onClick={drop} style={pill}>
            Don&apos;t send
          </button>
        )}
        <button type="button" disabled={busy || dirty} onClick={() => void copy()} style={pill}>
          {copied ? "Copied" : "Copy"}
        </button>
        {!open && followup.status !== "sending" && (
          <button type="button" disabled={busy} onClick={() => void run(() => api.request(prospectId), () => "A new one is being written.")} style={pill}>
            Write it again
          </button>
        )}
      </div>
      {message && (
        <p className="mt-2" style={{ font: `400 13px/1.45 ${SANS}`, color: "#4a3b34" }}>
          {message}
        </p>
      )}
    </div>
  );
}

const PLAN_WHY: Record<string, string> = {
  not_interested: "They said not interested, so there's no plan to make.",
  standby: "This is the standby runner. Try again in a minute.",
  not_signed_in: "Sign in again to make a plan.",
  runner_unreachable: "Couldn't reach the runner. Try again.",
};

/** The Closer's plan for the next call: shown folded, one tap to read, and "Make a plan" to write one (again). */
function PlanCard({
  plan,
  writing,
  notInterested,
  request,
  onChanged,
}: {
  plan: Plan | null;
  writing: boolean;
  notInterested: boolean;
  request: () => Promise<string | null>;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (notInterested && !plan) return null;
  const make = async () => {
    setBusy(true);
    setError("");
    const why = await request();
    setBusy(false);
    if (why) setError(PLAN_WHY[why] ?? `Couldn't make a plan (${why.replace(/_/g, " ")}).`);
    await onChanged();
  };
  return (
    <div className="mt-3 rounded-xl p-3" style={{ border: `1.5px solid ${C.blush}`, background: C.surface }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span style={{ font: `600 10.5px/1.4 ${SANS}`, letterSpacing: "0.18em", textTransform: "uppercase", color: C.terracotta }}>
          Plan for the next call
        </span>
        <span style={{ font: `400 12.5px/1.4 ${SANS}`, color: "#7a6a62" }}>
          {writing ? "Writing it now…" : plan ? `Written ${when(plan.createdAt)} · for you only` : "For you only, never sent"}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {plan && (
          <button type="button" onClick={() => setOpen(!open)} style={pill}>
            {open ? "Hide plan" : "Read plan"}
          </button>
        )}
        {!notInterested && (
          <button type="button" onClick={() => void make()} disabled={busy || writing} style={{ ...pill, opacity: busy || writing ? 0.6 : 1 }}>
            {plan ? "Write it again" : "Make a plan"}
          </button>
        )}
      </div>
      {error && (
        <p className="mt-2" style={{ font: `400 13px/1.45 ${SANS}`, color: "#B3261E" }}>
          {error}
        </p>
      )}
      {plan && open && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: C.blush }}>
          <Markdown text={plan.body} />
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-3 sm:grid-cols-[110px_1fr]">
      <dt style={{ font: `600 12px/1.45 ${SANS}`, color: "#7a6a62" }}>{label}</dt>
      <dd style={{ margin: 0, minWidth: 0 }}>{children}</dd>
    </div>
  );
}

const pill: React.CSSProperties = {
  minHeight: 40,
  padding: "0 16px",
  borderRadius: 999,
  border: `1.5px solid ${C.ink}`,
  background: "transparent",
  color: C.ink,
  font: `600 13.5px/1 ${SANS}`,
  cursor: "pointer",
};

const link: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: C.ink,
  font: `600 13px/1.4 ${SANS}`,
  textDecoration: "underline",
  cursor: "pointer",
};

/* 16px so an iPhone does not zoom in when the field is tapped. */
const field: React.CSSProperties = {
  width: "100%",
  maxWidth: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  borderRadius: 12,
  border: `1.5px solid ${C.blush}`,
  background: C.surface,
  color: C.ink,
  font: `400 16px/1.4 ${SANS}`,
};
