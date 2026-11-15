"use client";

import { useState } from "react";
import { CATALOGUE } from "@/lib/agents";
import { togglePick, usePicks } from "./picks";
import { openTeamBuilder } from "./TeamBuilder";

/** Every agent job, grouped by department. Tap to pick; picks carry into the form. */
export function AgentCatalogue() {
  const picks = usePicks();
  const [open, setOpen] = useState<string>(CATALOGUE[0]?.id ?? "");

  return (
    <div>
      <ul className="border-y border-black/10">
        {CATALOGUE.map((d, i) => {
          const isOpen = open === d.id;
          const picked = d.agents.filter((a) => picks.includes(a.name)).length;
          return (
            <li key={d.id} className="border-b border-black/10 last:border-b-0">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? "" : d.id)}
                aria-expanded={isOpen}
                data-hover
                className="grid w-full grid-cols-[1fr_auto] items-center gap-4 py-5 text-left md:grid-cols-[80px_1fr_1.4fr_auto] md:gap-8 md:py-6"
              >
                <span className="hidden text-xs uppercase tracking-[0.2em] text-muted md:block">{String(i + 1).padStart(2, "0")}</span>
                <span>
                  <span className="block font-display text-2xl font-semibold tracking-tight">{d.name}</span>
                  <span className="mt-1 block text-sm text-muted-2 md:hidden">{d.line}</span>
                </span>
                <span className="hidden text-base text-muted-2 md:block">{d.line}</span>
                <span className="flex items-center gap-3 text-sm text-muted">
                  {picked > 0 && <span className="rounded-full bg-black px-2.5 py-1 text-xs font-semibold text-white">{picked}</span>}
                  <span className="whitespace-nowrap">{d.agents.length} agents</span>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className={`transition-transform ${isOpen ? "rotate-180" : ""}`}>
                    <path d="M2 5 L7 10 L12 5" />
                  </svg>
                </span>
              </button>
              {isOpen && (
                <div className="grid gap-2 pb-6 md:grid-cols-2 md:pl-[112px]">
                  {d.agents.map((a) => {
                    const on = picks.includes(a.name);
                    return (
                      <button
                        key={a.name}
                        type="button"
                        onClick={() => togglePick(a.name)}
                        aria-pressed={on}
                        className={`flex min-h-16 items-center justify-between gap-4 rounded-2xl border px-4 py-3 text-left transition-colors ${
                          on ? "border-black bg-black text-white" : "border-black/15 bg-white text-black hover:border-black"
                        }`}
                      >
                        <span>
                          <span className="block text-base font-medium">{a.name}</span>
                          <span className={`block text-sm leading-snug ${on ? "text-white/70" : "text-black/55"}`}>{a.job}</span>
                        </span>
                        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-base leading-none ${on ? "border-white bg-white text-black" : "border-black/30"}`} aria-hidden="true">
                          {on ? "✓" : "+"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-8 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => openTeamBuilder()}
          data-hover
          className="inline-flex min-h-14 cursor-pointer items-center justify-center rounded-full border border-black bg-black px-8 text-base uppercase tracking-wide text-white transition-colors hover:bg-black/85"
        >
          {picks.length > 0 ? `Build my team of ${picks.length}` : "Build your team"}
        </button>
        <span className="text-sm text-muted">{picks.length > 0 ? "Your picks come with you. Takes about a minute." : "Tap the agents you want, or skip straight to the questions."}</span>
      </div>
    </div>
  );
}
