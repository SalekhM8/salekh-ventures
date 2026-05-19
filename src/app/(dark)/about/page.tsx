import { SectionHeader } from "@/components/sections/SectionHeader";
import { RevealText } from "@/components/ui/RevealText";

export const metadata = {
  title: "About — Salekh Ventures",
  description:
    "Senior engineer with ten years of shipping production software.",
};

export default function AboutPage() {
  return (
    <>
      <section className="px-6 pb-24 pt-40 md:px-10 md:pb-40 md:pt-48">
        <SectionHeader
          left="© About"
          center="(WDX® — Profile)"
          right="Salekh"
        />

        <RevealText
          as="h1"
          className="mb-20 max-w-5xl font-display text-5xl leading-[1] tracking-tight md:text-7xl"
        >
          A senior engineer with thousands of users in production. Ten years of shipping software that runs every day without breaking.
        </RevealText>

        <div className="grid grid-cols-1 gap-12 md:grid-cols-12">
          <div className="space-y-6 md:col-span-7 md:col-start-1">
            <p className="text-base leading-relaxed text-muted-2 md:text-lg">
              Salekh Ventures is a one-engineer studio. The work spans digital
              banking, regulated pharmacy, compliance software, fitness
              platforms and SaaS for small businesses.
            </p>
            <p className="text-base leading-relaxed text-muted-2 md:text-lg">
              Every line of code is written, reviewed and shipped by the same
              person. No agencies, no handoffs, no translation tax between
              design and engineering. Just a small, focused practice that takes
              full responsibility for what it ships.
            </p>
            <p className="text-base leading-relaxed text-muted-2 md:text-lg">
              The default stack is Next.js with TypeScript, Postgres, Clerk and
              Stripe, deployed on Vercel. It exists because it is the fastest
              path from idea to production-ready software in 2026.
            </p>
          </div>

          <div className="md:col-span-4 md:col-start-9">
            <div className="grid grid-cols-2 gap-px bg-white/10">
              <div className="bg-black p-6">
                <p className="font-display text-4xl">10+</p>
                <p className="mt-2 text-xs uppercase tracking-[0.2em] text-muted">
                  Years
                </p>
              </div>
              <div className="bg-black p-6">
                <p className="font-display text-4xl">12</p>
                <p className="mt-2 text-xs uppercase tracking-[0.2em] text-muted">
                  Shipped projects
                </p>
              </div>
              <div className="bg-black p-6">
                <p className="font-display text-4xl">1000s</p>
                <p className="mt-2 text-xs uppercase tracking-[0.2em] text-muted">
                  Users in production
                </p>
              </div>
              <div className="bg-black p-6">
                <p className="font-display text-4xl">1</p>
                <p className="mt-2 text-xs uppercase tracking-[0.2em] text-muted">
                  Senior engineer
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
