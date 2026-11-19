"use client";

/* What Salekh has told the Chief of Staff, newest first, each with where it is
   now. A setting change waits for his yes here; nothing changes before it.
   A code change says "Waiting for engineering" until a session marks it done. */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { C, SANS, SERIF } from "./model";
import type { Instruction, InstructionStatus } from "./live";

const LABEL: Record<InstructionStatus, { text: string; color: string }> = {
  reading: { text: "Reading it", color: "#7a6a62" },
  proposed: { text: "Understood: say yes to do it", color: "#a4561c" },
  done: { text: "Done", color: "#1c7046" },
  not_done: { text: "Not done", color: "#7a6a62" },
  waiting_engineering: { text: "Waiting for engineering", color: "#3a5a8c" },
  needs_answer: { text: "Needs your answer", color: "#a4561c" },
  answered: { text: "Answered", color: "#7a6a62" },
};

const pill: CSSProperties = { minHeight: 40, padding: "0 16px", borderRadius: 999, font: `600 13px/1 ${SANS}`, cursor: "pointer" };
const time = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });

export function Instructions({
  load,
  decide,
  refreshKey,
  answering,
  onAnswer,
}: {
  load: () => Promise<Instruction[] | null>;
  decide: (id: string, decision: "yes" | "no") => Promise<string | null>;
  /** Changes when he has just sent something, so the list is fetched again. */
  refreshKey: number;
  answering: string | null;
  onAnswer: (id: string | null) => void;
}) {
  const [items, setItems] = useState<Instruction[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  }, [load]);

  const refresh = useCallback(async () => {
    const next = await loader.current();
    if (next) setItems(next);
    return next;
  }, []);

  // Fetched on opening and after each send; again every few seconds while one is still being read.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      const next = await refresh();
      if (!stop && next?.some((i) => i.status === "reading")) timer = setTimeout(loop, 2500);
    };
    void loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [refresh, refreshKey]);

  const answer = async (id: string, decision: "yes" | "no") => {
    setBusy(id);
    setMessage(null);
    const why = await decide(id, decision);
    if (why) setMessage(why === "not_waiting_for_a_yes" ? "That one isn't waiting for a yes any more." : "That didn't go through. Try again.");
    await refresh();
    setBusy(null);
  };

  if (!items) return null;
  if (!items.length)
    return (
      <p style={{ font: `400 14px/1.5 ${SANS}`, color: "#7a6a62" }}>
        Tell me what you want changed, in your own words. For example: &ldquo;stop emailing lawyers&rdquo;, &ldquo;search Hull too&rdquo; or &ldquo;make the profiles shorter&rdquo;.
      </p>
    );

  return (
    <div className="flex flex-col gap-3">
      <div style={{ font: `600 10.5px/1.4 ${SANS}`, letterSpacing: "0.16em", textTransform: "uppercase", color: "#7a6a62" }}>What you&rsquo;ve asked for</div>
      {message && <p style={{ font: `500 13px/1.4 ${SANS}`, color: "#a4561c" }}>{message}</p>}
      {items.map((i) => {
        const label = LABEL[i.status];
        return (
          <div key={i.id} className="min-w-0 rounded-2xl p-3.5" style={{ background: C.cream, border: `1px solid ${answering === i.id ? C.ink : C.blush}` }}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span style={{ font: `600 11px/1.3 ${SANS}`, letterSpacing: "0.08em", textTransform: "uppercase", color: label.color }}>{label.text}</span>
              <span style={{ font: `400 11.5px/1.3 ${SANS}`, color: "#7a6a62" }}>{time(i.at)}</span>
            </div>
            <p className="mt-1.5 break-words" style={{ font: `500 14.5px/1.45 ${SANS}`, color: C.ink }}>&ldquo;{i.said}&rdquo;</p>
            {i.restated && i.status !== "reading" && (
              <p className="mt-1 break-words" style={{ font: `300 17px/1.3 ${SERIF}`, letterSpacing: "-0.01em" }}>{i.restated}</p>
            )}
            {i.change && <p className="mt-1.5 break-words" style={{ font: `500 13.5px/1.45 ${SANS}`, color: C.ink }}>{i.status === "done" ? "Changed: " : "If you say yes: "}{i.change}</p>}
            {i.question && <p className="mt-1.5 break-words" style={{ font: `500 14px/1.45 ${SANS}`, color: "#a4561c" }}>{i.question}</p>}
            {i.note && i.note !== "Done." && <p className="mt-1.5 break-words" style={{ font: `400 13.5px/1.45 ${SANS}`, color: "#4a3a32" }}>{i.note}</p>}
            {i.status === "waiting_engineering" && (
              <p className="mt-1.5" style={{ font: `400 12.5px/1.45 ${SANS}`, color: "#7a6a62" }}>This needs a change to how the system works. It&rsquo;s queued for the next engineering session, and I&rsquo;ll mark it done here when it&rsquo;s live.</p>
            )}
            {i.status === "proposed" && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button type="button" disabled={busy === i.id} onClick={() => answer(i.id, "yes")} style={{ ...pill, background: C.ink, color: C.surface, border: "none", opacity: busy === i.id ? 0.6 : 1 }}>
                  Yes, do it
                </button>
                <button type="button" disabled={busy === i.id} onClick={() => answer(i.id, "no")} style={{ ...pill, background: "transparent", color: C.ink, border: `1.5px solid ${C.blush}` }}>
                  No
                </button>
              </div>
            )}
            {i.status === "needs_answer" && (
              <div className="mt-2.5">
                <button type="button" onClick={() => onAnswer(answering === i.id ? null : i.id)} style={{ ...pill, background: answering === i.id ? C.ink : "transparent", color: answering === i.id ? C.surface : C.ink, border: `1.5px solid ${answering === i.id ? C.ink : C.blush}` }}>
                  {answering === i.id ? "Answering: type below" : "Answer"}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
