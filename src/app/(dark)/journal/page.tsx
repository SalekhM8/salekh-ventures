import Link from "next/link";
import { SectionHeader } from "@/components/sections/SectionHeader";
import { journal } from "@/lib/data";

export const metadata = {
  title: "Journal — Salekh Ventures",
  description:
    "Notes on high ticket dev work in the UK. Pricing, process, stack and case studies from a senior freelance Next.js engineer.",
  keywords: [
    "high ticket developer UK",
    "freelance Next.js developer UK",
    "senior software engineer UK",
    "SaaS developer UK",
    "MVP developer UK",
    "Stripe Clerk Next.js",
  ],
  alternates: { canonical: "https://salekhventures.com/journal" },
};

export default function JournalPage() {
  return (
    <section className="px-6 pb-24 pt-40 md:px-10 md:pb-40 md:pt-48">
      <SectionHeader
        left="© Journal"
        center="(WDX® — Notes)"
        right="All entries"
      />

      <h1 className="mb-20 max-w-3xl font-display text-5xl leading-[1] tracking-tight md:text-7xl">
        Engineering notes,
        <br />
        build logs, half-thoughts.
      </h1>

      <ul className="divide-y divide-white/10 border-y border-white/10">
        {journal.map((j, i) => (
          <li key={i}>
            <Link
              href={`/journal/${j.slug}`}
              className="group flex items-start gap-6 py-8 md:items-center md:gap-10"
              data-hover
            >
              <span className="w-10 shrink-0 text-sm text-muted tabular-nums">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="flex-1">
                <h2 className="font-display text-2xl tracking-tight transition-transform duration-500 group-hover:translate-x-2 md:text-3xl">
                  {j.title}
                </h2>
                <p className="mt-2 max-w-xl text-sm text-muted-2">
                  {j.excerpt}
                </p>
              </div>
              <div className="hidden text-right text-xs uppercase tracking-[0.2em] text-muted md:block">
                <div>{j.date}</div>
                <div className="mt-1">{j.author}</div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
