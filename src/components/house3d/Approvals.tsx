"use client";

/* The list of test enquiries waiting for a yes. What is shown is exactly what
   a yes sends: the runner returns the stored payload and its hash, and the
   hash goes back with each decision. */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { C, SANS, SERIF } from "./model";

export type PendingEnquiry = {
  id: string;
  payloadHash: string;
  expiresAt: string;
  enquiry: { business: string; town: string | null; purpose: string; to: string; subject: string; body: string };
};
export type Decision = { id: string; decision: "approve" | "reject"; payloadHash: string };
export type DecisionResult = { id: string; status: string; reason?: string };

const pill: CSSProperties = { minHeight: 46, padding: "0 20px", borderRadius: 999, font: `600 14px/1 ${SANS}`, cursor: "pointer" };

export function Approvals({
  load,
  decide,
}: {
  load: () => Promise<PendingEnquiry[] | null>;
  decide: (decisions: Decision[]) => Promise<DecisionResult[] | null>;
}) {
  const [items, setItems] = useState<PendingEnquiry[] | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The parent re-renders on every poll, so the loader is kept in a ref and the list is fetched once on opening.
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  }, [load]);

  const refresh = useCallback(async () => {
    const next = await loader.current();
    setItems(next);
    if (next) setTicked((old) => Object.fromEntries(next.map((a) => [a.id, old[a.id] ?? true])));
  }, []);

  useEffect(() => {
    let live = true;
    void loader.current().then((next) => {
      if (!live) return;
      setItems(next);
      if (next) setTicked(Object.fromEntries(next.map((a) => [a.id, true])));
    });
    return () => {
      live = false;
    };
  }, []);

  const send = async (decision: "approve" | "reject", which: PendingEnquiry[]) => {
    if (which.length === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    const results = await decide(which.map((a) => ({ id: a.id, decision, payloadHash: a.payloadHash })));
    if (!results) setMessage("Could not reach the runner. Nothing was changed.");
    else {
      const want = decision === "approve" ? "approved" : "rejected";
      const done = results.filter((r) => r.status === want).length;
      const not = results.length - done;
      setMessage(
        decision === "approve"
          ? `${done} approved. They are sent one at a time, about 90 seconds apart.${not ? ` ${not} could not be approved.` : ""}`
          : `${done} rejected. Nothing is sent to those.${not ? ` ${not} could not be rejected.` : ""}`,
      );
    }
    await refresh();
    setBusy(false);
  };

  if (items === null) return <p style={{ font: `400 14px/1.5 ${SANS}`, color: "#4a3b34" }}>Loading what is waiting…</p>;
  if (items.length === 0)
    return (
      <p role="status" style={{ font: `400 14px/1.5 ${SANS}`, color: "#4a3b34" }}>
        {message ?? "Nothing is waiting for your yes."}
      </p>
    );

  const on = items.filter((a) => ticked[a.id]);
  const off = items.filter((a) => !ticked[a.id]);

  return (
    <div>
      <p style={{ font: `400 13.5px/1.5 ${SANS}`, color: "#4a3b34" }}>
        Each is one email from the test mailbox to one business. A yes sends exactly the words shown, once, and never again to that business. Untick any you do not want.
      </p>
      <ul className="mt-3 grid gap-2.5" style={{ listStyle: "none", padding: 0 }}>
        {items.map((a) => (
          <li key={a.id} className="rounded-xl p-3" style={{ background: C.surface, border: `1.5px solid ${ticked[a.id] ? C.ink : C.blush}`, opacity: ticked[a.id] ? 1 : 0.6 }}>
            <label className="flex items-start gap-3" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!!ticked[a.id]}
                onChange={(e) => setTicked((t) => ({ ...t, [a.id]: e.target.checked }))}
                style={{ width: 22, height: 22, marginTop: 2, accentColor: C.ink, flex: "none" }}
              />
              <span className="min-w-0">
                <span style={{ display: "block", font: `300 19px/1.2 ${SERIF}`, letterSpacing: "-0.02em" }}>
                  {a.enquiry.business}
                  {a.enquiry.town ? `, ${a.enquiry.town}` : ""}
                </span>
                <span style={{ display: "block", marginTop: 3, font: `500 12.5px/1.4 ui-monospace, monospace`, color: "#7a6a62", overflowWrap: "anywhere" }}>
                  To {a.enquiry.to}
                  {a.enquiry.purpose === "rival" ? " · a rival of a business that scored low" : ""}
                </span>
              </span>
            </label>
            <p className="mt-2.5" style={{ font: `600 13.5px/1.4 ${SANS}` }}>{a.enquiry.subject}</p>
            <p className="mt-1" style={{ font: `400 13.5px/1.55 ${SANS}`, color: "#33271f", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {a.enquiry.body}
            </p>
          </li>
        ))}
      </ul>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <button type="button" disabled={busy || on.length === 0} onClick={() => send("approve", on)} style={{ ...pill, background: C.ink, color: C.surface, opacity: busy || on.length === 0 ? 0.45 : 1 }}>
          {busy ? "Working…" : `Send the ${on.length} ticked`}
        </button>
        <button type="button" disabled={busy || off.length === 0} onClick={() => send("reject", off)} style={{ ...pill, background: "transparent", color: C.ink, border: `1.5px solid ${C.ink}`, opacity: busy || off.length === 0 ? 0.45 : 1 }}>
          {`Reject the ${off.length} unticked`}
        </button>
      </div>
      {message && (
        <p role="status" className="mt-2.5" style={{ font: `500 13px/1.4 ${SANS}`, color: "#4a3b34" }}>
          {message}
        </p>
      )}
    </div>
  );
}
