import Link from "next/link";
import { SectionHeader } from "@/components/sections/SectionHeader";
import { allWorks } from "@/lib/data";

export const metadata = {
  title: "Work",
  description:
    "Recent production builds by a senior freelance Next.js engineer in the UK. SaaS, fintech, regulated pharmacy, AI platforms and marketplaces.",
  keywords: [
    "Next.js portfolio UK",
    "freelance developer portfolio",
    "SaaS case studies UK",
    "high ticket developer UK",
    "production software UK",
  ],
  alternates: { canonical: "https://salekhventures.com/work" },
  openGraph: {
    title: "Work — Salekh Ventures",
    description:
      "Recent production builds. SaaS, fintech, regulated pharmacy, AI platforms.",
    url: "https://salekhventures.com/work",
    type: "website",
  },
};

export default function WorkPage() {
  return (
    <section className="px-6 pb-24 pt-40 md:px-10 md:pb-40 md:pt-48">
      <SectionHeader
        left="© Work"
        center="(WDX® — Recent)"
        right="Recent projects"
      />

      <h1 className="mb-20 max-w-3xl font-display text-5xl leading-[1] tracking-tight md:text-7xl">
        Fifty plus projects shipped. A few recent ones below.
      </h1>

      <ul className="divide-y divide-black/10 border-y border-black/10">
        {allWorks.map((w) => (
          <li key={w.n}>
            <Link
              href={w.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group grid grid-cols-12 items-center gap-4 py-8 transition-colors"
              data-hover
            >
              <span className="col-span-2 text-sm text-muted tabular-nums md:col-span-1">
                {w.n}
              </span>
              <span className="col-span-7 font-display text-2xl tracking-tight transition-transform duration-500 group-hover:translate-x-2 md:text-4xl">
                {w.title}
              </span>
              <span className="col-span-3 text-right text-sm text-muted md:col-span-3 md:text-left">
                {w.role}
              </span>
              <span className="hidden text-right text-sm text-muted md:col-span-1 md:block">
                {w.year}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
