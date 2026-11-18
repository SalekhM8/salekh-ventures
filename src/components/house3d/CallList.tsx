"use client";

/* The Outreach shortlist as Salekh wants it: who to call, why, and their score.
   Read from the report's own text, which is written in a fixed shape by the
   runner, so today's reports work without being written again. The full
   report stays one click away.

   Each card records what happened on the call. Calls are kept by the
   business's id, so the same business shows the same history on every
   shortlist it appears in. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { C, SANS, SERIF } from "./model";
import { Markdown } from "./Markdown";
import type { CallOutcome, CallRecord, OutcomeInput, ProspectCalls } from "./live";

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

function filterOf(latest: CallRecord | null | undefined): Exclude<Filter, "all"> {
  if (!latest) return "to_call";
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
};

const tone = (s: number | null) => (s === null ? "#8a7a72" : s < 40 ? "#B3261E" : s < 70 ? "#B26A00" : "#1c7046");

export function CallList({ leads, report, roomId, loadCalls, saveOutcome }: { leads: Lead[]; report: string; roomId?: string; loadCalls?: CallsApi["load"]; saveOutcome?: CallsApi["save"] }) {
  const calls = roomId && loadCalls && saveOutcome ? true : false;
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
  const latestOf = (l: Lead) => {
    const id = idOf(l);
    return id ? (byId.get(id)?.latest ?? null) : null;
  };

  const counts = { to_call: 0, follow_ups: 0, done: 0, all: leads.length };
  for (const l of leads) counts[filterOf(latestOf(l))] += 1;
  const shown = filter === "all" ? leads : leads.filter((l) => filterOf(latestOf(l)) === filter);

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
                    onSaved={load}
                    why={!calls ? "Not connected to the runner, so outcomes cannot be saved here." : "Record outcomes from tomorrow's list."}
                  />

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
  onSaved,
  why,
}: {
  prospectId: string | null;
  record: ProspectCalls | undefined;
  save?: CallsApi["save"];
  onSaved: () => Promise<void>;
  why: string;
}) {
  const [picked, setPicked] = useState<CallOutcome | null>(null);
  const [note, setNote] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState(false);
  const enabled = Boolean(prospectId && save);
  const latest = record?.latest ?? null;
  const earlier = record?.history.slice(1) ?? [];

  const submit = async () => {
    if (!prospectId || !save || !picked) return;
    setBusy(true);
    setError("");
    const body: OutcomeInput = { outcome: picked, ...(note.trim() ? { note: note.trim() } : {}), ...(date && WITH_DATE.includes(picked) ? { followUpOn: date } : {}) };
    const failed = await save(prospectId, body);
    setBusy(false);
    if (failed) {
      setError(`Not saved: ${failed}`);
      return;
    }
    setPicked(null);
    setNote("");
    setDate("");
    await onSaved();
  };

  return (
    <div className="mt-3 rounded-xl p-3" style={{ border: `1px solid ${C.blush}` }}>
      {latest && (
        <div className="mb-2" style={{ font: `400 14px/1.45 ${SANS}`, color: C.ink }}>
          <strong style={{ fontWeight: 600 }}>{said(latest)}</strong>
          {latest.note && <p style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>{latest.note}</p>}
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
          <button type="button" onClick={() => void submit()} disabled={busy} style={{ ...pill, background: C.ink, color: C.surface, justifySelf: "start" }}>
            {busy ? "Saving…" : `Save: ${LABEL[picked]}`}
          </button>
          {picked === "not_interested" && (
            <p style={{ font: `400 13px/1.45 ${SANS}`, color: "#7a6a62" }}>Saving this also means they are never sent another test enquiry.</p>
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
