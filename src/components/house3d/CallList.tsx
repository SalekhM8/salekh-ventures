"use client";

/* The Outreach shortlist as Salekh wants it: who to call, why, and their score.
   Read from the report's own text, which is written in a fixed shape by the
   runner, so today's reports work without being written again. The full
   report stays one click away. */

import { useState } from "react";
import { C, SANS, SERIF } from "./model";
import { Markdown } from "./Markdown";

export type Lead = {
  rank: number;
  name: string;
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
      return {
        rank: Number(h[1]),
        name: h[2].replace(/[\s -⯿️]+$/u, "").trim(),
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
        section: section.replace(/^## \d+\. /, "## "),
      };
    })
    .sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
}

const tone = (s: number | null) => (s === null ? "#8a7a72" : s < 40 ? "#B3261E" : s < 70 ? "#B26A00" : "#1c7046");

export function CallList({ leads, report }: { leads: Lead[]; report: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const [full, setFull] = useState(false);

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
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p style={{ font: `400 15px/1.5 ${SANS}`, color: "#4a3b34" }}>
          <strong style={{ color: C.ink }}>{leads.length} businesses tested</strong>, worst first. {toCall} scored under 70. The lower the score, the more
          enquiries they lose.
        </p>
        <button type="button" onClick={() => setFull(true)} style={pill}>
          View full report
        </button>
      </div>

      <ol className="mt-4 grid min-w-0 gap-3" style={{ listStyle: "none", padding: 0, gridTemplateColumns: "minmax(0, 1fr)" }}>
        {leads.map((l, i) => (
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
                <p style={{ marginTop: 2, font: `500 12.5px/1.4 ${SANS}`, color: "#7a6a62" }}>
                  {[l.kind, l.town].filter(Boolean).join(" · ")}
                </p>

                <dl className="mt-3 grid gap-1.5" style={{ font: `400 14px/1.45 ${SANS}`, color: "#33271f" }}>
                  <Row label="What happened">{l.happened || "Not tested yet."}</Row>
                  {l.rival && <Row label="Their rival">{l.rival}</Row>}
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

                <button type="button" onClick={() => setOpen(open === i ? null : i)} className="mt-3" style={pill}>
                  {open === i ? "Hide full profile" : "Full profile"}
                </button>
                {open === i && (
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
        ))}
      </ol>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-3 sm:grid-cols-[110px_1fr]">
      <dt style={{ font: `600 12px/1.45 ${SANS}`, color: "#7a6a62" }}>{label}</dt>
      <dd style={{ margin: 0 }}>{children}</dd>
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
