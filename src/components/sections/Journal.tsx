"use client";

import Link from "next/link";
import { motion, useInView } from "framer-motion";
import { useRef } from "react";
import { SectionHeader } from "./SectionHeader";
import { journal } from "@/lib/data";
import { RollButton } from "@/components/ui/RollButton";

export function Journal() {
  return (
    <section className="border-t border-black/5 px-6 py-24 md:px-10 md:py-40">
      <SectionHeader
        left="© Journal"
        center="(WDX® — 09)"
        right="Notes"
      />

      <div className="mb-16 flex flex-col items-start justify-between gap-8 md:flex-row md:items-end">
        <h2 className="max-w-3xl font-display text-4xl leading-[1.05] tracking-tight md:text-6xl">
          Engineering notes,
          <br />
          build logs, half-thoughts.
        </h2>
        <RollButton href="/journal" variant="secondary" size="md">
          Read journal
        </RollButton>
      </div>

      <ul className="divide-y divide-black/10 border-y border-black/10">
        {journal.map((j, i) => (
          <JournalRow key={i} item={j} index={i} />
        ))}
      </ul>
    </section>
  );
}

function JournalRow({
  item,
  index,
}: {
  item: (typeof journal)[number];
  index: number;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  return (
    <motion.li
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, delay: index * 0.06, ease: [0.22, 1, 0.36, 1] }}
    >
      <Link
        href={`/journal/${item.slug}`}
        className="group flex items-start gap-6 py-8 md:items-center md:gap-10"
        data-hover
      >
        <span className="w-10 shrink-0 text-sm text-muted tabular-nums">
          {String(index + 1).padStart(2, "0")}
        </span>
        <div className="flex-1">
          <h3 className="font-display text-2xl tracking-tight transition-transform duration-500 group-hover:translate-x-2 md:text-3xl">
            {item.title}
          </h3>
          <p className="mt-2 max-w-xl text-sm text-muted-2">{item.excerpt}</p>
        </div>
        <div className="hidden text-right text-xs uppercase tracking-[0.2em] text-muted md:block">
          <div>{item.date}</div>
          <div className="mt-1">{item.author}</div>
        </div>
        <span className="ml-auto text-xl text-muted opacity-0 transition-opacity group-hover:opacity-100 md:ml-0">
          →
        </span>
      </Link>
    </motion.li>
  );
}
