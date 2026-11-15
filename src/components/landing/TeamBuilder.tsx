"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { submitTeamLead } from "@/app/actions/teamLead";

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
    posthog?: { capture?: (name: string, props?: Record<string, unknown>) => void };
  }
}

/* "Build your team": one question at a time. Later questions depend on
   earlier answers. Opened from anywhere with openTeamBuilder(). */

const OPEN_EVENT = "sv:team-builder";

export function openTeamBuilder(niche?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { niche } }));
}

export const NICHES = [
  "Online shop",
  "Clinic, pharmacy or health",
  "Agency or services",
  "Software or app",
  "Local or trade business",
  "Something else",
] as const;

const DEPARTMENTS = [
  { id: "Customer Relations", line: "Replies to customers" },
  { id: "Outreach", line: "Finds and contacts new customers" },
  { id: "Content", line: "Scripts, captions, edited video" },
  { id: "Ads", line: "Runs and manages paid ads" },
  { id: "Data", line: "Daily numbers and what changed" },
  { id: "Engineering", line: "Fixes and improves your site or app" },
  { id: "Research", line: "Market and competitor research" },
];

/* A sensible starting team per kind of business. The person can change it. */
const SUGGESTED: Record<string, string[]> = {
  "Online shop": ["Customer Relations", "Content", "Ads"],
  "Clinic, pharmacy or health": ["Customer Relations", "Content", "Data"],
  "Agency or services": ["Outreach", "Content", "Customer Relations"],
  "Software or app": ["Customer Relations", "Engineering", "Content"],
  "Local or trade business": ["Customer Relations", "Outreach", "Content"],
  "Something else": [],
};

/* One follow-up, chosen by what they picked. First match wins. */
const FOLLOW_UPS: { dept: string; question: string; options: string[] }[] = [
  { dept: "Customer Relations", question: "Roughly how many customer messages do you get a day?", options: ["Under 10", "10 to 50", "50 to 200", "Over 200"] },
  { dept: "Ads", question: "Do you run paid ads today?", options: ["Yes, myself", "Yes, through an agency", "Not yet"] },
  { dept: "Outreach", question: "How do you find new customers now?", options: ["Referrals", "Cold outreach", "Ads", "Not consistently"] },
  { dept: "Content", question: "How often do you post now?", options: ["Most days", "A few times a month", "Rarely"] },
  { dept: "Engineering", question: "Who looks after your site or app today?", options: ["I do", "A developer or agency", "Nobody really"] },
];

type StepId = "niche" | "departments" | "followUp" | "teamSize" | "timing" | "who" | "contact" | "done";

const track = (event: string, props?: Record<string, unknown>) => {
  try {
    window.posthog?.capture?.(event, props);
  } catch {}
};

