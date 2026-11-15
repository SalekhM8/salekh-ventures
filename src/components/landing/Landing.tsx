import Link from "next/link";
import { fraunces } from "@/lib/fonts";
import { HouseDemo } from "./HouseDemo";
import { NicheChips, StickyTeamBar, TeamBuilder, TeamButton } from "./TeamBuilder";

const departments = [
  { name: "Customer Relations", line: "Replies on WhatsApp, email, DMs and reviews, in your voice, from your own knowledge. Hands anything sensitive to a person." },
  { name: "Outreach", line: "Finds the right people, writes to them properly and follows up. You take the calls and close." },
  { name: "Content", line: "Scripts, captions and edited video. It tells you what to film and handles the rest." },
  { name: "Ads", line: "Runs campaigns against your targets, inside the limits you set. Pauses what is losing and tells you why." },
  { name: "Data", line: "Reads the numbers every day, works out what changed, and tells the other departments." },
  { name: "Engineering", line: "Fixes bugs and ships small improvements to your code as changes a person reviews and merges." },
  { name: "Research", line: "Reads your market and your competitors and writes it up, with sources." },
];

const steps = [
  { n: "01", title: "You set the targets", line: "The numbers each department chases, what it may spend, and what it may do without asking. Only you can change them." },
  { n: "02", title: "Every agent earns its freedom", line: "Each kind of action starts as a suggestion. It only acts alone after a logged record of getting it right. One mistake puts it back a step." },
  { n: "03", title: "You approve the big calls", line: "Anything major waits for your yes on your phone. You score the work, and each score teaches that department. One button stops everything." },
];

export function Landing() {
  return (
    <>
      {/* hero: the offer, then the house itself */}
      <section className="px-4 pb-10 pt-24 md:px-10 md:pt-28">
        <div className="grid items-end gap-6 md:grid-cols-[1.5fr_1fr] md:gap-12">
          <h1 className="font-display text-[11.5vw] font-semibold leading-[0.92] tracking-[-0.03em] md:text-[5.6vw]">
            AI departments that run your business. You stay president.
          </h1>
          <div className="flex flex-col items-start gap-5 md:pb-2">
            <p className="max-w-md text-base leading-relaxed text-muted-2">
              I build and train a team of AI agents for your business: one for each department. They do the day to day.
              You set the targets, approve the big calls and score the work.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <TeamButton>Build your team</TeamButton>
              <a href="#house" className="inline-flex min-h-12 items-center text-sm underline underline-offset-4" data-hover>
                Try the house below
              </a>
            </div>
          </div>
        </div>

        <div id="house" className={`${fraunces.variable} mt-8 scroll-mt-24 md:mt-10`}>
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 text-xs uppercase tracking-[0.2em] text-muted">
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              The White House · a simulation you can use
            </span>
            <span className="hidden md:inline">Click a floor, a window or the garden door</span>
          </div>
          <div className="h-[62vh] min-h-[400px] overflow-hidden rounded-3xl border border-black/10 md:h-[78vh] md:min-h-[560px]">
            <HouseDemo />
          </div>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">
            This is a working model of the system, running a simulation with made up businesses. Nothing in it is a real
            client or real data. Walk into a room to see what an agent is doing and what it has made, approve or reject
            what it asks for, and go to the Oval Office to question the Chief of Staff.
          </p>
        </div>

        <div className="mt-12 border-t border-black/10 pt-8">
          <h2 className="font-display text-2xl font-semibold tracking-tight md:text-3xl">What do you run? I&apos;ll show you a starting team.</h2>
          <div className="mt-5">
            <NicheChips />
          </div>
        </div>
      </section>

      {/* how to read it */}
      <section className="border-t border-black/10 px-6 py-20 md:px-10 md:py-28">
        <div className="text-xs uppercase tracking-[0.2em] text-muted">(01) What you are looking at</div>
        <div className="mt-8 grid gap-10 md:grid-cols-3">
          {[
            { t: "A floor is a business", d: "Run one business or several. Each gets its own floor, its own facts, voice and targets, and nothing crosses between them." },
            { t: "A room is a department", d: "One agent per department. It wakes when there is work, does one job, writes it up and stops. Everything it does is logged." },
            { t: "The Chief of Staff runs the house", d: "It decides who to wake and with what brief, passes work between rooms, and brings you a short daily summary. Ask it anything." },
          ].map((x) => (
            <div key={x.t}>
              <h2 className="font-display text-2xl font-semibold tracking-tight md:text-3xl">{x.t}</h2>
              <p className="mt-3 max-w-sm text-base leading-relaxed text-muted-2">{x.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* departments */}
      <section className="border-t border-black/10 px-6 py-20 md:px-10 md:py-28">
        <div className="text-xs uppercase tracking-[0.2em] text-muted">(02) Departments</div>
        <h2 className="mt-6 max-w-4xl font-display text-4xl font-semibold leading-[1.02] tracking-[-0.02em] md:text-6xl">
          Pick the departments you want run.
        </h2>
        <ul className="mt-12 divide-y divide-black/10 border-y border-black/10">
          {departments.map((d, i) => (
            <li key={d.name} className="grid gap-2 py-6 md:grid-cols-[80px_1fr_1.6fr] md:items-baseline md:gap-8">
              <span className="text-xs uppercase tracking-[0.2em] text-muted">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="font-display text-2xl font-semibold tracking-tight">{d.name}</h3>
              <p className="max-w-xl text-base leading-relaxed text-muted-2">{d.line}</p>
            </li>
          ))}
        </ul>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <TeamButton size="lg">Pick your departments</TeamButton>
          <span className="text-sm text-muted">Takes about a minute. One question at a time.</span>
        </div>
      </section>

      {/* control */}
      <section className="border-t border-black/10 px-6 py-20 md:px-10 md:py-28">
        <div className="text-xs uppercase tracking-[0.2em] text-muted">(03) Who is in charge</div>
        <h2 className="mt-6 max-w-4xl font-display text-4xl font-semibold leading-[1.02] tracking-[-0.02em] md:text-6xl">
          They do the work. You keep the authority.
        </h2>
        <ol className="mt-12 grid gap-10 md:grid-cols-3">
          {steps.map((s) => (
            <li key={s.n} className="border-t border-black pt-5">
              <span className="text-xs uppercase tracking-[0.2em] text-muted">{s.n}</span>
              <h3 className="mt-3 font-display text-2xl font-semibold tracking-tight">{s.title}</h3>
              <p className="mt-3 text-base leading-relaxed text-muted-2">{s.line}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* close */}
      <section className="border-t border-black/10 px-6 pb-36 pt-24 md:px-10 md:py-36">
        <div className="text-xs uppercase tracking-[0.2em] text-muted">(04) Start here</div>
        <h2 className="mt-6 max-w-5xl font-display text-5xl font-semibold leading-[0.98] tracking-[-0.03em] md:text-8xl">
          See what your team would look like.
        </h2>
        <p className="mt-8 max-w-2xl text-lg leading-relaxed text-muted-2">
          Answer a few questions about your business. I will come back to you personally with the departments I would set
          up first and what they would take off your plate.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-5">
          <TeamButton size="lg">Build your team</TeamButton>
          <Link href="/work" className="inline-flex min-h-12 items-center text-sm underline underline-offset-4" data-hover>
            Looking for development work instead? See past builds
          </Link>
        </div>
      </section>

      <StickyTeamBar />
      <TeamBuilder />
    </>
  );
}