function Choice({ label, sub, selected, onClick }: { label: string; sub?: string; selected?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl border px-5 py-3 text-left transition-colors ${
        selected ? "border-black bg-black text-white" : "border-black/15 bg-white text-black hover:border-black"
      }`}
    >
      <span>
        <span className="block text-base font-medium">{label}</span>
        {sub && <span className={`block text-sm ${selected ? "text-white/70" : "text-black/55"}`}>{sub}</span>}
      </span>
      <span className={`h-5 w-5 shrink-0 rounded-full border ${selected ? "border-white bg-white" : "border-black/30"}`} />
    </button>
  );
}

export function TeamBuilder() {
  const reduced = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<StepId>("niche");
  const [niche, setNiche] = useState("");
  const [departments, setDepartments] = useState<string[]>([]);
  const [followAnswer, setFollowAnswer] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [timing, setTiming] = useState("");
  const [name, setName] = useState("");
  const [business, setBusiness] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const eventId = useRef("");
  const attribution = useRef("");
  const started = useRef(false);

  const followUp = useMemo(() => FOLLOW_UPS.find((f) => departments.includes(f.dept)), [departments]);
  const steps = useMemo<StepId[]>(
    () => ["niche", "departments", ...(followUp ? (["followUp"] as StepId[]) : []), "teamSize", "timing", "who", "contact"],
    [followUp],
  );
  const index = steps.indexOf(step);

  useEffect(() => {
    try {
      const search = window.location.search.slice(1);
      if (/(?:^|&)(utm_|fbclid)/.test(search)) localStorage.setItem("sv_attribution", search);
      attribution.current = localStorage.getItem("sv_attribution") || search;
    } catch {}
    const onOpen = (e: Event) => {
      const preset = (e as CustomEvent<{ niche?: string }>).detail?.niche;
      setOpen(true);
      if (preset && (NICHES as readonly string[]).includes(preset)) {
        setNiche(preset);
        setDepartments(SUGGESTED[preset] ?? []);
        setStep("departments");
      }
      if (!started.current) {
        started.current = true;
        track("team_form_start", { preset: preset ?? null });
        window.fbq?.("trackCustom", "StartForm");
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    const prevOverlay = document.documentElement.dataset.overlay;
    document.body.style.overflow = "hidden";
    document.documentElement.dataset.overlay = "form";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      if (prevOverlay) document.documentElement.dataset.overlay = prevOverlay;
      else delete document.documentElement.dataset.overlay;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (next: StepId) => {
    setError("");
    setStep(next);
    track("team_form_step", { step: next });
  };
  const next = () => {
    const n = steps[index + 1];
    if (n) go(n);
  };
  const back = () => {
    const p = steps[index - 1];
    if (p) go(p);
  };
  const pickThenNext = (set: (v: string) => void, value: string, after: StepId) => {
    set(value);
    setTimeout(() => go(after), reduced ? 0 : 160);
  };

  const submit = async () => {
    if (!name.trim()) return setError("Please add your name.");
    if (phone.replace(/\D/g, "").length < 9) return setError("Please enter a phone number we can reach you on.");
    setError("");
    setSending(true);
    if (!eventId.current) eventId.current = crypto.randomUUID();
    const res = await submitTeamLead({
      niche,
      departments,
      followUp: followUp && followAnswer ? { question: followUp.question, answer: followAnswer } : undefined,
      teamSize,
      timing,
      name,
      business,
      phone,
      email,
      attribution: attribution.current,
      eventId: eventId.current,
    });
    setSending(false);
    if (!res.ok) return setError(res.error);
    window.fbq?.("track", "Lead", {}, { eventID: res.eventId });
    track("team_form_submit", { niche, departments: departments.length });
    setStep("done");
  };

  const toggleDept = (id: string) => setDepartments((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  const input = "min-h-14 w-full rounded-2xl border border-black/20 bg-white px-5 text-base text-black outline-none focus:border-black";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-lenis-prevent
          className="fixed inset-0 z-[90] flex items-end justify-center bg-black/55 md:items-center md:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={() => setOpen(false)}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Build your team"
            initial={reduced ? false : { y: 28 }}
            animate={{ y: 0 }}
            exit={reduced ? undefined : { y: 28 }}
            transition={{ duration: 0.22, ease: [0.2, 0.7, 0.1, 1] }}
            className="flex h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-white text-black md:h-auto md:max-h-[88vh] md:max-w-xl md:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 px-5 pt-5 md:px-7">
              <div className="text-xs uppercase tracking-[0.2em] text-black/55">
                {step === "done" ? "Sent" : `Build your team · ${index + 1} of ${steps.length}`}
              </div>
              <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-full border border-black/15 px-4 text-sm hover:border-black">
                Close
              </button>
            </div>
            {step !== "done" && (
              <div className="mx-5 mt-3 h-1 overflow-hidden rounded-full bg-black/10 md:mx-7" aria-hidden="true">
                <motion.div className="h-full bg-black" initial={false} animate={{ width: `${((index + 1) / steps.length) * 100}%` }} transition={{ duration: 0.25 }} />
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-5 pb-5 pt-6 md:px-7">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={step}
                  initial={reduced ? false : { opacity: 0, x: 14 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduced ? undefined : { opacity: 0, x: -14 }}
                  transition={{ duration: 0.16 }}
                >
                  {step === "niche" && (
                    <>
                      <h2 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">What kind of business do you run?</h2>
                      <div className="mt-6 flex flex-col gap-2.5">
                        {NICHES.map((n) => (
                          <Choice
                            key={n}
                            label={n}
                            selected={niche === n}
                            onClick={() => {
                              setNiche(n);
                              if (departments.length === 0) setDepartments(SUGGESTED[n] ?? []);
                              setTimeout(() => go("departments"), reduced ? 0 : 160);
                            }}
                          />
                        ))}
                      </div>
                    </>
                  )}

                  {step === "departments" && (
                    <>
                      <h2 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">Which departments would you hand over?</h2>
                      <p className="mt-2 text-base text-black/60">
                        {(SUGGESTED[niche] ?? []).length > 0 ? "I've ticked a common starting team for your kind of business. Change it to suit." : "Pick as many as you like."}
                      </p>
                      <div className="mt-6 flex flex-col gap-2.5">
                        {DEPARTMENTS.map((d) => (
                          <Choice key={d.id} label={d.id} sub={d.line} selected={departments.includes(d.id)} onClick={() => toggleDept(d.id)} />
                        ))}
                      </div>
                    </>
                  )}

                  {step === "followUp" && followUp && (
                    <>
                      <h2 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">{followUp.question}</h2>
                      <div className="mt-6 flex flex-col gap-2.5">
                        {followUp.options.map((o) => (
                          <Choice key={o} label={o} selected={followAnswer === o} onClick={() => pickThenNext(setFollowAnswer, o, "teamSize")} />
                        ))}
                      </div>
                    </>
                  )}

                  {step === "teamSize" && (
                    <>
                      <h2 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">How many people work in the business today?</h2>
                      <div className="mt-6 flex flex-col gap-2.5">
                        {["Just me", "2 to 5", "6 to 20", "More than 20"].map((o) => (
                          <Choice key={o} label={o} selected={teamSize === o} onClick={() => pickThenNext(setTeamSize, o, "timing")} />
                        ))}
                      </div>
                    </>
                  )}

                  {step === "timing" && (
                    <>
                      <h2 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">When would you want this running?</h2>
                      <div className="mt-6 flex flex-col gap-2.5">
                        {["As soon as possible", "In the next month or two", "Just exploring for now"].map((o) => (
                          <Choice key={o} label={o} selected={timing === o} onClick={() => pickThenNext(setTiming, o, "who")} />
                        ))}
                      </div>
                    </>
                  )}

                  {step === "who" && (
                    <>
                      <h2 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">Who am I speaking to?</h2>
                      <div className="mt-6 flex flex-col gap-3">
                        <label className="text-sm font-medium" htmlFor="tb-name">
                          Your name
                        </label>
                        <input id="tb-name" className={input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus enterKeyHint="next" />
                        <label className="mt-2 text-sm font-medium" htmlFor="tb-business">
                          Business name
                        </label>
                        <input
                          id="tb-business"
                          className={input}
                          value={business}
                          onChange={(e) => setBusiness(e.target.value)}
                          autoComplete="organization"
                          enterKeyHint="next"
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && name.trim()) next();
                          }}
                        />
                      </div>
                    </>
                  )}

                  {step === "contact" && (
                    <>
                      <h2 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">Where can I reach you{name.trim() ? `, ${name.trim().split(" ")[0]}` : ""}?</h2>
                      <p className="mt-2 text-base text-black/60">I&apos;ll message you on WhatsApp from my own number. No call centre, no list.</p>
                      <div className="mt-6 flex flex-col gap-3">
                        <label className="text-sm font-medium" htmlFor="tb-phone">
                          Mobile number
                        </label>
                        <input
                          id="tb-phone"
                          className={input}
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel"
                          autoFocus
                          enterKeyHint="send"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void submit();
                          }}
                        />
                        <label className="mt-2 text-sm font-medium" htmlFor="tb-email">
                          Email <span className="font-normal text-black/50">(optional)</span>
                        </label>
                        <input id="tb-email" className={input} value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" autoComplete="email" />
                      </div>
                    </>
                  )}

                  {step === "done" && (
                    <div className="py-6">
                      <h2 className="font-display text-4xl font-semibold tracking-tight md:text-5xl">Got it{name.trim() ? `, ${name.trim().split(" ")[0]}` : ""}.</h2>
                      <p className="mt-4 text-lg leading-relaxed text-black/70">
                        I&apos;ve got your answers. I&apos;ll message you on WhatsApp from my own number, so if a UK mobile you don&apos;t recognise gets in touch, that&apos;s me.
                      </p>
                      <p className="mt-3 text-base text-black/60">Your team: {departments.join(", ")}.</p>
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
              {error && (
                <p role="alert" className="mt-4 text-sm font-medium text-red-700">
                  {error}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 border-t border-black/10 px-5 py-4 md:px-7">
              {step === "done" ? (
                <button type="button" onClick={() => setOpen(false)} className="min-h-14 w-full rounded-full bg-black px-6 text-base font-semibold text-white">
                  Back to the house
                </button>
              ) : (
                <>
                  {index > 0 && (
                    <button type="button" onClick={back} className="min-h-14 rounded-full border border-black/20 px-5 text-base hover:border-black">
                      Back
                    </button>
                  )}
                  {step === "departments" && (
                    <button type="button" onClick={next} disabled={departments.length === 0} className="min-h-14 flex-1 rounded-full bg-black px-6 text-base font-semibold text-white disabled:opacity-40">
                      Continue{departments.length ? ` with ${departments.length}` : ""}
                    </button>
                  )}
                  {step === "who" && (
                    <button type="button" onClick={() => (name.trim() ? next() : setError("Please add your name."))} className="min-h-14 flex-1 rounded-full bg-black px-6 text-base font-semibold text-white">
                      Continue
                    </button>
                  )}
                  {step === "contact" && (
                    <button type="button" onClick={() => void submit()} disabled={sending} className="min-h-14 flex-1 rounded-full bg-black px-6 text-base font-semibold text-white disabled:opacity-60">
                      {sending ? "Sending…" : "Send it to Salekh"}
                    </button>
                  )}
                  {(step === "niche" || step === "followUp" || step === "teamSize" || step === "timing") && <span className="ml-auto text-sm text-black/50">Tap an answer to continue</span>}
                </>
              )}
            </div>
            {step === "contact" && <p className="px-5 pb-4 text-xs text-black/50 md:px-7">Used only to contact you about this. Never shared or sold.</p>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A button that opens the form. `variant` matches the site's two button styles. */
export function TeamButton({ children = "Build your team", size = "md", variant = "primary", className = "" }: { children?: string; size?: "md" | "lg"; variant?: "primary" | "secondary"; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openTeamBuilder()}
      data-hover
      className={`inline-flex cursor-pointer items-center justify-center rounded-full border uppercase tracking-wide transition-colors duration-200 ${
        variant === "primary" ? "border-black bg-black text-white hover:bg-black/85" : "border-black/20 bg-transparent text-black hover:border-black"
      } ${size === "lg" ? "min-h-14 px-8 text-base" : "min-h-12 px-6 text-sm"} ${className}`}
    >
      {children}
    </button>
  );
}

/** Chips that open the form with the kind of business already chosen. */
export function NicheChips() {
  return (
    <div className="flex flex-wrap gap-2">
      {NICHES.map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => openTeamBuilder(n)}
          data-hover
          className="min-h-12 rounded-full border border-black/20 px-5 text-sm transition-colors hover:border-black hover:bg-black hover:text-white"
        >
          {n}
        </button>
      ))}
    </div>
  );
}

/** Phone only: a bar that stays at the bottom of the screen. */
export function StickyTeamBar() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-black/10 bg-white/95 p-3 backdrop-blur md:hidden" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
      <button type="button" onClick={() => openTeamBuilder()} className="min-h-13 w-full rounded-full bg-black py-4 text-base font-semibold text-white">
        Build your team
      </button>
    </div>
  );
}
